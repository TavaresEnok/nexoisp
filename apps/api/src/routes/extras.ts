import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

const zWhen = z.string().datetime({ offset: true });

export async function extraRoutes(app: FastifyInstance) {
  // ---- Etiquetas de contrato ----
  app.get('/api/tags', { preHandler: guard('contracts:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`select t.id, t.name, (select count(*) from contract_tags x where x.tag_id = t.id)::int as contracts from tags t order by t.name`)).rows));

  app.post('/api/tags', { preHandler: guard('contracts:write') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(40) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query(`insert into tags (tenant_id, name) values ($1,$2) on conflict (tenant_id, name) do nothing returning id, name`, [req.ctx.tenantId, b.name])).rows[0];
      if (!t) throw new HttpError(409, 'já existe uma etiqueta com este nome');
      await audit(c, req.ctx, 'tag.create', 'tag', t.id, { name: b.name });
      return t;
    });
  });

  app.delete('/api/tags/:id', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('delete from tags where id = $1 returning name', [id]);
      if (!r.rowCount) throw new HttpError(404, 'etiqueta não encontrada');
      await audit(c, req.ctx, 'tag.delete', 'tag', id, { name: r.rows[0].name });
      return { ok: true };
    });
  });

  /** Define o conjunto de etiquetas do contrato (substitui o anterior). */
  app.put('/api/contracts/:id/tags', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ tag_ids: z.array(zUuid).max(30) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from contracts where id = $1', [id])).rowCount) throw new HttpError(404, 'contrato não encontrado');
      const ids = [...new Set(b.tag_ids)];
      if (ids.length && (await c.query('select count(*)::int as n from tags where id = any($1::uuid[])', [ids])).rows[0].n !== ids.length)
        throw new HttpError(400, 'alguma etiqueta não existe');
      await c.query('delete from contract_tags where contract_id = $1', [id]);
      for (const t of ids) await c.query('insert into contract_tags (tenant_id, contract_id, tag_id) values ($1,$2,$3)', [req.ctx.tenantId, id, t]);
      await audit(c, req.ctx, 'contract.tags', 'contract', id, { tag_ids: ids });
      return (await c.query(`select t.id, t.name from contract_tags ct join tags t on t.id = ct.tag_id where ct.contract_id = $1 order by t.name`, [id])).rows;
    });
  });

  // ---- Avisos de manutenção ao assinante ----
  const SELECT = `select m.*, d.name as device_name, u.name as created_by_name,
      case when m.canceled_at is not null then 'canceled' when now() < m.starts_at then 'scheduled' when now() <= m.ends_at then 'active' else 'ended' end as state,
      case when m.device_id is null
        then (select count(distinct subscriber_id) from contracts where status = 'active')
        else (select count(distinct k.subscriber_id) from service_resources r join contracts k on k.id = r.contract_id where k.status = 'active' and r.device_id = m.device_id)
      end::int as affected_subscribers
    from maintenance_notices m left join devices d on d.id = m.device_id left join users u on u.id = m.created_by`;

  app.get('/api/maintenance-notices', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${SELECT} order by m.starts_at desc limit 100`)).rows));

  app.post('/api/maintenance-notices', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({
      title: z.string().trim().min(3).max(120), message: z.string().trim().min(3).max(1000), severity: z.enum(['info', 'degraded', 'outage']).default('info'),
      device_id: zUuid.nullish(), starts_at: zWhen, ends_at: zWhen,
    }).parse(req.body);
    if (new Date(b.ends_at) <= new Date(b.starts_at)) throw new HttpError(400, 'o fim deve ser depois do início');
    return withScope(req.ctx.scope, async (c) => {
      if (b.device_id && !(await c.query('select 1 from devices where id = $1', [b.device_id])).rowCount) throw new HttpError(400, 'equipamento não encontrado');
      const m = (await c.query(
        `insert into maintenance_notices (tenant_id, title, message, severity, device_id, starts_at, ends_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [req.ctx.tenantId, b.title, b.message, b.severity, b.device_id ?? null, b.starts_at, b.ends_at, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'maintenance_notice.create', 'maintenance_notice', m.id, { title: b.title, device_id: b.device_id ?? null });
      return (await c.query(`${SELECT} where m.id = $1`, [m.id])).rows[0];
    });
  });

  app.post('/api/maintenance-notices/:id/cancel', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('update maintenance_notices set canceled_at = now() where id = $1 and canceled_at is null and ends_at > now() returning id', [id]);
      if (!r.rowCount) throw new HttpError(400, 'aviso não encontrado, já cancelado ou já encerrado');
      await audit(c, req.ctx, 'maintenance_notice.cancel', 'maintenance_notice', id);
      return { ok: true };
    });
  });
}
