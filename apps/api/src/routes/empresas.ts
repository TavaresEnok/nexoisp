import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * Multiempresa. A empresa de um contrato vale para as faturas geradas dali em diante; as já emitidas ficam com a empresa
 * que tinham. Sem empresa no contrato, vale a empresa padrão (se houver).
 */
const zCnpj = z.string().trim().transform((v) => v.replace(/\D/g, '')).refine((v) => v === '' || v.length === 14, 'CNPJ deve ter 14 dígitos')
  .transform((v) => v || null);

export async function empresasRoutes(app: FastifyInstance) {
  app.get('/api/companies', { preHandler: guard('contracts:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select d.id, d.name, d.document, d.is_default, d.active,
                (select count(*)::int from contracts k where k.company_id = d.id) as contracts
         from companies d order by d.is_default desc, d.name`)).rows));

  app.post('/api/companies', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), document: zCnpj.optional(), is_default: z.boolean().default(false) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.is_default) await c.query('update companies set is_default = false where is_default');
      const n = (await c.query('select count(*)::int as n from companies')).rows[0].n;
      const r = (await c.query(
        `insert into companies (tenant_id, name, document, is_default) values ($1,$2,$3,$4) returning id, name, document, is_default, active`,
        [req.ctx.tenantId, b.name, b.document ?? null, b.is_default || n === 0])).rows[0];   // a primeira empresa é a padrão
      await audit(c, req.ctx, 'company.create', 'company', r.id, { name: r.name });
      return r;
    });
  });

  app.patch('/api/companies/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), document: zCnpj.optional(), is_default: z.literal(true).optional(), active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select * from companies where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'empresa não encontrada');
      if (b.active === false && cur.is_default) throw new HttpError(409, 'a empresa padrão não pode ser desativada: escolha outra como padrão antes');
      if (b.is_default) await c.query('update companies set is_default = false where is_default and id <> $1', [id]);
      const r = (await c.query(
        `update companies set name = coalesce($2, name), document = case when $3::boolean then $4 else document end,
                is_default = coalesce($5, is_default), active = coalesce($6, active)
         where id = $1 returning id, name, document, is_default, active`,
        [id, b.name ?? null, b.document !== undefined, b.document ?? null, b.is_default ?? null, b.active ?? null])).rows[0];
      await audit(c, req.ctx, 'company.update', 'company', id, b);
      return r;
    });
  });

  app.put('/api/contracts/:id/company', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ company_id: zUuid.nullable() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.company_id && !(await c.query('select 1 from companies where id = $1 and active', [b.company_id])).rowCount)
        throw new HttpError(400, 'empresa não encontrada ou inativa');
      const r = (await c.query('update contracts set company_id = $2 where id = $1 returning id', [id, b.company_id])).rows[0];
      if (!r) throw new HttpError(404, 'contrato não encontrado');
      await audit(c, req.ctx, 'contract.company', 'contract', id, b);
      return b;
    });
  });
}
