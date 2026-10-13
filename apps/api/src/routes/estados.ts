import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { assertCatalog } from '../sla.js';
import { zUuid } from '../validators.js';

/**
 * D6/D7/D8: situação do contrato em três eixos separados (comercial × acesso × velocidade), com motivo, modo e data;
 * restrição de crédito; anotações estruturadas com alerta ao abrir a ficha.
 */
export async function estadosRoutes(app: FastifyInstance) {
  app.get('/api/contracts/:id/states', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query(
        `select k.status, k.start_date, k.end_date, k.end_note, k.credit_restricted_at, e.name as end_reason,
                r.id as resource_id, r.desired_version, r.desired_policy, r.desired_stage, r.desired_reason, r.desired_at,
                r.observed_version, r.observed_policy,
                (select o.authorization_ref->>'type' from operations o where o.resource_id = r.id and o.action <> 'subscriber.disconnect'
                  order by o.created_at desc limit 1) as by_type
         from contracts k left join catalog_items e on e.id = k.end_reason_id
         left join service_resources r on r.contract_id = k.id and r.desired_version > 0
         where k.id = $1`, [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      const mode = k.by_type === 'user' ? 'manual' : k.by_type ? 'automatic' : null;
      const financial = /inadimpl/i.test(k.desired_reason ?? '');
      // acesso: o que o sistema pediu ao equipamento; "applied" diz se o equipamento já confirmou
      let access: string, speed = 'normal';
      if (k.status === 'ended') access = 'blocked';
      else if (!k.resource_id) access = 'no_account';
      else if (k.desired_policy === 'suspended' && k.desired_stage === 'reduced') { access = 'active'; speed = 'reduced'; }
      else if (k.desired_policy === 'suspended') access = 'blocked';
      else access = 'active';
      return {
        commercial: {
          state: k.status === 'ended' ? 'ended' : k.credit_restricted_at ? 'credit_restricted' : 'active',
          start_date: k.start_date, end_date: k.end_date, end_reason: k.end_reason, end_note: k.end_note, credit_restricted_at: k.credit_restricted_at,
        },
        access: {
          state: access, mode: k.status === 'ended' ? null : mode, cause: k.status === 'ended' ? 'contract_ended' : access === 'blocked' || speed === 'reduced' ? (financial ? 'financial' : 'other') : null,
          reason: k.status === 'ended' ? null : k.desired_reason, since: k.desired_at,
          applied: k.resource_id ? k.observed_version === k.desired_version && k.observed_policy === k.desired_policy : null,
        },
        speed: { state: speed },
      };
    });
  });

  // Restrição de crédito: informação comercial; não bloqueia o acesso por si.
  app.put('/api/contracts/:id/credit-restriction', { preHandler: guard('finance:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ restricted: z.boolean(), note: z.string().trim().min(3).max(300) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update contracts set credit_restricted_at = case when $2 then coalesce(credit_restricted_at, now()) end, updated_at = now() where id = $1 and status = 'active' returning credit_restricted_at`,
        [id, b.restricted])).rows[0];
      if (!r) throw new HttpError(404, 'contrato ativo não encontrado');
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,$4,$5)`,
        [req.ctx.tenantId, id, req.ctx.userId, b.restricted ? 'credit_restricted' : 'credit_released', JSON.stringify({ note: b.note })]);
      await audit(c, req.ctx, b.restricted ? 'contract.credit_restrict' : 'contract.credit_release', 'contract', id, { note: b.note });
      return { credit_restricted_at: r.credit_restricted_at };
    });
  });

  // ---------------------------------------------------------------- anotações
  app.get('/api/subscribers/:id/notes', { preHandler: guard('subscribers:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const q = z.object({ archived: z.enum(['1']).optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select n.id, n.body, n.alert, n.contract_id, n.type_id, t.name as type_name, n.created_at, n.archived_at, u.name as created_by_name
         from subscriber_notes n left join catalog_items t on t.id = n.type_id left join users u on u.id = n.created_by
         where n.subscriber_id = $1 and ($2::boolean or n.archived_at is null) order by n.alert desc, n.created_at desc limit 200`, [id, !!q.archived])).rows);
  });

  app.post('/api/subscribers/:id/notes', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ body: z.string().trim().min(1).max(2000), alert: z.boolean().default(false), contract_id: zUuid.nullish(), type_id: zUuid.nullish() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [id])).rowCount) throw new HttpError(404, 'assinante não encontrado');
      if (b.contract_id && !(await c.query('select 1 from contracts where id = $1 and subscriber_id = $2', [b.contract_id, id])).rowCount)
        throw new HttpError(400, 'o contrato não pertence a este assinante');
      await assertCatalog(c, b.type_id, 'note_type', 'tipo de anotação');
      const r = (await c.query(
        `insert into subscriber_notes (tenant_id, subscriber_id, contract_id, type_id, body, alert, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.ctx.tenantId, id, b.contract_id ?? null, b.type_id ?? null, b.body, b.alert, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'subscriber.note', 'subscriber', id, { note_id: r.id, alert: b.alert });
      return r;
    });
  });

  app.patch('/api/notes/:id', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ archived: z.boolean().optional(), alert: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update subscriber_notes set alert = coalesce($3, alert),
                archived_at = case when $2::boolean is null then archived_at when $2 then coalesce(archived_at, now()) end where id = $1 returning *`,
        [id, b.archived ?? null, b.alert ?? null])).rows[0];
      if (!r) throw new HttpError(404, 'anotação não encontrada');
      await audit(c, req.ctx, 'subscriber.note_update', 'subscriber_note', id, b);
      return r;
    });
  });
}
