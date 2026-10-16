import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope, type Tx } from '../db.js';
import { zDate, zUuid } from '../validators.js';
import { stockMove } from './field.js';

/** Campos personalizados (P3), kit de instalação e técnicos auxiliares (F5) e comissão (F7). */
const ENTITY = { subscriber: 'subscribers', contract: 'contracts' } as const;
const zKey = z.string().regex(/^[a-z][a-z0-9_]{1,29}$/, 'identificador: minúsculas, números e _ (2 a 30)');

/** Valida os valores contra as definições ativas. `null` limpa o campo; campo obrigatório não pode ser limpo. */
async function checkCustom(c: Tx, entity: keyof typeof ENTITY, values: Record<string, unknown>) {
  const defs = new Map<string, any>((await c.query('select * from custom_fields where entity = $1 and active', [entity])).rows.map((d) => [d.key, d]));
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(values)) {
    const d = defs.get(k);
    if (!d) throw new HttpError(400, `campo "${k}" não existe ou está inativo`);
    if (v === null || v === '') {
      if (d.required) throw new HttpError(400, `"${d.label}" é obrigatório`);
      out[k] = null;
      continue;
    }
    if (d.type === 'text') {
      if (typeof v !== 'string' || v.length > 300) throw new HttpError(400, `"${d.label}": texto de até 300 caracteres`);
      out[k] = v.trim();
    } else if (d.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `"${d.label}": informe um número`);
      out[k] = v;
    } else if (d.type === 'boolean') {
      if (typeof v !== 'boolean') throw new HttpError(400, `"${d.label}": informe sim ou não`);
      out[k] = v;
    } else if (d.type === 'date') {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `"${d.label}": use AAAA-MM-DD`);
      out[k] = v;
    } else {
      if (typeof v !== 'string' || !d.options.includes(v)) throw new HttpError(400, `"${d.label}": valor fora das opções`);
      out[k] = v;
    }
  }
  return out;
}

export async function produtividadeRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- campos personalizados
  app.get('/api/custom-fields', { preHandler: guard('subscribers:read') }, async (req) => {
    const q = z.object({ entity: z.enum(['subscriber', 'contract']).optional(), all: z.enum(['1']).optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select id, entity, key, label, type, options, required, active, position from custom_fields
         where ($1::text is null or entity = $1) and ($2::boolean or active) order by entity, position, label`, [q.entity ?? null, !!q.all])).rows);
  });

  app.post('/api/custom-fields', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({
      entity: z.enum(['subscriber', 'contract']), key: zKey, label: z.string().trim().min(2).max(60),
      type: z.enum(['text', 'number', 'date', 'boolean', 'select']), options: z.array(z.string().trim().min(1).max(60)).min(1).max(30).optional(),
      required: z.boolean().default(false), position: z.number().int().min(0).max(999).default(0),
    }).superRefine((v, ctx) => { if ((v.type === 'select') !== !!v.options) ctx.addIssue({ code: 'custom', message: 'opções só para campo de seleção (e obrigatórias nele)' }); }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `insert into custom_fields (tenant_id, entity, key, label, type, options, required, position) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.ctx.tenantId, b.entity, b.key, b.label, b.type, b.options ?? null, b.required, b.position])).rows[0];
      await audit(c, req.ctx, 'custom_field.create', 'custom_field', r.id, { entity: b.entity, key: b.key, type: b.type });
      return r;
    });
  });

  // Não se apaga campo (os valores já gravados usam a chave): desativa-se. Tipo e chave não mudam depois de criados.
  app.patch('/api/custom-fields/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ label: z.string().trim().min(2).max(60).optional(), options: z.array(z.string().trim().min(1).max(60)).min(1).max(30).optional(),
      required: z.boolean().optional(), active: z.boolean().optional(), position: z.number().int().min(0).max(999).optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select type from custom_fields where id = $1', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'campo não encontrado');
      if (b.options && cur.type !== 'select') throw new HttpError(400, 'opções só valem para campo de seleção');
      const r = (await c.query(
        `update custom_fields set label = coalesce($2, label), options = coalesce($3, options), required = coalesce($4, required),
                active = coalesce($5, active), position = coalesce($6, position) where id = $1 returning *`,
        [id, b.label ?? null, b.options ?? null, b.required ?? null, b.active ?? null, b.position ?? null])).rows[0];
      await audit(c, req.ctx, 'custom_field.update', 'custom_field', id, b);
      return r;
    });
  });

  for (const entity of ['subscriber', 'contract'] as const) {
    const perm = entity === 'subscriber' ? 'subscribers:write' : 'contracts:write';
    app.put(`/api/${entity === 'subscriber' ? 'subscribers' : 'contracts'}/:id/custom`, { preHandler: guard(perm) }, async (req) => {
      const id = zUuid.parse((req.params as any).id);
      const b = z.object({ values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) }).parse(req.body);
      return withScope(req.ctx.scope, async (c) => {
        const clean = await checkCustom(c, entity, b.values);
        const r = (await c.query(
          `update ${ENTITY[entity]} set custom = (custom || $2::jsonb) where id = $1 returning custom`, [id, JSON.stringify(clean)])).rows[0];
        if (!r) throw new HttpError(404, 'registro não encontrado');
        // chave com valor nulo sai do jsonb (campo vazio = campo ausente)
        const cleared = Object.entries(clean).filter(([, v]) => v === null).map(([k]) => k);
        if (cleared.length) await c.query(`update ${ENTITY[entity]} set custom = custom - $2::text[] where id = $1`, [id, cleared]);
        await audit(c, req.ctx, `${entity}.custom`, entity, id, { keys: Object.keys(clean) });
        return (await c.query(`select custom from ${ENTITY[entity]} where id = $1`, [id])).rows[0];
      });
    });
  }

  // ---------------------------------------------------------------- kit de instalação
  app.get('/api/install-kits', { preHandler: guard('stock:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select k.id, k.name, k.active,
                coalesce(json_agg(json_build_object('item_id', i.id, 'name', i.name, 'unit', i.unit, 'qty', x.qty) order by i.name) filter (where i.id is not null), '[]') as items
         from install_kits k left join install_kit_items x on x.kit_id = k.id left join stock_items i on i.id = x.item_id
         group by k.id order by k.name`)).rows));

  app.post('/api/install-kits', { preHandler: guard('stock:write') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(60), items: z.array(z.object({ item_id: zUuid, qty: z.number().int().min(1).max(10000) })).min(1).max(30) }).parse(req.body);
    if (new Set(b.items.map((i) => i.item_id)).size !== b.items.length) throw new HttpError(400, 'item repetido no kit');
    return withScope(req.ctx.scope, async (c) => {
      for (const it of b.items) {
        const s = (await c.query('select name, serialized, active from stock_items where id = $1', [it.item_id])).rows[0];
        if (!s) throw new HttpError(400, 'item de estoque não encontrado');
        if (s.serialized) throw new HttpError(400, `“${s.name}” é controlado por número de série e não entra em kit`);
        if (!s.active) throw new HttpError(400, `“${s.name}” está inativo`);
      }
      const k = (await c.query('insert into install_kits (tenant_id, name) values ($1,$2) returning id, name, active', [req.ctx.tenantId, b.name])).rows[0];
      for (const it of b.items) await c.query('insert into install_kit_items (tenant_id, kit_id, item_id, qty) values ($1,$2,$3,$4)', [req.ctx.tenantId, k.id, it.item_id, it.qty]);
      await audit(c, req.ctx, 'install_kit.create', 'install_kit', k.id, { name: b.name, items: b.items.length });
      return k;
    });
  });

  app.patch('/api/install-kits/:id', { preHandler: guard('stock:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('update install_kits set active = $2 where id = $1 returning id, name, active', [id, b.active])).rows[0];
      if (!r) throw new HttpError(404, 'kit não encontrado');
      await audit(c, req.ctx, 'install_kit.update', 'install_kit', id, b);
      return r;
    });
  });

  // Lança todo o kit na OS (baixa do estoque item a item, na mesma transação: falta de saldo desfaz tudo).
  app.post('/api/work-orders/:id/kit', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ kit_id: zUuid }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query('select number, status from work_orders where id = $1 for update', [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (['done', 'canceled'].includes(w.status)) throw new HttpError(400, 'ordem de serviço encerrada não aceita material');
      const kit = (await c.query('select name, active from install_kits where id = $1', [b.kit_id])).rows[0];
      if (!kit || !kit.active) throw new HttpError(404, 'kit não encontrado ou inativo');
      const items = (await c.query('select item_id, qty from install_kit_items where kit_id = $1', [b.kit_id])).rows;
      const launched: { item: string; qty: number }[] = [];
      for (const it of items) {
        const m = await stockMove(c, req.ctx, it.item_id, -it.qty, 'out', `OS ${w.number} (kit ${kit.name})`, id);
        launched.push({ item: m.item_name, qty: it.qty });
        await c.query(`insert into work_order_events (tenant_id, work_order_id, actor_id, event, detail) values ($1,$2,$3,'material',$4)`,
          [req.ctx.tenantId, id, req.ctx.userId, JSON.stringify({ item: m.item_name, qty: it.qty, kit: kit.name })]);
      }
      await audit(c, req.ctx, 'work_order.kit', 'work_order', id, { kit: kit.name, items: launched.length });
      return { kit: kit.name, launched };
    });
  });

  // ---------------------------------------------------------------- técnicos auxiliares
  app.get('/api/work-orders/:id/helpers', { preHandler: guard('os:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select h.user_id, u.name, h.added_at from work_order_helpers h join users u on u.id = h.user_id where h.work_order_id = $1 order by u.name`,
        [zUuid.parse((req.params as any).id)])).rows));

  app.post('/api/work-orders/:id/helpers', { preHandler: guard('os:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ user_id: zUuid }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const w = (await c.query('select assignee_id, status from work_orders where id = $1', [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      if (w.assignee_id === b.user_id) throw new HttpError(400, 'o responsável da OS não é auxiliar dela');
      const u = (await c.query(`select name from users where id = $1 and active and role <> 'subscriber'`, [b.user_id])).rows[0];
      if (!u) throw new HttpError(400, 'usuário não encontrado neste provedor');
      await c.query('insert into work_order_helpers (tenant_id, work_order_id, user_id) values ($1,$2,$3) on conflict do nothing', [req.ctx.tenantId, id, b.user_id]);
      await c.query(`insert into work_order_events (tenant_id, work_order_id, actor_id, event, detail) values ($1,$2,$3,'helper_added',$4)`, [req.ctx.tenantId, id, req.ctx.userId, JSON.stringify({ name: u.name })]);
      return { ok: true };
    });
  });

  app.delete('/api/work-orders/:id/helpers/:userId', { preHandler: guard('os:write') }, async (req) => {
    const p = z.object({ id: zUuid, userId: zUuid }).parse(req.params);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('delete from work_order_helpers where work_order_id = $1 and user_id = $2', [p.id, p.userId]);
      if (!r.rowCount) throw new HttpError(404, 'auxiliar não encontrado nesta OS');
      await c.query(`insert into work_order_events (tenant_id, work_order_id, actor_id, event, detail) values ($1,$2,$3,'helper_removed',$4)`, [req.ctx.tenantId, p.id, req.ctx.userId, JSON.stringify({ user_id: p.userId })]);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- comissão
  app.get('/api/commission-rules', { preHandler: guard('finance:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query('select * from commission_rules where active order by subject, os_kind nulls first')).rows));

  app.post('/api/commission-rules', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({
      subject: z.enum(['work_order', 'sale']), os_kind: z.enum(['install', 'repair', 'address_change', 'removal', 'other']).nullish(),
      assignee_cents: z.number().int().min(0).max(100_000_000), helper_cents: z.number().int().min(0).max(100_000_000).default(0),
    }).superRefine((v, ctx) => { if (v.subject === 'sale' && (v.os_kind || v.helper_cents)) ctx.addIssue({ code: 'custom', message: 'regra de venda não tem natureza de OS nem auxiliar' }); }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      // uma regra vigente por assunto+natureza: a nova substitui a anterior (que fica inativa, para o histórico)
      await c.query(`update commission_rules set active = false where subject = $1 and coalesce(os_kind, '') = coalesce($2, '') and active`, [b.subject, b.os_kind ?? null]);
      const r = (await c.query(
        `insert into commission_rules (tenant_id, subject, os_kind, assignee_cents, helper_cents) values ($1,$2,$3,$4,$5) returning *`,
        [req.ctx.tenantId, b.subject, b.os_kind ?? null, b.assignee_cents, b.helper_cents])).rows[0];
      await audit(c, req.ctx, 'commission_rule.set', 'commission_rule', r.id, b);
      return r;
    });
  });

  // Apuração por pessoa: OS concluídas no período (finished_at) e prospectos ganhos (data da conversão). Usa as regras vigentes.
  app.get('/api/reports/commissions', { preHandler: guard('finance:read') }, async (req) => {
    const q = z.object({ from: zDate, to: zDate }).parse(req.query);
    if (q.to < q.from) throw new HttpError(400, 'o fim do período é anterior ao início');
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await c.query(`select coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo') as tz`, [req.ctx.tenantId])).rows[0].tz;
      const range = `>= $1::date::timestamp at time zone $3 and %COL% < ($2::date + 1)::timestamp at time zone $3`;
      const os = (await c.query(
        `with w as (
           select w.id, w.assignee_id,
                  coalesce((select r.assignee_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind = w.kind),
                           (select r.assignee_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind is null), 0) as a_cents,
                  coalesce((select r.helper_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind = w.kind),
                           (select r.helper_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind is null), 0) as h_cents
           from work_orders w where w.status = 'done' and w.finished_at ${range.replace('%COL%', 'w.finished_at')})
         select u.id as user_id, u.name, 'assignee' as role, count(*)::int as n, sum(w.a_cents)::int as cents
           from w join users u on u.id = w.assignee_id group by u.id, u.name
         union all
         select u.id, u.name, 'helper', count(*)::int, sum(w.h_cents)::int
           from w join work_order_helpers h on h.work_order_id = w.id join users u on u.id = h.user_id group by u.id, u.name`, [q.from, q.to, tz])).rows;
      const sales = (await c.query(
        `select u.id as user_id, u.name, 'sale' as role, count(*)::int as n,
                (count(*) * coalesce((select r.assignee_cents from commission_rules r where r.active and r.subject = 'sale'), 0))::int as cents
         from leads l join users u on u.id = l.owner_id
         where l.stage = 'won' and l.updated_at ${range.replace('%COL%', 'l.updated_at')} group by u.id, u.name`, [q.from, q.to, tz])).rows;
      const people = new Map<string, any>();
      for (const r of [...os, ...sales]) {
        const p = people.get(r.user_id) ?? { user_id: r.user_id, name: r.name, os_assignee: 0, os_assignee_cents: 0, os_helper: 0, os_helper_cents: 0, sales: 0, sales_cents: 0, total_cents: 0 };
        if (r.role === 'assignee') { p.os_assignee = r.n; p.os_assignee_cents = r.cents; }
        if (r.role === 'helper') { p.os_helper = r.n; p.os_helper_cents = r.cents; }
        if (r.role === 'sale') { p.sales = r.n; p.sales_cents = r.cents; }
        p.total_cents = p.os_assignee_cents + p.os_helper_cents + p.sales_cents;
        people.set(r.user_id, p);
      }
      await audit(c, req.ctx, 'report.commissions', 'report', null, q);
      return { from: q.from, to: q.to, timezone: tz, rows: [...people.values()].sort((a, b) => b.total_cents - a.total_cents),
        total_cents: [...people.values()].reduce((s, p) => s + p.total_cents, 0),
        note: 'Calculado com as regras vigentes hoje; mudar a regra muda a apuração de períodos passados ainda não pagos.' };
    });
  });
}
