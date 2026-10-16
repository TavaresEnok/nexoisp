import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError, newToken, sha256 } from '../auth.js';
import { withScope } from '../db.js';
import { encryptSecret } from '../network/crypto.js';
import { assertSafeWebhookUrl } from '../notify.js';
import { zUuid } from '../validators.js';
import { deliverWebhooks, newWebhookSecret, sendTestEvent, WEBHOOK_EVENTS } from '../webhooks.js';
import { API_SCOPES } from './public-api.js';

/** Administração da API pública e dos webhooks de saída (módulo "api"). Tudo `settings:manage`. */
export async function integracoesRoutes(app: FastifyInstance) {
  app.get('/api/integrations/catalog', { preHandler: guard('settings:manage') }, async () => ({ scopes: API_SCOPES, events: WEBHOOK_EVENTS }));

  // ---------------------------------------------------------------- tokens
  app.get('/api/api-tokens', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select id, name, prefix, scopes, rate_limit_per_min, active, expires_at, last_used_at, created_at, revoked_at
         from api_tokens order by revoked_at nulls first, created_at desc`)).rows));

  app.post('/api/api-tokens', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(60),
      scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
      rate_limit_per_min: z.number().int().min(10).max(6000).default(120),
      expires_in_days: z.number().int().min(1).max(730).nullish(),
    }).parse(req.body);
    const token = `nxk_${newToken()}`;                       // aparece só nesta resposta; no banco fica o hash
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `insert into api_tokens (tenant_id, name, token_hash, prefix, scopes, rate_limit_per_min, expires_at, created_by)
         values ($1,$2,$3,$4,$5,$6, case when $7::int is null then null else now() + make_interval(days => $7::int) end, $8)
         on conflict (tenant_id, name) do nothing returning id, name, prefix, scopes, rate_limit_per_min, expires_at`,
        [req.ctx.tenantId, b.name, sha256(token), token.slice(0, 12), [...new Set(b.scopes)], b.rate_limit_per_min, b.expires_in_days ?? null, req.ctx.userId])).rows[0];
      if (!r) throw new HttpError(409, 'já existe um token com este nome');
      await audit(c, req.ctx, 'api_token.create', 'api_token', r.id, { name: b.name, scopes: r.scopes, rate_limit_per_min: b.rate_limit_per_min });
      return { ...r, token };
    });
  });

  app.delete('/api/api-tokens/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query(`update api_tokens set active = false, revoked_at = coalesce(revoked_at, now()) where id = $1 returning id`, [id]);
      if (!r.rowCount) throw new HttpError(404, 'token não encontrado');
      await audit(c, req.ctx, 'api_token.revoke', 'api_token', id);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- webhooks
  const zEvents = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
  app.get('/api/webhook-endpoints', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select e.id, e.name, e.url, e.events, e.active, e.created_at,
                (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pending')::int as pending,
                (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'failed')::int as failed
         from webhook_endpoints e order by e.name`)).rows));

  app.post('/api/webhook-endpoints', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(60), url: z.string().trim().url().max(500), events: zEvents }).parse(req.body);
    await assertSafeWebhookUrl(b.url);
    const secret = newWebhookSecret();
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `insert into webhook_endpoints (tenant_id, name, url, secret_enc, events) values ($1,$2,$3,$4,$5)
         on conflict (tenant_id, name) do nothing returning id, name, url, events, active`,
        [req.ctx.tenantId, b.name, b.url, encryptSecret(secret), [...new Set(b.events)]])).rows[0];
      if (!r) throw new HttpError(409, 'já existe um endpoint com este nome');
      await audit(c, req.ctx, 'webhook.create', 'webhook_endpoint', r.id, { name: b.name, host: new URL(b.url).host, events: r.events });
      return { ...r, secret };                               // o segredo aparece só aqui (e ao trocar)
    });
  });

  app.patch('/api/webhook-endpoints/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ url: z.string().trim().url().max(500).optional(), events: zEvents.optional(), active: z.boolean().optional() }).parse(req.body);
    if (b.url) await assertSafeWebhookUrl(b.url);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update webhook_endpoints set url = coalesce($2, url), events = coalesce($3, events), active = coalesce($4, active) where id = $1 returning id, name, url, events, active`,
        [id, b.url ?? null, b.events ? [...new Set(b.events)] : null, b.active ?? null])).rows[0];
      if (!r) throw new HttpError(404, 'endpoint não encontrado');
      await audit(c, req.ctx, 'webhook.update', 'webhook_endpoint', id, { ...b, url: b.url ? new URL(b.url).host : undefined });
      return r;
    });
  });

  app.post('/api/webhook-endpoints/:id/rotate-secret', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const secret = newWebhookSecret();
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('update webhook_endpoints set secret_enc = $2 where id = $1', [id, encryptSecret(secret)])).rowCount) throw new HttpError(404, 'endpoint não encontrado');
      await audit(c, req.ctx, 'webhook.rotate_secret', 'webhook_endpoint', id);
      return { secret };
    });
  });

  app.delete('/api/webhook-endpoints/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('delete from webhook_endpoints where id = $1', [id])).rowCount) throw new HttpError(404, 'endpoint não encontrado');
      await audit(c, req.ctx, 'webhook.delete', 'webhook_endpoint', id);
      return { ok: true };
    });
  });

  app.post('/api/webhook-endpoints/:id/test', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const e = await withScope(req.ctx.scope, async (c) => (await c.query('select url, secret_enc from webhook_endpoints where id = $1', [id])).rows[0]);
    if (!e) throw new HttpError(404, 'endpoint não encontrado');
    return sendTestEvent(e.url, e.secret_enc);
  });

  app.get('/api/webhook-deliveries', { preHandler: guard('settings:manage') }, async (req) => {
    const q = z.object({ endpoint_id: zUuid.optional(), status: z.enum(['pending', 'sent', 'failed']).optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select d.id, d.event, d.status, d.attempts, d.last_error, d.response_status, d.created_at, d.sent_at, d.next_attempt_at, e.name as endpoint_name
         from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
         where ($1::uuid is null or d.endpoint_id = $1) and ($2::text is null or d.status = $2) order by d.id desc limit 100`,
        [q.endpoint_id ?? null, q.status ?? null])).rows);
  });

  // Reenvia uma entrega que esgotou as tentativas (ex.: o destino estava fora do ar).
  app.post('/api/webhook-deliveries/:id/retry', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.or(z.string().regex(/^\d+$/)).parse((req.params as any).id);
    const r = await withScope(req.ctx.scope, async (c) => {
      const x = await c.query(`update webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null where id = $1 and status = 'failed' returning id`, [id]);
      if (x.rowCount) await audit(c, req.ctx, 'webhook.retry', 'webhook_delivery', String(id));
      return x;
    });
    if (!r.rowCount) throw new HttpError(409, 'só entregas que falharam podem ser reenviadas');
    return deliverWebhooks(() => {}, req.ctx.tenantId!);
  });
}
