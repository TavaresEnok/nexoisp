import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, hashPassword, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

export async function portalRoutes(app: FastifyInstance) {
  // Equipe cria/redefine o acesso do assinante ao portal.
  app.post('/api/subscribers/:id/portal-access', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ email: z.string().email(), password: z.string().min(8, 'senha deve ter ao menos 8 caracteres').max(200) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const s = (await c.query('select name from subscribers where id = $1', [id])).rows[0];
      if (!s) throw new HttpError(404, 'assinante não encontrado');
      const u = (await c.query(
        `insert into users (tenant_id, email, name, password_hash, role, subscriber_id) values ($1,$2,$3,$4,'subscriber',$5)
         on conflict (subscriber_id) where subscriber_id is not null do update set email = excluded.email, password_hash = excluded.password_hash, active = true
         returning id, email`, [req.ctx.tenantId, b.email, s.name, hashPassword(b.password), id])).rows[0];
      await audit(c, req.ctx, 'subscriber.portal_access', 'subscriber', id, { email: b.email });
      return u;
    });
  });

  app.get('/api/subscribers/:id/portal-access', { preHandler: guard('subscribers:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query('select email, active from users where subscriber_id = $1', [zUuid.parse((req.params as any).id)])).rows[0] ?? null));

  // Portal: tudo parte do assinante da sessão; nenhum identificador vem do navegador.
  app.get('/api/portal/overview', { preHandler: guard('portal:self') }, async (req) => {
    const sid = req.ctx.subscriberId;
    if (!sid) throw new HttpError(403, 'sessão sem assinante');
    return withScope(req.ctx.scope, async (c) => {
      const subscriber = (await c.query('select name, document, email, phone, address_street, address_number, address_city, address_state from subscribers where id = $1', [sid])).rows[0];
      const contracts = (await c.query(
        `select k.id, k.status, k.due_day, k.start_date, p.name as plan_name, pv.price_cents, pv.down_kbps, pv.up_kbps,
                r.desired_policy, r.desired_version, r.observed_version, r.observed_policy, r.pppoe_username
         from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
         left join service_resources r on r.contract_id = k.id and r.desired_version > 0
         where k.subscriber_id = $1 order by k.status, k.created_at desc`, [sid])).rows;
      const invoices = (await c.query(
        `select i.id, i.contract_id, i.competence, i.due_date, i.amount_cents, i.status, i.paid_at, i.gateway,
                case when i.status = 'open' then i.payment_methods end as payment_methods,
                (i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date) as overdue
         from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id
         where i.subscriber_id = $1 and i.status <> 'canceled' order by i.due_date desc limit 36`, [sid])).rows;
      return { subscriber, contracts, invoices };
    });
  });
}
