import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError, type Ctx } from '../auth.js';
import { nextNumber, paged, withScope, type Tx } from '../db.js';
import { queueNotice } from '../notify.js';
import { applySla, assertCatalog, OPEN_WO_SQL } from '../sla.js';
import { zPage, zUuid } from '../validators.js';

/** Expansão 3: ordens de serviço, estoque (razão de movimentos) e inventário FTTH (caixas e portas). */
const WO_SELECT = `
  select w.*, s.name as subscriber_name, s.phone as subscriber_phone,
         concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city) as subscriber_address,
         a.name as assignee_name, cb.name as created_by_name,
         coalesce(w.address_text, concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city)) as service_address,
         r.name as reason_name, (w.sla_due_at is not null and w.sla_breached_at is not null) as sla_breached
  from work_orders w left join catalog_items r on r.id = w.reason_id join subscribers s on s.id = w.subscriber_id left join users a on a.id = w.assignee_id left join users cb on cb.id = w.created_by`;
const FINAL = ['done', 'canceled'];
// de -> para
// Fluxo da OS (inspirado no do IXC): análise, aguardando agendamento, agendada, deslocamento, execução, finalizada.
const TRANSITIONS: Record<string, string[]> = {
  open: ['analysis', 'awaiting_schedule', 'scheduled', 'en_route', 'in_progress', 'canceled'],
  analysis: ['open', 'awaiting_schedule', 'scheduled', 'en_route', 'in_progress', 'canceled'],
  awaiting_schedule: ['open', 'scheduled', 'canceled'],
  scheduled: ['open', 'awaiting_schedule', 'en_route', 'in_progress', 'canceled'],
  en_route: ['open', 'scheduled', 'in_progress', 'canceled'],
  in_progress: ['open', 'awaiting_schedule', 'done', 'canceled'],
  done: [], canceled: [],
};
const WO_STATUS = ['open', 'analysis', 'awaiting_schedule', 'scheduled', 'en_route', 'in_progress', 'done', 'canceled'] as const;
const zWhen = z.string().datetime({ offset: true });
const zText = (max: number) => z.string().trim().min(1).max(max);

const ITEM_SELECT = `
  select i.*, coalesce((select sum(m.qty) from stock_movements m where m.item_id = i.id), 0)::int as balance
  from stock_items i`;
const BOX_SELECT = `
  select b.*, d.name as device_name, p.name as parent_name,
         (select count(*) from ftth_drops x where x.box_id = b.id) as used,
         (select count(*) from ftth_boxes x where x.parent_id = b.id) as children
  from ftth_boxes b left join devices d on d.id = b.device_id left join ftth_boxes p on p.id = b.parent_id`;
const DROP_SELECT = `
  select x.id, x.box_id, x.port, x.contract_id, x.note, x.created_at, b.name as box_name, b.kind as box_kind, b.pon_port, b.device_id, d.name as device_name,
         s.id as subscriber_id, s.name as subscriber_name
  from ftth_drops x join ftth_boxes b on b.id = x.box_id left join devices d on d.id = b.device_id
  left join contracts k on k.id = x.contract_id left join subscribers s on s.id = k.subscriber_id`;

async function woEvent(c: Tx, ctx: Ctx, id: string, event: string, detail: object = {}) {
  await c.query(`insert into work_order_events (tenant_id, work_order_id, actor_id, event, detail) values ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, id, ctx.userId, event, JSON.stringify(detail)]);
}
/** Usuário interno do mesmo provedor (a FK sozinha não garante o provedor). */
async function staff(c: Tx, id: string) {
  const u = (await c.query(`select id, name from users where id = $1 and active and role <> 'subscriber'`, [id])).rows[0];
  if (!u) throw new HttpError(400, 'responsável não encontrado neste provedor');
  return u;
}
/** Lança um movimento garantindo que o saldo não fique negativo (trava a linha do item). */
export async function stockMove(c: Tx, ctx: Ctx, itemId: string, qty: number, kind: 'in' | 'out' | 'adjust', note: string | null, workOrderId: string | null = null, byUnit = false) {
  const item = (await c.query('select id, name, active, serialized from stock_items where id = $1 for update', [itemId])).rows[0];
  if (!item) throw new HttpError(404, 'item de estoque não encontrado');
  // item com número de série só se movimenta unidade a unidade, para o saldo bater com as unidades rastreadas
  if (item.serialized !== byUnit) throw new HttpError(400, item.serialized ? `“${item.name}” é controlado por número de série: movimente pelas unidades` : `“${item.name}” não é controlado por número de série`);
  if (!item.active && qty > 0) throw new HttpError(400, 'item inativo não recebe entradas');
  const balance = (await c.query('select coalesce(sum(qty),0)::int as b from stock_movements where item_id = $1', [itemId])).rows[0].b;
  if (balance + qty < 0) throw new HttpError(409, `saldo insuficiente de “${item.name}”: há ${balance}`);
  const m = (await c.query(
    `insert into stock_movements (tenant_id, item_id, qty, kind, work_order_id, note, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, itemId, qty, kind, workOrderId, note, ctx.userId])).rows[0];
  return { id: m.id, item_name: item.name as string, balance: balance + qty };
}

export async function fieldRoutes(app: FastifyInstance) {
  // ---- Ordens de serviço ----
  app.get('/api/staff', { preHandler: guard('os:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`select id, name, role from users where active and role <> 'subscriber' order by name`)).rows));

  app.get('/api/work-orders', { preHandler: guard('os:read') }, async (req, reply) => {
    const q = z.object({
      status: z.enum([...WO_STATUS, 'pending']).optional(), q: z.string().trim().max(100).optional(),
      mine: z.enum(['1']).optional(), subscriber_id: zUuid.optional(), contract_id: zUuid.optional(), ...zPage,
    }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      paged(c, reply,
        `${WO_SELECT}
         where ($1::text is null or (case when $1 = 'pending' then w.status in (${OPEN_WO_SQL}) else w.status = $1 end))
           and ($2::text is null or s.name ilike '%'||$2||'%' or w.description ilike '%'||$2||'%' or w.number::text = $2)
           and ($3::uuid is null or w.assignee_id = $3) and ($4::uuid is null or w.subscriber_id = $4) and ($5::uuid is null or w.contract_id = $5)
         order by (w.status in ('done','canceled')), w.scheduled_for nulls last, w.created_at desc, w.id`,
        [q.status ?? null, q.q || null, q.mine ? req.ctx.userId : null, q.subscriber_id ?? null, q.contract_id ?? null], q));
  });

  app.get('/api/work-orders/:id', { preHandler: guard('os:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query(`${WO_SELECT} where w.id = $1`, [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      w.events = (await c.query(`select e.at, e.event, e.detail, u.name as actor_name from work_order_events e left join users u on u.id = e.actor_id where e.work_order_id = $1 order by e.id desc`, [id])).rows;
      w.checklist = (await c.query(
        `select k.id, k.position, k.label, k.done, k.done_at, u.name as done_by_name
         from work_order_checklist k left join users u on u.id = k.done_by where k.work_order_id = $1 order by k.position`, [id])).rows;
      w.materials = (await c.query(
        `select m.id, m.item_id, i.name as item_name, i.unit, -m.qty as qty, m.created_at, u.name as created_by_name
         from stock_movements m join stock_items i on i.id = m.item_id left join users u on u.id = m.created_by where m.work_order_id = $1 order by m.id`, [id])).rows;
      return w;
    });
  });

  app.post('/api/work-orders', { preHandler: guard('os:write') }, async (req) => {
    const b = z.object({
      kind: z.enum(['install', 'repair', 'address_change', 'removal', 'other']), subscriber_id: zUuid, contract_id: zUuid.nullish(),
      description: zText(2000), assignee_id: zUuid.nullish(), scheduled_for: zWhen.nullish(), ticket_id: zUuid.nullish(),
      reason_id: zUuid.nullish(), estimated_minutes: z.number().int().min(5).max(1440).default(60),
      address_origin: z.enum(['subscriber', 'contract', 'manual']).default('subscriber'), address_text: z.string().trim().min(5).max(300).nullish(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [b.subscriber_id])).rowCount) throw new HttpError(400, 'assinante não encontrado');
      if (b.contract_id && !(await c.query('select 1 from contracts where id = $1 and subscriber_id = $2', [b.contract_id, b.subscriber_id])).rowCount)
        throw new HttpError(400, 'o contrato não pertence a este assinante');
      if (b.ticket_id && !(await c.query('select 1 from tickets where id = $1 and subscriber_id = $2', [b.ticket_id, b.subscriber_id])).rowCount)
        throw new HttpError(400, 'o atendimento não pertence a este assinante');
      if (b.assignee_id) await staff(c, b.assignee_id);
      await assertCatalog(c, b.reason_id, 'os_reason', 'motivo da OS');
      // O endereço da OS é registrado com a origem; trocar o cadastro depois não muda uma OS já aberta.
      let addressText: string | null = null;
      if (b.address_origin === 'manual') {
        if (!b.address_text) throw new HttpError(400, 'informe o endereço da OS');
        addressText = b.address_text;
      } else if (b.address_origin === 'contract') {
        if (!b.contract_id) throw new HttpError(400, 'escolha o contrato para usar o endereço de instalação dele');
        const k = (await c.query(
          `select concat_ws(', ', install_street, install_number, install_district, install_city) as a, install_street, install_city from contracts where id = $1`, [b.contract_id])).rows[0];
        if (!k.install_street || !k.install_city) throw new HttpError(400, 'o contrato não tem endereço de instalação cadastrado');
        addressText = k.a;
      }
      const number = await nextNumber(c, req.ctx.tenantId!, 'work_order');
      const w = (await c.query(
        `insert into work_orders (tenant_id, number, kind, status, subscriber_id, contract_id, assignee_id, scheduled_for, description, created_by, ticket_id,
                                  reason_id, estimated_minutes, address_origin, address_text)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [req.ctx.tenantId, number, b.kind, b.scheduled_for ? 'scheduled' : 'open', b.subscriber_id, b.contract_id ?? null, b.assignee_id ?? null,
          b.scheduled_for ?? null, b.description, req.ctx.userId, b.ticket_id ?? null, b.reason_id ?? null, b.estimated_minutes, b.address_origin, addressText])).rows[0];
      await applySla(c, 'work_order', w.id);
      Object.assign(w, (await c.query('select sla_policy_id, sla_due_at from work_orders where id = $1', [w.id])).rows[0]);
      await woEvent(c, req.ctx, w.id, 'created', { kind: b.kind });
      const sn = (await c.query('select name from subscribers where id = $1', [b.subscriber_id])).rows[0].name;
      await queueNotice(c, req.ctx.tenantId!, 'work_order.created', `OS ${number} aberta (${b.kind}) para ${sn}${b.scheduled_for ? `, agendada para ${b.scheduled_for}` : ''}`, { work_order_id: w.id, number });
      await audit(c, req.ctx, 'work_order.create', 'work_order', w.id, { number, kind: b.kind });
      return w;
    });
  });

  // Responsável, agendamento e descrição. Agendar/desagendar ajusta a situação enquanto o serviço não começou.
  app.patch('/api/work-orders/:id', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ assignee_id: zUuid.nullish(), scheduled_for: zWhen.nullish(), description: zText(2000).optional(), estimated_minutes: z.number().int().min(5).max(1440).optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select * from work_orders where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (FINAL.includes(cur.status)) throw new HttpError(400, 'ordem de serviço encerrada não pode ser alterada');
      const n = { ...cur };
      if (b.assignee_id !== undefined && b.assignee_id !== cur.assignee_id) {
        const u = b.assignee_id ? await staff(c, b.assignee_id) : null;
        n.assignee_id = b.assignee_id ?? null;
        await woEvent(c, req.ctx, id, 'assigned', { to: u?.name ?? null });
        if (u) await queueNotice(c, req.ctx.tenantId!, 'work_order.assigned', `OS ${cur.number} atribuída a ${u.name}`, { work_order_id: id, number: cur.number });
      }
      if (b.scheduled_for !== undefined) {
        n.scheduled_for = b.scheduled_for ?? null;
        if (['open', 'scheduled', 'awaiting_schedule'].includes(cur.status)) n.status = n.scheduled_for ? 'scheduled' : cur.status === 'awaiting_schedule' ? 'awaiting_schedule' : 'open';
        await woEvent(c, req.ctx, id, 'scheduled', { for: n.scheduled_for });
      }
      if (b.description) n.description = b.description;
      const w = (await c.query(`update work_orders set assignee_id = $2, scheduled_for = $3, status = $4, description = $5, estimated_minutes = $6, updated_at = now() where id = $1 returning *`,
        [id, n.assignee_id, n.scheduled_for, n.status, n.description, b.estimated_minutes ?? cur.estimated_minutes])).rows[0];
      await audit(c, req.ctx, 'work_order.update', 'work_order', id, b);
      return w;
    });
  });

  app.post('/api/work-orders/:id/status', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ status: z.enum(WO_STATUS), resolution: zText(2000).nullish(), reason: zText(300).nullish(), root_cause_id: zUuid.nullish() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select * from work_orders where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (!TRANSITIONS[cur.status].includes(b.status)) throw new HttpError(400, `não é possível passar de “${cur.status}” para “${b.status}”`);
      if (b.status === 'scheduled' && !cur.scheduled_for) throw new HttpError(400, 'defina a data do agendamento antes');
      if (b.status === 'en_route' && !cur.assignee_id) throw new HttpError(400, 'defina o técnico antes de registrar o deslocamento');
      if (FINAL.includes(b.status) && !b.resolution) throw new HttpError(400, b.status === 'done' ? 'descreva o que foi feito para concluir' : 'informe o motivo do cancelamento');
      await assertCatalog(c, b.root_cause_id, 'root_cause', 'causa-raiz');
      // aguardando agendamento: a data anterior deixa de valer; o motivo da espera fica registrado
      const w = (await c.query(
        `update work_orders set status = $2, resolution = coalesce($3, resolution), finished_at = case when $4 then now() end,
                en_route_at = case when $2 = 'en_route' then now() else en_route_at end,
                started_at = case when $2 = 'in_progress' then coalesce(started_at, now()) else started_at end,
                awaiting_reason = case when $2 = 'awaiting_schedule' then $5 else null end,
                scheduled_for = case when $2 = 'awaiting_schedule' then null else scheduled_for end,
                root_cause_id = coalesce($6, root_cause_id), updated_at = now() where id = $1 returning *`,
        [id, b.status, b.resolution ?? null, FINAL.includes(b.status), b.reason ?? null, b.root_cause_id ?? null])).rows[0];
      if (b.status === 'done') {   // pesquisa de satisfação: uma por OS, respondida pelo portal
        await c.query(`insert into satisfaction_surveys (tenant_id, work_order_id, work_order_number, kind, subscriber_id) values ($1,$2,$3,$4,$5)
         on conflict (work_order_id) do nothing`, [req.ctx.tenantId, id, cur.number, cur.kind, cur.subscriber_id]);
      }
      await woEvent(c, req.ctx, id, 'status', { from: cur.status, to: b.status, resolution: b.resolution ?? undefined, reason: b.reason ?? undefined });
      await audit(c, req.ctx, `work_order.${b.status}`, 'work_order', id);
      return w;
    });
  });

  app.post('/api/work-orders/:id/notes', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ note: zText(2000) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from work_orders where id = $1', [id])).rowCount) throw new HttpError(404, 'ordem de serviço não encontrada');
      await woEvent(c, req.ctx, id, 'note', { note: b.note });
      return { ok: true };
    });
  });

  // Material usado na OS: baixa do estoque na mesma transação. Devolução = quantidade negativa.
  app.post('/api/work-orders/:id/materials', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ item_id: zUuid, qty: z.number().int().min(-10000).max(10000).refine((v) => v !== 0, 'quantidade não pode ser zero') }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query('select status, number from work_orders where id = $1 for update', [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (FINAL.includes(w.status)) throw new HttpError(400, 'ordem de serviço encerrada não aceita material');
      if (b.qty < 0) {
        const used = (await c.query('select coalesce(-sum(qty),0)::int as n from stock_movements where work_order_id = $1 and item_id = $2', [id, b.item_id])).rows[0].n;
        if (used + b.qty < 0) throw new HttpError(400, `devolução maior que o lançado nesta OS (${used})`);
      }
      const m = await stockMove(c, req.ctx, b.item_id, -b.qty, b.qty > 0 ? 'out' : 'in', `OS ${w.number}`, id);   // itens com série entram por /units
      await woEvent(c, req.ctx, id, 'material', { item: m.item_name, qty: b.qty });
      return m;
    });
  });

  // ---- Estoque ----
  const zItem = z.object({
    name: z.string().trim().min(2).max(120), sku: z.string().trim().max(60).nullish().transform((v) => v || null),
    unit: z.string().trim().regex(/^[a-zA-Z]{1,6}$/, 'unidade: até 6 letras').default('un'), min_qty: z.number().int().min(0).max(1_000_000).default(0),
    serialized: z.boolean().default(false),
  });

  app.get('/api/stock/items', { preHandler: guard('stock:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`select x.*, (x.active and x.balance < x.min_qty) as low,
        (select count(*) from stock_units u where u.item_id = x.id and u.status = 'with_tech')::int as with_tech from (${ITEM_SELECT}) x order by x.active desc, x.name`)).rows));

  app.post('/api/stock/items', { preHandler: guard('stock:write') }, async (req) => {
    const b = zItem.parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const i = (await c.query('insert into stock_items (tenant_id, name, sku, unit, min_qty, serialized) values ($1,$2,$3,$4,$5,$6) returning *', [req.ctx.tenantId, b.name, b.sku, b.unit, b.min_qty, b.serialized])).rows[0];
      await audit(c, req.ctx, 'stock.item_create', 'stock_item', i.id);
      return i;
    });
  });

  app.patch('/api/stock/items/:id', { preHandler: guard('stock:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zItem.partial().extend({ active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select * from stock_items where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'item de estoque não encontrado');
      // trocar o tipo de controle com movimentos lançados deixaria saldo e unidades incoerentes
      if (b.serialized !== undefined && b.serialized !== cur.serialized && (await c.query('select 1 from stock_movements where item_id = $1 limit 1', [id])).rowCount)
        throw new HttpError(409, 'o item já tem movimentos: o controle por número de série não pode mais ser alterado');
      const n = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      await c.query('update stock_items set serialized = $2 where id = $1', [id, n.serialized]);
      const i = (await c.query('update stock_items set name=$2, sku=$3, unit=$4, min_qty=$5, active=$6 where id=$1 returning *', [id, n.name, n.sku, n.unit, n.min_qty, n.active])).rows[0];
      await audit(c, req.ctx, 'stock.item_update', 'stock_item', id, b);
      return i;
    });
  });

  app.get('/api/stock/items/:id/movements', { preHandler: guard('stock:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select m.id, m.qty, m.kind, m.note, m.created_at, m.work_order_id, w.number as work_order_number, u.name as created_by_name
         from stock_movements m left join work_orders w on w.id = m.work_order_id left join users u on u.id = m.created_by
         where m.item_id = $1 order by m.id desc limit 200`, [zUuid.parse((req.params as any).id)])).rows));

  /** Entrada e saída informam quantidade positiva; ajuste informa a diferença com sinal e exige justificativa. */
  app.post('/api/stock/items/:id/movements', { preHandler: guard('stock:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ kind: z.enum(['in', 'out', 'adjust']), qty: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, 'quantidade não pode ser zero'), note: z.string().trim().max(300).nullish() }).parse(req.body);
    if (b.kind !== 'adjust' && b.qty < 0) throw new HttpError(400, 'informe a quantidade positiva; o tipo define se entra ou sai');
    if (b.kind === 'adjust' && !b.note) throw new HttpError(400, 'ajuste de estoque exige justificativa');
    return withScope(req.ctx.scope, async (c) => {
      const m = await stockMove(c, req.ctx, id, b.kind === 'out' ? -b.qty : b.qty, b.kind, b.note || null);
      await audit(c, req.ctx, `stock.${b.kind}`, 'stock_item', id, { qty: b.qty, balance: m.balance });
      return m;
    });
  });

  // ---- Unidades com número de série ----
  const UNIT_SELECT = `
    select u.*, i.name as item_name, h.name as holder_name, s.name as subscriber_name, w.number as work_order_number
    from stock_units u join stock_items i on i.id = u.item_id left join users h on h.id = u.holder_id
    left join contracts k on k.id = u.contract_id left join subscribers s on s.id = k.subscriber_id left join work_orders w on w.id = u.work_order_id`;
  const unitEvent = (c: Tx, ctx: Ctx, id: string, event: string, detail: object = {}) =>
    c.query('insert into stock_unit_events (tenant_id, unit_id, actor_id, event, detail) values ($1,$2,$3,$4,$5)', [ctx.tenantId, id, ctx.userId, event, JSON.stringify(detail)]);
  const lockUnit = async (c: Tx, id: string) => {
    const u = (await c.query('select * from stock_units where id = $1 for update', [id])).rows[0];
    if (!u) throw new HttpError(404, 'unidade não encontrada');
    return u;
  };

  app.get('/api/stock/items/:id/units', { preHandler: guard('stock:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${UNIT_SELECT} where u.item_id = $1 order by (u.status in ('installed','written_off')), u.serial limit 2000`, [zUuid.parse((req.params as any).id)])).rows));

  /** Onde está este equipamento? Busca pelo número de série em todos os itens. */
  app.get('/api/stock/units', { preHandler: guard('stock:read') }, async (req) => {
    const q = z.object({ serial: z.string().trim().min(3).max(40).optional(), holder: zUuid.optional(), contract_id: zUuid.optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(`${UNIT_SELECT} where ($1::text is null or u.serial ilike '%'||$1||'%') and ($2::uuid is null or u.holder_id = $2) and ($3::uuid is null or u.contract_id = $3)
                      order by u.updated_at desc limit 200`, [q.serial ?? null, q.holder ?? null, q.contract_id ?? null])).rows);
  });

  app.get('/api/stock/units/:id/events', { preHandler: guard('stock:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query('select e.at, e.event, e.detail, u.name as actor_name from stock_unit_events e left join users u on u.id = e.actor_id where e.unit_id = $1 order by e.id desc', [zUuid.parse((req.params as any).id)])).rows));

  // Entrada: uma unidade por número de série; o saldo do item sobe na mesma transação.
  app.post('/api/stock/items/:id/units', { preHandler: guard('stock:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ serials: z.array(z.string().trim().regex(/^[A-Za-z0-9._:-]{4,40}$/, 'série: 4 a 40 letras, números, . _ : -').transform((v) => v.toUpperCase())).min(1).max(500),
      note: z.string().trim().max(300).nullish() }).parse(req.body);
    const serials = [...new Set(b.serials)];
    return withScope(req.ctx.scope, async (c) => {
      const m = await stockMove(c, req.ctx, id, serials.length, 'in', b.note || `entrada de ${serials.length} unidade(s)`, null, true);
      const dup = (await c.query('select serial from stock_units where item_id = $1 and serial = any($2)', [id, serials])).rows.map((r) => r.serial);
      if (dup.length) throw new HttpError(409, `número(s) de série já cadastrado(s): ${dup.slice(0, 5).join(', ')}`);
      for (const s of serials) {
        const u = (await c.query('insert into stock_units (tenant_id, item_id, serial) values ($1,$2,$3) returning id', [req.ctx.tenantId, id, s])).rows[0];
        await unitEvent(c, req.ctx, u.id, 'received');
      }
      await audit(c, req.ctx, 'stock.units_receive', 'stock_item', id, { count: serials.length });
      return { received: serials.length, balance: m.balance };
    });
  });

  // Entrega ao técnico / devolução ao almoxarifado. Não altera o saldo: a unidade continua sendo do provedor.
  app.post('/api/stock/units/:id/transfer', { preHandler: guard('stock:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ holder_id: zUuid.nullable() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const u = await lockUnit(c, id);
      if (!['in_stock', 'with_tech'].includes(u.status)) throw new HttpError(400, 'só unidades em estoque ou com técnico podem ser transferidas');
      const h = b.holder_id ? await staff(c, b.holder_id) : null;
      await c.query(`update stock_units set status = $2, holder_id = $3, contract_mode = null, updated_at = now() where id = $1`, [id, h ? 'with_tech' : 'in_stock', b.holder_id]);
      await unitEvent(c, req.ctx, id, h ? 'to_tech' : 'to_stock', h ? { to: h.name } : {});
      return { ok: true };
    });
  });

  /** Baixa (defeito sem conserto, perda) tira do saldo; "com defeito" e "voltou ao estoque" mantêm. Retirada do assinante devolve ao saldo. */
  app.post('/api/stock/units/:id/status', { preHandler: guard('stock:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ status: z.enum(['in_stock', 'defective', 'written_off']), note: z.string().trim().max(300).nullish() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const u = await lockUnit(c, id);
      if (u.status === 'written_off') throw new HttpError(400, 'unidade baixada não volta ao estoque: cadastre uma nova entrada');
      if (u.status === b.status) throw new HttpError(400, 'a unidade já está nessa situação');
      if (b.status === 'written_off' && !b.note) throw new HttpError(400, 'informe o motivo da baixa');
      const wasOut = u.status === 'installed';                    // instalada já tinha saído do saldo
      if (wasOut && b.status !== 'written_off') await stockMove(c, req.ctx, u.item_id, 1, 'in', `retirada do assinante: ${u.serial}`, null, true);
      if (!wasOut && b.status === 'written_off') await stockMove(c, req.ctx, u.item_id, -1, 'adjust', `baixa ${u.serial}: ${b.note}`, null, true);
      await c.query(`update stock_units set status = $2, holder_id = null, contract_id = null, work_order_id = null, contract_mode = null, updated_at = now() where id = $1`, [id, b.status]);
      await unitEvent(c, req.ctx, id, wasOut && b.status === 'in_stock' ? 'returned' : b.status === 'in_stock' ? 'to_stock' : b.status, { note: b.note ?? undefined, from: u.status });
      await audit(c, req.ctx, `stock.unit_${b.status}`, 'stock_unit', id, { serial: u.serial });
      return { ok: true };
    });
  });

  // ---- Checklist da OS: itens em ordem; o técnico marca o que fez ----
  app.post('/api/work-orders/:id/checklist', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ items: z.array(z.string().trim().min(2).max(160)).min(1).max(30) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query('select status, number from work_orders where id = $1 for update', [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (FINAL.includes(w.status)) throw new HttpError(400, 'ordem de serviço encerrada não aceita alterações');
      const start = (await c.query('select coalesce(max(position), 0)::int as p from work_order_checklist where work_order_id = $1', [id])).rows[0].p;
      for (const [n, label] of b.items.entries())
        await c.query('insert into work_order_checklist (tenant_id, work_order_id, position, label) values ($1,$2,$3,$4)', [req.ctx.tenantId, id, start + n + 1, label]);
      await woEvent(c, req.ctx, id, 'checklist', { added: b.items.length });
      return { ok: true };
    });
  });

  app.post('/api/work-orders/:id/checklist/:itemId', { preHandler: guard('os:write') }, async (req) => {
    const p = z.object({ id: zUuid, itemId: zUuid }).parse(req.params);
    const b = z.object({ done: z.boolean() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query('select status from work_orders where id = $1 for update', [p.id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (FINAL.includes(w.status)) throw new HttpError(400, 'ordem de serviço encerrada não aceita alterações');
      const r = await c.query(
        `update work_order_checklist set done = $3, done_by = case when $3 then $4::uuid end, done_at = case when $3 then now() end
         where id = $1 and work_order_id = $2 returning label`, [p.itemId, p.id, b.done, req.ctx.userId]);
      if (!r.rowCount) throw new HttpError(404, 'item não encontrado');
      await woEvent(c, req.ctx, p.id, b.done ? 'checklist_done' : 'checklist_undone', { item: r.rows[0].label });
      return { ok: true };
    });
  });

  // ---- Equipamentos do contrato (comodato continua sendo do provedor; venda não volta) ----
  app.get('/api/contracts/:id/equipment', { preHandler: guard('stock:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const id = zUuid.parse((req.params as any).id);
      const k = (await c.query('select status from contracts where id = $1', [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      const units = (await c.query(`${UNIT_SELECT} where u.contract_id = $1 and u.status = 'installed' order by u.updated_at desc`, [id])).rows;
      // contrato encerrado com equipamento em comodato instalado: falta recolher
      return { units, to_recover: k.status === 'ended' ? units.filter((u) => u.contract_mode === 'comodato') : [] };
    }));

  // Instalação pela OS: a unidade sai do saldo e fica vinculada ao contrato da ordem de serviço.
  app.post('/api/work-orders/:id/units', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ unit_id: zUuid, mode: z.enum(['comodato', 'sale']).default('comodato') }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query('select status, number, contract_id from work_orders where id = $1 for update', [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (FINAL.includes(w.status)) throw new HttpError(400, 'ordem de serviço encerrada não aceita material');
      if (!w.contract_id) throw new HttpError(400, 'a ordem de serviço não tem contrato: informe o contrato para instalar um equipamento com série');
      const u = await lockUnit(c, b.unit_id);
      if (!['in_stock', 'with_tech'].includes(u.status)) throw new HttpError(409, 'a unidade não está disponível (já instalada, com defeito ou baixada)');
      const m = await stockMove(c, req.ctx, u.item_id, -1, 'out', `OS ${w.number}: ${u.serial}`, id, true);
      await c.query(`update stock_units set status = 'installed', holder_id = null, contract_id = $2, work_order_id = $3, contract_mode = $4, updated_at = now() where id = $1`, [b.unit_id, w.contract_id, id, b.mode]);
      await unitEvent(c, req.ctx, b.unit_id, 'installed', { work_order: w.number, mode: b.mode });
      await woEvent(c, req.ctx, id, 'material', { item: m.item_name, qty: 1, serial: u.serial });
      return { ok: true, balance: m.balance };
    });
  });

  // ---- FTTH: caixas e portas ----
  const zBox = z.object({
    name: z.string().trim().min(2).max(80), kind: z.enum(['cto', 'ceo']), ports: z.number().int().min(1).max(144),
    parent_id: zUuid.nullish(), device_id: zUuid.nullish(),
    pon_port: z.string().trim().regex(/^[0-9]{1,3}(\/[0-9]{1,3}){0,3}$/, 'porta PON no formato 0/1/3').nullish().or(z.literal('')).transform((v) => v || null),
    address: z.string().trim().max(200).nullish().transform((v) => v || null), notes: z.string().trim().max(500).nullish().transform((v) => v || null),
    latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish(),
  });
  async function checkBox(c: Tx, b: Partial<z.infer<typeof zBox>>, selfId?: string) {
    if (b.device_id) {
      const d = (await c.query('select driver from devices where id = $1', [b.device_id])).rows[0];
      if (!d || !d.driver.startsWith('olt')) throw new HttpError(400, 'o equipamento escolhido não é uma OLT');
    }
    if (b.parent_id) {
      // a caixa anterior não pode ser a própria nem uma descendente dela (evita ciclo)
      const loop = (await c.query(
        `with recursive up as (select id, parent_id from ftth_boxes where id = $1 union all select b.id, b.parent_id from ftth_boxes b join up on b.id = up.parent_id)
         select (select count(*) from up) as found, exists (select 1 from up where id = $2) as cycle`, [b.parent_id, selfId ?? null])).rows[0];
      if (!loop.found) throw new HttpError(400, 'caixa anterior não encontrada');
      if (selfId && (loop.cycle || b.parent_id === selfId)) throw new HttpError(400, 'a caixa anterior não pode ser a própria caixa nem uma derivada dela');
    }
  }

  app.get('/api/ftth/boxes', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${BOX_SELECT} order by b.name`)).rows));

  app.get('/api/ftth/boxes/:id', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const b = (await c.query(`${BOX_SELECT} where b.id = $1`, [id])).rows[0];
      if (!b) throw new HttpError(404, 'caixa não encontrada');
      b.drops = (await c.query(`${DROP_SELECT} where x.box_id = $1 order by x.port`, [id])).rows;
      return b;
    });
  });

  app.post('/api/ftth/boxes', { preHandler: guard('network:write') }, async (req) => {
    const b = zBox.parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      await checkBox(c, b);
      const x = (await c.query(
        `insert into ftth_boxes (tenant_id, name, kind, ports, parent_id, device_id, pon_port, address, latitude, longitude, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [req.ctx.tenantId, b.name, b.kind, b.ports, b.parent_id ?? null, b.device_id ?? null, b.pon_port, b.address, b.latitude ?? null, b.longitude ?? null, b.notes])).rows[0];
      await audit(c, req.ctx, 'ftth.box_create', 'ftth_box', x.id);
      return x;
    });
  });

  app.patch('/api/ftth/boxes/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zBox.partial().parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select * from ftth_boxes where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'caixa não encontrada');
      await checkBox(c, b, id);
      const n = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      const top = (await c.query('select coalesce(max(port),0)::int as p from ftth_drops where box_id = $1', [id])).rows[0].p;
      if (n.ports < top) throw new HttpError(409, `a porta ${top} está ocupada; libere-a antes de reduzir a caixa`);
      const x = (await c.query(
        `update ftth_boxes set name=$2, kind=$3, ports=$4, parent_id=$5, device_id=$6, pon_port=$7, address=$8, latitude=$9, longitude=$10, notes=$11 where id=$1 returning *`,
        [id, n.name, n.kind, n.ports, n.parent_id, n.device_id, n.pon_port, n.address, n.latitude, n.longitude, n.notes])).rows[0];
      await audit(c, req.ctx, 'ftth.box_update', 'ftth_box', id, b);
      return x;
    });
  });

  app.delete('/api/ftth/boxes/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const b = (await c.query(`${BOX_SELECT} where b.id = $1`, [id])).rows[0];
      if (!b) throw new HttpError(404, 'caixa não encontrada');
      if (b.used > 0 || b.children > 0) throw new HttpError(409, 'a caixa tem portas ocupadas ou caixas derivadas');
      await c.query('delete from ftth_boxes where id = $1', [id]);
      await audit(c, req.ctx, 'ftth.box_delete', 'ftth_box', id, { name: b.name });
      return { ok: true };
    });
  });

  app.post('/api/ftth/boxes/:id/drops', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ port: z.number().int().min(1).max(144), contract_id: zUuid.nullish(), note: z.string().trim().max(200).nullish() }).parse(req.body);
    if (!b.contract_id && !b.note) throw new HttpError(400, 'informe o contrato ou uma anotação para reservar a porta');
    return withScope(req.ctx.scope, async (c) => {
      const box = (await c.query('select ports from ftth_boxes where id = $1 for update', [id])).rows[0];
      if (!box) throw new HttpError(404, 'caixa não encontrada');
      if (b.port > box.ports) throw new HttpError(400, `a caixa tem ${box.ports} porta(s)`);
      if (b.contract_id && !(await c.query('select 1 from contracts where id = $1', [b.contract_id])).rowCount) throw new HttpError(400, 'contrato não encontrado');
      const x = (await c.query('insert into ftth_drops (tenant_id, box_id, port, contract_id, note) values ($1,$2,$3,$4,$5) returning *',
        [req.ctx.tenantId, id, b.port, b.contract_id ?? null, b.note || null])).rows[0];
      await audit(c, req.ctx, 'ftth.drop_create', 'ftth_drop', x.id, { box_id: id, port: b.port, contract_id: b.contract_id ?? null });
      return x;
    });
  });

  app.delete('/api/ftth/drops/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const x = (await c.query('delete from ftth_drops where id = $1 returning box_id, port, contract_id', [id])).rows[0];
      if (!x) throw new HttpError(404, 'porta não encontrada');
      await audit(c, req.ctx, 'ftth.drop_delete', 'ftth_drop', id, x);
      return { ok: true };
    });
  });

  app.get('/api/contracts/:id/ftth', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => ({ drop: (await c.query(`${DROP_SELECT} where x.contract_id = $1`, [zUuid.parse((req.params as any).id)])).rows[0] ?? null })));
}
