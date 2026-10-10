import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { paged, withScope } from '../db.js';
import { zDate, zPage, zSubscriber, zUuid } from '../validators.js';

const SUB_COLS = ['name', 'document', 'email', 'phone', 'address_street', 'address_number', 'address_district',
  'address_city', 'address_state', 'address_zip', 'notes', 'status'] as const;

export const CONTRACT_SELECT = `
  select c.*, s.name as subscriber_name, s.document as subscriber_document,
         p.id as plan_id, p.name as plan_name, pv.version as plan_version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name
  from contracts c
  join subscribers s on s.id = c.subscriber_id
  join plan_versions pv on pv.id = c.plan_version_id
  join plans p on p.id = pv.plan_id`;

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
    const q = z.object({ q: z.string().trim().optional(), status: z.enum(['active', 'ended']).optional(), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      paged(c, reply,
        `${CONTRACT_SELECT} where ($1::text is null or s.name ilike '%'||$1||'%' or p.name ilike '%'||$1||'%')
           and ($2::text is null or c.status = $2) order by c.created_at desc, c.id`, [q.q || null, q.status ?? null], q));
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

  async function currentVersion(c: any, planId: string) {
    const v = (await c.query(
      `select v.id, v.version, p.active, p.name from plans p join plan_versions v on v.plan_id = p.id where p.id = $1 order by v.version desc limit 1`, [planId])).rows[0];
    if (!v) throw new HttpError(400, 'plano não encontrado');
    if (!v.active) throw new HttpError(400, 'plano inativo não aceita novos contratos');
    return v;
  }

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
      const k = (await c.query(
        `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, start_date, notes)
         values ($1,$2,$3,$4,coalesce($5::date, current_date),$6) returning *`,
        [req.ctx.tenantId, b.subscriber_id, v.id, b.due_day, b.start_date ?? null, b.notes || null])).rows[0];
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,'created',$4)`,
        [req.ctx.tenantId, k.id, req.ctx.userId, JSON.stringify({ plan: v.name, plan_version: v.version, due_day: b.due_day })]);
      await audit(c, req.ctx, 'contract.create', 'contract', k.id);
      return k;
    });
  });

  app.patch('/api/contracts/:id', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      plan_id: zUuid.optional(), due_day: z.number().int().min(1).max(28).optional(),
      notes: z.string().trim().max(2000).nullish(), end: z.boolean().optional(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query(`${CONTRACT_SELECT} where c.id = $1 for update of c`, [id])).rows[0];
      if (!cur) throw new HttpError(404, 'contrato não encontrado');
      if (cur.status === 'ended') throw new HttpError(400, 'contrato encerrado não pode ser alterado');
      const hist = async (event: string, detail: object) =>
        c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,$4,$5)`,
          [req.ctx.tenantId, id, req.ctx.userId, event, JSON.stringify(detail)]);
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
        await c.query(`update contracts set status = 'ended', end_date = current_date, updated_at = now() where id = $1`, [id]);
        await hist('ended', {});
      }
      await audit(c, req.ctx, b.end ? 'contract.end' : 'contract.update', 'contract', id, b);
      for (const h of contractChangeHooks) await h(c, req.ctx, id);
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

/** Módulos posteriores (rede) reagem a mudanças de contrato na mesma transação. */
export const contractChangeHooks: Array<(c: any, ctx: any, contractId: string) => Promise<void>> = [];
