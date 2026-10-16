import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * LGPD, direitos do titular: cópia dos dados (acesso) e anonimização (eliminação, com a retenção legal).
 * Só o administrador do provedor (`settings:manage`). O provedor é o controlador: este recurso só dá a ferramenta;
 * a decisão de atender, os prazos e a base legal de cada retenção são dele e do jurídico dele.
 */
export async function lgpdRoutes(app: FastifyInstance) {
  app.get('/api/subscribers/:id/lgpd-export', { preHandler: guard('settings:manage') }, async (req, reply) => {
    const id = zUuid.parse((req.params as any).id);
    const out = await withScope(req.ctx.scope, async (c) => {
      const s = (await c.query('select * from subscribers where id = $1', [id])).rows[0];
      if (!s) throw new HttpError(404, 'assinante não encontrado');
      const q = async (sql: string) => (await c.query(sql, [id])).rows;
      const data = {
        generated_at: new Date().toISOString(),
        note: 'Cópia dos dados pessoais deste titular mantidos pelo provedor. Não inclui o que pertence a terceiros nem segredos de acesso.',
        subscriber: s,
        contacts: await q('select kind, value, label, purpose, allow_notices, created_at from subscriber_contacts where subscriber_id = $1 order by created_at'),
        contracts: await q(`select k.id, k.status, k.start_date, k.end_date, k.due_day, k.install_street, k.install_number, k.install_district, k.install_city, k.install_state,
                                   k.install_zip, k.latitude::float8 as latitude, k.longitude::float8 as longitude, p.name as plan, pv.price_cents
                            from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id where k.subscriber_id = $1 order by k.created_at`),
        invoices: await q(`select competence, due_date, amount_cents, status, kind, paid_at, created_at from invoices where subscriber_id = $1 order by due_date`),
        tickets: await q(`select t.number, t.subject, t.category, t.status, t.created_at,
                                 (select coalesce(json_agg(json_build_object('at', m.at, 'from', m.author_kind, 'body', m.body) order by m.id), '[]')
                                  from ticket_messages m where m.ticket_id = t.id and not m.internal) as messages
                          from tickets t where t.subscriber_id = $1 order by t.created_at`),
        work_orders: await q(`select number, kind, status, description, resolution, address_text, created_at, finished_at from work_orders where subscriber_id = $1 order by created_at`),
        notes: await q(`select body, alert, created_at from subscriber_notes where subscriber_id = $1 order by created_at`),
        documents: await q(`select kind, name, mime, size_bytes, created_at, deleted_at from documents where subscriber_id = $1 order by created_at`),
        acceptances: await q(`select title, body, status, requested_at, accepted_at, accepted_ip from acceptances where subscriber_id = $1 order by requested_at`),
        connections: await q(`select s.started_at, s.stopped_at, s.ip, s.mac, s.nas_ip, s.bytes_in, s.bytes_out, s.terminate_cause
                              from service_sessions s join service_resources r on r.id = s.resource_id join contracts k on k.id = r.contract_id
                              where k.subscriber_id = $1 order by s.started_at desc limit 5000`),
        portal_access: await q(`select email, active, created_at from users where subscriber_id = $1`),
      };
      await audit(c, req.ctx, 'subscriber.lgpd_export', 'subscriber', id, {});
      return data;
    });
    reply.header('content-disposition', `attachment; filename="dados-do-titular-${id.slice(0, 8)}.json"`);
    return out;
  });

  app.post('/api/subscribers/:id/anonymize', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      reason: z.string().trim().min(5, 'informe o motivo (pedido do titular, protocolo…)').max(300),
      confirm_name: z.string().trim().min(1),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const s = (await c.query('select name from subscribers where id = $1', [id])).rows[0];
      if (!s) throw new HttpError(404, 'assinante não encontrado');
      if (s.name.trim().toLowerCase() !== b.confirm_name.toLowerCase()) throw new HttpError(400, 'o nome digitado não confere com o do assinante');
      try {
        const counts = (await c.query('select lgpd_anonymize_subscriber($1, $2, $3) as r', [id, b.reason, req.ctx.userId])).rows[0].r;
        return { anonymized: true, counts };
      } catch (e: any) {
        if (e.code === 'P0001') throw new HttpError(409, e.message);
        throw e;
      }
    });
  });

  // ---- Retenção de dados do provedor ----
  const env = (n: string, d: number) => Number(process.env[n]) || d;
  app.get('/api/settings/retention', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const s = (await c.query('select retention_auth_log_days, retention_sessions_days, retention_notice_log_days from tenant_settings where tenant_id = $1', [req.ctx.tenantId])).rows[0] ?? {};
      return {
        auth_log_days: s.retention_auth_log_days ?? null, sessions_days: s.retention_sessions_days ?? null, notice_log_days: s.retention_notice_log_days ?? null,
        defaults: { auth_log_days: env('NEXO_RADIUS_LOG_DAYS', 30), sessions_days: env('NEXO_SESSION_KEEP_DAYS', 400), notice_log_days: env('NEXO_NOTICE_LOG_DAYS', 400) },
        limits: { auth_log_days: [7, 365], sessions_days: [365, 1825], notice_log_days: [30, 1825] },
        kept: 'Faturas, pagamentos, aceites e auditoria não são apagados pela rotina.',
      };
    }));
  app.put('/api/settings/retention', { preHandler: guard('settings:manage') }, async (req) => {
    const d = (min: number, max: number, msg: string) => z.number().int().min(min, msg).max(max, msg).nullable();
    const b = z.object({
      auth_log_days: d(7, 365, 'log de autenticação: de 7 a 365 dias'),
      sessions_days: d(365, 1825, 'registro de conexões: de 365 (mínimo do Marco Civil) a 1825 dias'),
      notice_log_days: d(30, 1825, 'registro de avisos: de 30 a 1825 dias'),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      await c.query('insert into tenant_settings (tenant_id) values ($1) on conflict (tenant_id) do nothing', [req.ctx.tenantId]);
      await c.query('update tenant_settings set retention_auth_log_days = $2, retention_sessions_days = $3, retention_notice_log_days = $4 where tenant_id = $1',
        [req.ctx.tenantId, b.auth_log_days, b.sessions_days, b.notice_log_days]);
      await audit(c, req.ctx, 'settings.retention', 'tenant_settings', req.ctx.tenantId, b);
      return b;
    });
  });
}
