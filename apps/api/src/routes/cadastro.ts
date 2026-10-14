import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { paged, withScope, type Tx } from '../db.js';
import { ensureCharges } from '../finance/core.js';
import { contractChangeHooks } from '../hooks.js';
import { assertCatalog } from '../sla.js';
import { zDate, zPage, zSubscriber, zUuid } from '../validators.js';

const SUB_COLS = ['name', 'document', 'email', 'phone', 'address_street', 'address_number', 'address_district',
  'address_city', 'address_state', 'address_zip', 'notes', 'status', 'birth_date', 'rg', 'rg_issuer', 'mother_name', 'trade_name'] as const;

export const CONTRACT_SELECT = `
  select c.*, s.name as subscriber_name, s.document as subscriber_document,
         p.id as plan_id, p.name as plan_name, pv.version as plan_version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name,
         coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name) from contract_tags ct join tags t on t.id = ct.tag_id where ct.contract_id = c.id), '[]') as tags
  from contracts c
  join subscribers s on s.id = c.subscriber_id
  join plan_versions pv on pv.id = c.plan_version_id
  join plans p on p.id = pv.plan_id`;

export async function currentVersion(c: any, planId: string) {
  const v = (await c.query(
    `select v.id, v.version, p.active, p.name from plans p join plan_versions v on v.plan_id = p.id where p.id = $1 order by v.version desc limit 1`, [planId])).rows[0];
  if (!v) throw new HttpError(400, 'plano não encontrado');
  if (!v.active) throw new HttpError(400, 'plano inativo não aceita novos contratos');
  return v;
}

export const zContractChange = z.object({
  plan_id: zUuid.optional(), due_day: z.number().int().min(1).max(28).optional(),
  notes: z.string().trim().max(2000).nullish(), end: z.boolean().optional(),
  end_reason_id: zUuid.nullish(), end_note: z.string().trim().max(300).nullish(),
  penalty: z.enum(['charge', 'waive']).optional(), penalty_waive_reason: z.string().trim().min(5).max(200).optional(), penalty_due_days: z.number().int().min(0).max(60).default(10),
});
export type ContractChange = z.infer<typeof zContractChange>;

/** Data de hoje (+ dias) no fuso do provedor: à noite o dia do servidor (UTC) já é o seguinte. */
async function localToday(c: Tx, plusDays: number): Promise<string> {
  return (await c.query(
    `select ((now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date + $1::int)::text as d`, [plusDays])).rows[0].d;
}

/** Cotação de encerramento: dentro da carência há multa (valor único ou por mês restante). Só leitura. */
export async function terminationQuote(c: Tx, contractId: string, onDate?: string) {
  const k = (await c.query(
    `select k.status, k.loyalty_until, k.penalty_model, k.penalty_cents,
            greatest(0, (extract(year from age(k.loyalty_until, $2::date)) * 12 + extract(month from age(k.loyalty_until, $2::date))
                         + case when extract(day from age(k.loyalty_until, $2::date)) > 0 then 1 else 0 end))::int as remaining_months,
            (k.loyalty_until is not null and k.loyalty_until > $2::date) as within_loyalty,
            (select coalesce(sum(i.amount_cents), 0)::int from invoices i where i.contract_id = k.id and i.status = 'open') as open_cents,
            (select count(*)::int from invoices i where i.contract_id = k.id and i.status = 'open') as open_count
     from contracts k where k.id = $1`, [contractId, onDate ?? await localToday(c, 0)])).rows[0];
  if (!k) throw new HttpError(404, 'contrato não encontrado');
  const penalty = k.within_loyalty ? (k.penalty_model === 'monthly' ? k.penalty_cents * k.remaining_months : k.penalty_cents) : 0;
  return {
    status: k.status as string, loyalty_until: k.loyalty_until as string | null, within_loyalty: !!k.within_loyalty, remaining_months: k.within_loyalty ? (k.remaining_months as number) : 0,
    penalty_model: k.penalty_model as string | null, penalty_unit_cents: k.penalty_cents as number | null, penalty_cents: penalty as number,
    open_invoices: k.open_count as number, open_invoices_cents: k.open_cents as number, total_cents: penalty + (k.open_cents as number),
  };
}

type ChangeCtx = { tenantId: string | null; userId: string | null };

/**
 * Troca de plano, vencimento, observação e encerramento (com motivo e decisão sobre a multa de fidelidade), na transação do chamador.
 * Usada pelo painel e pelas mudanças agendadas. Os módulos de rede reagem pelos `contractChangeHooks`.
 */
export async function changeContract(c: Tx, ctx: ChangeCtx, id: string, b: ContractChange, actorLabel = 'contract') {
  const cur = (await c.query(`${CONTRACT_SELECT} where c.id = $1 for update of c`, [id])).rows[0];
  if (!cur) throw new HttpError(404, 'contrato não encontrado');
  if (cur.status === 'ended') throw new HttpError(400, 'contrato encerrado não pode ser alterado');
  const hist = async (event: string, detail: object) =>
    c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, id, ctx.userId, event, JSON.stringify(detail)]);
  if (b.plan_id) {
    const v = await currentVersion(c, b.plan_id);
    if (v.id !== cur.plan_version_id) {
      await c.query('update contracts set plan_version_id = $2, updated_at = now() where id = $1', [id, v.id]);
      await hist('plan_changed', { from: `${cur.plan_name} v${cur.plan_version}`, to: `${v.name} v${v.version}` });
    }
  }
  if (b.due_day && b.due_day !== cur.due_day) {
    await c.query('update contracts set due_day = $2, updated_at = now() where id = $1', [id, b.due_day]);
    await hist('due_day_changed', { from: cur.due_day, to: b.due_day });
  }
  if (b.notes !== undefined) await c.query('update contracts set notes = $2 where id = $1', [id, b.notes || null]);
  if (b.end) {
    await assertCatalog(c, b.end_reason_id, 'end_reason', 'motivo de encerramento');
    const q = await terminationQuote(c, id);
    if (q.within_loyalty && q.penalty_cents > 0) {
      if (!b.penalty) throw new HttpError(409, `contrato em fidelidade até ${String(q.loyalty_until).slice(0, 10)}: escolha cobrar ou dispensar a multa de ${(q.penalty_cents / 100).toFixed(2).replace('.', ',')}`, 'penalty_decision_required');
      if (b.penalty === 'waive') {
        if (!b.penalty_waive_reason) throw new HttpError(400, 'informe o motivo para dispensar a multa');
        await hist('penalty_waived', { amount_cents: q.penalty_cents, reason: b.penalty_waive_reason });
      } else {
        const due = await localToday(c, b.penalty_due_days);
        const inv = (await c.query(
          `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents) values ($1,$2,$3,'manual',$4,$5) returning id`,
          [ctx.tenantId, id, cur.subscriber_id, due, q.penalty_cents])).rows[0];
        await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)',
          [ctx.tenantId, inv.id, `Multa rescisória — fidelidade até ${String(q.loyalty_until).slice(0, 10).split('-').reverse().join('/')}`, q.penalty_cents]);
        await hist('penalty_charged', { amount_cents: q.penalty_cents, invoice_id: inv.id });
        await ensureCharges(c, ctx.tenantId!);       // cobrança no gateway, como em qualquer fatura avulsa
      }
    }
    await c.query(`update contracts set status = 'ended', end_date = current_date, end_reason_id = $2, end_note = $3, updated_at = now() where id = $1`,
      [id, b.end_reason_id ?? null, b.end_note || null]);
    await hist('ended', { reason_id: b.end_reason_id ?? null, note: b.end_note ?? null });
  }
  await audit(c, ctx.userId ? ctx as any : null, b.end ? 'contract.end' : 'contract.update', 'contract', id, { ...b, via: actorLabel },
    'ok', ctx.userId ? undefined : { type: 'system', id: actorLabel, tenantId: ctx.tenantId! });
  for (const h of contractChangeHooks) await h(c, ctx, id);
}

export async function cadastroRoutes(app: FastifyInstance) {
  // ---- Assinantes ----
  app.get('/api/subscribers', { preHandler: guard('subscribers:read') }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().max(100).optional(), status: z.enum(['active', 'inactive']).optional(), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const digits = q.q?.replace(/\D/g, '') ?? '';
      return paged(c, reply,
        `select s.*, (select count(*) from contracts c where c.subscriber_id = s.id and c.status = 'active') as active_contracts
         from subscribers s
         where ($1::text is null or s.name ilike '%'||$1||'%' or s.email ilike '%'||$1||'%' or ($2 <> '' and (s.document like '%'||$2||'%' or s.phone like '%'||$2||'%')))
           and ($3::text is null or s.status = $3)
         order by s.name, s.id`, [q.q || null, digits, q.status ?? null], q);
    });
  });

  app.get('/api/subscribers/:id', { preHandler: guard('subscribers:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const s = (await c.query('select * from subscribers where id = $1', [id])).rows[0];
      if (!s) throw new HttpError(404, 'assinante não encontrado');
      s.contracts = (await c.query(`${CONTRACT_SELECT} where c.subscriber_id = $1 order by c.created_at desc`, [id])).rows;
      return s;
    });
  });

  app.post('/api/subscribers', { preHandler: guard('subscribers:write') }, async (req) => {
    const b = zSubscriber.parse(req.body) as Record<string, unknown>;
    return withScope(req.ctx.scope, async (c) => {
      const s = (await c.query(
        `insert into subscribers (tenant_id, ${SUB_COLS.join(', ')}) values ($1, ${SUB_COLS.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
        [req.ctx.tenantId, ...SUB_COLS.map((k) => b[k])])).rows[0];
      await audit(c, req.ctx, 'subscriber.create', 'subscriber', s.id);
      return s;
    });
  });

  app.patch('/api/subscribers/:id', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zSubscriber.parse(req.body) as Record<string, unknown>;
    return withScope(req.ctx.scope, async (c) => {
      const s = (await c.query(
        `update subscribers set ${SUB_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
        [id, ...SUB_COLS.map((k) => b[k])])).rows[0];
      if (!s) throw new HttpError(404, 'assinante não encontrado');
      await audit(c, req.ctx, 'subscriber.update', 'subscriber', id);
      return s;
    });
  });

  // ---- Planos ----
  const zVersion = z.object({
    price_cents: z.number().int().min(0).max(100_000_00),
    down_kbps: z.number().int().positive(), up_kbps: z.number().int().positive(),
    profile_name: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,60}$/, 'perfil: letras, números, _ . -'),
  });

  app.get('/api/plans', { preHandler: guard('plans:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select p.*, pv.id as version_id, pv.version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name, pv.valid_from,
                (select count(*) from contracts c join plan_versions x on x.id = c.plan_version_id where x.plan_id = p.id and c.status = 'active') as active_contracts
         from plans p join lateral (select * from plan_versions v where v.plan_id = p.id order by version desc limit 1) pv on true
         order by p.active desc, p.name`)).rows));

  app.get('/api/plans/:id/versions', { preHandler: guard('plans:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select v.*, (select count(*) from contracts c where c.plan_version_id = v.id) as contracts
         from plan_versions v where v.plan_id = $1 order by version desc`, [zUuid.parse((req.params as any).id)])).rows));

  app.post('/api/plans', { preHandler: guard('plans:write') }, async (req) => {
    const b = zVersion.extend({ name: z.string().trim().min(2).max(100) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query('insert into plans (tenant_id, name) values ($1,$2) returning *', [req.ctx.tenantId, b.name])).rows[0];
      await c.query(`insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values ($1,$2,1,$3,$4,$5,$6)`,
        [req.ctx.tenantId, p.id, b.price_cents, b.down_kbps, b.up_kbps, b.profile_name]);
      await audit(c, req.ctx, 'plan.create', 'plan', p.id, b);
      return p;
    });
  });

  // Alterar preço/velocidade cria nova versão; contratos existentes preservam a versão contratada.
  app.post('/api/plans/:id/versions', { preHandler: guard('plans:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zVersion.parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query('select id from plans where id = $1 for update', [id])).rows[0];
      if (!p) throw new HttpError(404, 'plano não encontrado');
      const v = (await c.query(
        `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name)
         select $1, $2, coalesce(max(version),0)+1, $3,$4,$5,$6 from plan_versions where plan_id = $2 returning *`,
        [req.ctx.tenantId, id, b.price_cents, b.down_kbps, b.up_kbps, b.profile_name])).rows[0];
      await audit(c, req.ctx, 'plan.new_version', 'plan', id, { version: v.version, ...b });
      return v;
    });
  });

  /** Degraus de inadimplência do plano (não versionados: política de cobrança, não preço). Vazio = vale a política do provedor. */
  app.put('/api/plans/:id/dunning', { preHandler: guard('plans:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const d = z.number().int().min(0).max(365).nullable();
    const b = z.object({ warn_after_days: d, reduce_after_days: d, block_after_days: d,
      reduced_profile: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,60}$/, 'perfil: letras, números, _ . - (até 60)').nullable() }).parse(req.body);
    const [w, r, bl] = [b.warn_after_days, b.reduce_after_days, b.block_after_days];
    if ((w != null && r != null && w > r) || (r != null && bl != null && r > bl) || (w != null && bl != null && w > bl))
      throw new HttpError(400, 'os dias devem crescer: aviso ≤ redução ≤ bloqueio');
    if (r != null && !b.reduced_profile) throw new HttpError(400, 'informe o perfil de velocidade reduzida que existe no concentrador');
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(
        `update plans set warn_after_days = $2, reduce_after_days = $3, block_after_days = $4, reduced_profile = $5 where id = $1 returning id, name, warn_after_days, reduce_after_days, block_after_days, reduced_profile`,
        [id, w, r, bl, r != null ? b.reduced_profile : (b.reduced_profile || null)])).rows[0];
      if (!p) throw new HttpError(404, 'plano não encontrado');
      await audit(c, req.ctx, 'plan.dunning', 'plan', id, b);
      return p;
    });
  });

  app.patch('/api/plans/:id', { preHandler: guard('plans:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(2).max(100).optional(), active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query('update plans set name = coalesce($2,name), active = coalesce($3,active) where id = $1 returning *',
        [id, b.name ?? null, b.active ?? null])).rows[0];
      if (!p) throw new HttpError(404, 'plano não encontrado');
      await audit(c, req.ctx, 'plan.update', 'plan', id, b);
      return p;
    });
  });

  // ---- Contratos ----
  app.get('/api/contracts', { preHandler: guard('contracts:read') }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().optional(), status: z.enum(['active', 'ended']).optional(), tag: zUuid.optional(), company_id: zUuid.optional(), format: z.string().optional(), ...zPage }).parse(req.query);
    const cap = q.format === 'csv' ? 5000 : 500;
    const limit = Math.min(q.limit ?? cap, cap), offset = q.offset ?? 0;
    return withScope(req.ctx.scope, async (c) => {
      // filtros só sobre `contracts` (a página sai do índice); nome do assinante, plano e etiquetas entram depois, só para as linhas da página
      const where = `($2::text is null or c.status = $2)
        and ($3::uuid is null or exists (select 1 from contract_tags x where x.contract_id = c.id and x.tag_id = $3))
        and ($4::uuid is null or c.company_id = $4)
        and ($1::text is null or c.subscriber_id in (select s.id from subscribers s where s.name ilike '%' || $1 || '%')
             or c.plan_version_id in (select pv.id from plan_versions pv join plans p on p.id = pv.plan_id where p.name ilike '%' || $1 || '%'))`;
      const params = [q.q || null, q.status ?? null, q.tag ?? null, q.company_id ?? null];
      const rows = (await c.query(
        `select c.*, s.name as subscriber_name, s.document as subscriber_document,
                p.id as plan_id, p.name as plan_name, pv.version as plan_version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name,
                coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name) from contract_tags ct join tags t on t.id = ct.tag_id where ct.contract_id = c.id), '[]') as tags
         from (select * from contracts c where ${where} order by c.created_at desc, c.id limit ${limit} offset ${offset}) c
         join subscribers s on s.id = c.subscriber_id join plan_versions pv on pv.id = c.plan_version_id join plans p on p.id = pv.plan_id
         order by c.created_at desc, c.id`, params)).rows;
      const total = offset === 0 && rows.length < limit ? rows.length : Number((await c.query(`select count(*) as n from contracts c where ${where}`, params)).rows[0].n);
      reply.header('x-total-count', String(total));
      return rows;
    });
  });

  app.get('/api/contracts/:id', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query(`${CONTRACT_SELECT} where c.id = $1`, [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      k.history = (await c.query(
        `select h.at, h.event, h.detail, u.name as actor_name from contract_history h left join users u on u.id = h.actor_id
         where h.contract_id = $1 order by h.id desc`, [id])).rows;
      return k;
    });
  });

  app.post('/api/contracts', { preHandler: guard('contracts:write') }, async (req) => {
    const b = z.object({
      subscriber_id: zUuid, plan_id: zUuid, due_day: z.number().int().min(1).max(28),
      start_date: zDate.optional(), notes: z.string().trim().max(2000).nullish(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const sub = (await c.query('select status from subscribers where id = $1', [b.subscriber_id])).rows[0];
      if (!sub) throw new HttpError(400, 'assinante não encontrado');
      if (sub.status !== 'active') throw new HttpError(400, 'assinante inativo');
      const v = await currentVersion(c, b.plan_id);
      const lp = (await c.query('select loyalty_months, penalty_model, penalty_cents from plans where id = $1', [b.plan_id])).rows[0];   // carência padrão do plano
      const k = (await c.query(
        `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, start_date, notes, loyalty_until, penalty_model, penalty_cents)
         values ($1,$2,$3,$4,coalesce($5::date, current_date),$6,
                 case when $7::int is null then null else coalesce($5::date, current_date) + make_interval(months => $7::int) end, $8, $9) returning *`,
        [req.ctx.tenantId, b.subscriber_id, v.id, b.due_day, b.start_date ?? null, b.notes || null, lp?.loyalty_months ?? null, lp?.penalty_model ?? null, lp?.penalty_cents ?? null])).rows[0];
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,'created',$4)`,
        [req.ctx.tenantId, k.id, req.ctx.userId, JSON.stringify({ plan: v.name, plan_version: v.version, due_day: b.due_day })]);
      await audit(c, req.ctx, 'contract.create', 'contract', k.id);
      return k;
    });
  });

  app.patch('/api/contracts/:id', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zContractChange.parse(req.body);
    if ((b.end_reason_id || b.end_note || b.penalty) && !b.end) throw new HttpError(400, 'motivo e multa só valem junto com o encerramento');
    return withScope(req.ctx.scope, async (c) => {
      await changeContract(c, req.ctx, id, b);
      return (await c.query(`${CONTRACT_SELECT} where c.id = $1`, [id])).rows[0];
    });
  });

  app.get('/api/dashboard', { preHandler: guard('subscribers:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select (select count(*) from subscribers where status = 'active') as subscribers,
                (select count(*) from contracts where status = 'active') as contracts,
                (select count(*) from plans where active) as plans,
                (select coalesce(sum(pv.price_cents),0) from contracts c join plan_versions pv on pv.id = c.plan_version_id where c.status = 'active') as mrr_cents`)).rows[0]));
}

export { contractChangeHooks };
