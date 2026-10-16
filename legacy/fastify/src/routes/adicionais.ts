import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * Produtos adicionais recorrentes do contrato. Valem da competência de início (1º dia do mês; sem data, o mês seguinte, pois a fatura do mês corrente já foi gerada) até antes da competência de término;
 * cada mês cobrado vira uma linha da mensalidade. Mudar o preço do produto não muda o que já foi combinado (o preço é congelado no contrato).
 */
const monthStart = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-01)?$/, 'competência inválida (AAAA-MM)').transform((v) => (v.length === 7 ? `${v}-01` : v));

export async function adicionaisRoutes(app: FastifyInstance) {
  app.get('/api/addons', { preHandler: guard('plans:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select p.id, p.name, p.price_cents, p.active, (select count(*)::int from contract_addons a where a.product_id = p.id and a.ended_competence is null) as in_use
         from addon_products p order by p.active desc, p.name`)).rows));

  app.post('/api/addons', { preHandler: guard('plans:write') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), price_cents: z.number().int().min(0).max(100_000_000) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('insert into addon_products (tenant_id, name, price_cents) values ($1,$2,$3) returning *', [req.ctx.tenantId, b.name, b.price_cents])).rows[0];
      await audit(c, req.ctx, 'addon.create', 'addon', r.id, b);
      return r;
    });
  });

  app.patch('/api/addons/:id', { preHandler: guard('plans:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ price_cents: z.number().int().min(0).max(100_000_000).optional(), active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        'update addon_products set price_cents = coalesce($2, price_cents), active = coalesce($3, active) where id = $1 returning *', [id, b.price_cents ?? null, b.active ?? null])).rows[0];
      if (!r) throw new HttpError(404, 'produto não encontrado');
      await audit(c, req.ctx, 'addon.update', 'addon', id, b);
      return r;   // o preço novo vale para contratações futuras; as existentes mantêm o combinado
    });
  });

  app.get('/api/contracts/:id/addons', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select a.id, a.product_id, a.description, a.quantity, a.unit_price_cents, to_char(a.from_competence, 'YYYY-MM') as from_competence,
                to_char(a.ended_competence, 'YYYY-MM') as ended_competence,
                (a.ended_competence is null or a.ended_competence > date_trunc('month', now())::date) as current
         from contract_addons a where a.contract_id = $1 order by a.from_competence desc, a.created_at desc`, [id])).rows);
  });

  app.post('/api/contracts/:id/addons', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      product_id: zUuid, quantity: z.number().int().min(1).max(99).default(1),
      unit_price_cents: z.number().int().min(0).max(100_000_000).optional(), from_competence: monthStart.optional(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query(`select status from contracts where id = $1`, [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      if (k.status !== 'active') throw new HttpError(409, 'contrato encerrado não recebe produtos adicionais');
      const p = (await c.query('select name, price_cents, active from addon_products where id = $1', [b.product_id])).rows[0];
      if (!p || !p.active) throw new HttpError(400, 'produto não encontrado ou inativo');
      const r = (await c.query(
        `insert into contract_addons (tenant_id, contract_id, product_id, description, quantity, unit_price_cents, from_competence, created_by)
         values ($1,$2,$3,$4,$5,$6, coalesce($7::date, (date_trunc('month', now()) + interval '1 month')::date), $8) returning id`,
        [req.ctx.tenantId, id, b.product_id, p.name, b.quantity, b.unit_price_cents ?? p.price_cents, b.from_competence ?? null, req.ctx.userId])).rows[0];
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,'addon_added',$4)`,
        [req.ctx.tenantId, id, req.ctx.userId, JSON.stringify({ product: p.name, quantity: b.quantity })]);
      await audit(c, req.ctx, 'contract.addon_add', 'contract', id, { addon_id: r.id, product: p.name });
      return { id: r.id };
    });
  });

  /** Encerra o adicional: não é cobrado a partir da competência informada (padrão: o próximo mês). */
  app.delete('/api/contracts/:id/addons/:addonId', { preHandler: guard('contracts:write') }, async (req) => {
    const p = z.object({ id: zUuid, addonId: zUuid }).parse(req.params);
    const b = z.object({ ended_competence: monthStart.optional() }).parse(req.body ?? {});
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update contract_addons set ended_competence = coalesce($3::date, (date_trunc('month', now()) + interval '1 month')::date)
         where id = $1 and contract_id = $2 and ended_competence is null and coalesce($3::date, (date_trunc('month', now()) + interval '1 month')::date) >= from_competence
         returning id, description`, [p.addonId, p.id, b.ended_competence ?? null])).rows[0];
      if (!r) throw new HttpError(409, 'adicional não encontrado, já encerrado ou com término antes do início');
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,'addon_ended',$4)`,
        [req.ctx.tenantId, p.id, req.ctx.userId, JSON.stringify({ product: r.description })]);
      await audit(c, req.ctx, 'contract.addon_end', 'contract', p.id, { addon_id: p.addonId });
      return { ok: true };
    });
  });
}
