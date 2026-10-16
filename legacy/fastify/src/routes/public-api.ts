import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, HttpError, sha256 } from '../auth.js';
import { noScope, paged, withScope, type Tx } from '../db.js';
import { queueNotice } from '../notify.js';
import { zPage, zUuid } from '../validators.js';
import { createWorkOrder, zWorkOrderCreate } from './field.js';
import { openTicket } from './crm.js';

/**
 * API pública v1: para sistemas do próprio provedor (site, ERP, integrador). Autenticação por token de aplicação
 * (`Authorization: Bearer nxk_…` ou `X-API-Key`), escopo por token e limite por minuto. Não há conversa nem caixa de entrada:
 * o que entra por aqui vira ocorrência ou ordem de serviço.
 */
export const API_SCOPES = ['subscribers:read', 'contracts:read', 'invoices:read', 'tickets:write', 'work_orders:read', 'work_orders:write'] as const;
type Scope = (typeof API_SCOPES)[number];

interface ApiCtx { tokenId: string; tenantId: string; name: string; scopes: string[] }
declare module 'fastify' {
  interface FastifyRequest { api: ApiCtx }
}

const apiActor = (a: ApiCtx) => ({ type: 'api' as const, id: a.tokenId, tenantId: a.tenantId });
const apiScope = (a: ApiCtx) => ({ tenantId: a.tenantId, operator: false });
/** Contexto mínimo para as funções compartilhadas com o painel: sem usuário (autoria registrada como o token). */
const apiCtx = (a: ApiCtx) => ({ tenantId: a.tenantId, userId: null as string | null, scope: apiScope(a), support: false });

const API_BAD_TOKENS = 30;   // tokens inválidos por endereço de origem em 10 minutos

function guardApi(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization;
    const raw = h?.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-key'] as string | undefined);
    // Quem erra o token em sequência é barrado por endereço de origem (mesma tabela do limite de login, no banco).
    const key = `apikey:ip:${req.ip}`;
    const wait = await withScope(noScope, async (c) => (await c.query('select login_throttle_blocked($1,$2) as s', [key, API_BAD_TOKENS])).rows[0].s as number);
    if (wait > 0) { reply.header('retry-after', String(wait)); throw new HttpError(429, 'muitas tentativas com token inválido; aguarde', 'rate_limited'); }
    const bad = async () => { await withScope(noScope, (c) => c.query('select login_throttle_fail($1,$2)', [key, 600])); };
    if (!raw || !raw.startsWith('nxk_')) { await bad(); throw new HttpError(401, 'token ausente ou inválido'); }
    const t = await withScope(noScope, async (c) => (await c.query('select * from api_token_get($1)', [sha256(raw)])).rows[0]);
    if (!t) { await bad(); throw new HttpError(401, 'token ausente, inválido, expirado ou revogado'); }
    if (!t.modules.includes('api')) throw new HttpError(403, 'a API pública não está liberada para o provedor', 'module_disabled');
    if (!t.scopes.includes(scope)) throw new HttpError(403, `o token não tem o escopo ${scope}`, 'scope_missing');
    // limite por minuto, no banco
    const n = await withScope({ tenantId: t.tenant_id, operator: false }, async (c) => {
      const r = (await c.query(
        `insert into api_rate (tenant_id, token_id, bucket, n) values ($1,$2,date_trunc('minute', now()),1)
         on conflict (token_id, bucket) do update set n = api_rate.n + 1 returning n`, [t.tenant_id, t.token_id])).rows[0].n as number;
      if (!t.last_used_at || Date.now() - new Date(t.last_used_at).getTime() > 60_000) await c.query('update api_tokens set last_used_at = now() where id = $1', [t.token_id]);
      return r;
    });
    reply.header('x-ratelimit-limit', String(t.rate_limit_per_min));
    reply.header('x-ratelimit-remaining', String(Math.max(0, t.rate_limit_per_min - n)));
    if (n > t.rate_limit_per_min) {
      reply.header('retry-after', String(60 - new Date().getSeconds()));
      throw new HttpError(429, 'limite de chamadas por minuto excedido', 'rate_limited');
    }
    req.api = { tokenId: t.token_id, tenantId: t.tenant_id, name: t.name, scopes: t.scopes };
  };
}

/** Repetição segura: com `Idempotency-Key`, a segunda chamada devolve a resposta da primeira e não cria outra ocorrência. */
async function idempotent<T>(req: FastifyRequest, reply: FastifyReply, run: (c: Tx) => Promise<T>): Promise<T> {
  const key = req.headers['idempotency-key'] as string | undefined;
  if (key !== undefined && (key.length < 1 || key.length > 64)) throw new HttpError(400, 'Idempotency-Key deve ter de 1 a 64 caracteres');
  return withScope(apiScope(req.api), async (c) => {
    if (key) {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`${req.api.tokenId}:${key}`]);
      const prev = (await c.query('select status, response from api_idempotency where token_id = $1 and key = $2', [req.api.tokenId, key])).rows[0];
      if (prev) { reply.header('idempotent-replay', 'true').status(prev.status); return prev.response as T; }
    }
    const out = await run(c);
    if (key) await c.query('insert into api_idempotency (tenant_id, token_id, key, status, response) values ($1,$2,$3,201,$4)', [req.api.tenantId, req.api.tokenId, key, JSON.stringify(out)]);
    reply.status(201);
    return out;
  });
}

const SUBSCRIBER = `select id, name, document, email, phone, address_street, address_number, address_district, address_city, address_state, address_zip, created_at from subscribers`;

export async function publicApiRoutes(app: FastifyInstance) {
  app.get('/public/v1', async () => ({ version: 'v1', scopes: API_SCOPES, docs: 'docs/api-publica.md' }));

  app.get('/public/v1/subscribers', { preHandler: guardApi('subscribers:read') }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().min(2).max(100).optional(), document: z.string().trim().max(20).optional(), ...zPage }).parse(req.query);
    return withScope(apiScope(req.api), async (c) => paged(c, reply,
      `${SUBSCRIBER} where ($1::text is null or name ilike '%'||$1||'%') and ($2::text is null or regexp_replace(document, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g'))
       order by name, id`, [q.q ?? null, q.document ?? null], q));
  });

  app.get('/public/v1/subscribers/:id', { preHandler: guardApi('subscribers:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(apiScope(req.api), async (c) => {
      const r = (await c.query(`${SUBSCRIBER} where id = $1`, [id])).rows[0];
      if (!r) throw new HttpError(404, 'assinante não encontrado');
      return r;
    });
  });

  app.get('/public/v1/contracts', { preHandler: guardApi('contracts:read') }, async (req, reply) => {
    const q = z.object({ subscriber_id: zUuid.optional(), status: z.enum(['active', 'ended']).optional(), ...zPage }).parse(req.query);
    return withScope(apiScope(req.api), async (c) => paged(c, reply,
      `select k.id, k.subscriber_id, k.status, k.due_day, k.start_date, p.name as plan_name, pv.price_cents, pv.down_kbps, pv.up_kbps,
              case when r.desired_version > 0 then r.desired_policy end as access
       from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
       left join service_resources r on r.contract_id = k.id
       where ($1::uuid is null or k.subscriber_id = $1) and ($2::text is null or k.status = $2) order by k.created_at desc, k.id`,
      [q.subscriber_id ?? null, q.status ?? null], q));
  });

  app.get('/public/v1/invoices', { preHandler: guardApi('invoices:read') }, async (req, reply) => {
    const q = z.object({ subscriber_id: zUuid.optional(), contract_id: zUuid.optional(), status: z.enum(['open', 'paid', 'canceled', 'reconciling']).optional(), ...zPage }).parse(req.query);
    return withScope(apiScope(req.api), async (c) => paged(c, reply,
      `select i.id, i.subscriber_id, i.contract_id, i.competence, i.due_date, i.amount_cents, i.status, i.paid_at
       from invoices i where ($1::uuid is null or i.subscriber_id = $1) and ($2::uuid is null or i.contract_id = $2) and ($3::text is null or i.status = $3)
       order by i.due_date desc, i.id`, [q.subscriber_id ?? null, q.contract_id ?? null, q.status ?? null], q));
  });

  // ---- escrita: vira ocorrência ou OS, sempre com o token como autor ----
  app.post('/public/v1/tickets', { preHandler: guardApi('tickets:write') }, async (req, reply) => {
    const b = z.object({
      subscriber_id: zUuid, contract_id: zUuid.nullish(), subject: z.string().trim().min(3).max(200),
      category: z.enum(['technical', 'financial', 'commercial', 'other']), priority: z.enum(['low', 'normal', 'high']).default('normal'),
      body: z.string().trim().min(1).max(4000),
    }).parse(req.body);
    return idempotent(req, reply, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [b.subscriber_id])).rowCount) throw new HttpError(400, 'assinante não encontrado');
      if (b.contract_id && !(await c.query('select 1 from contracts where id = $1 and subscriber_id = $2', [b.contract_id, b.subscriber_id])).rowCount)
        throw new HttpError(400, 'o contrato não pertence a este assinante');
      const t = await openTicket(c, apiCtx(req.api), { ...b, contract_id: b.contract_id ?? null, origin: 'api' });
      await queueNotice(c, req.api.tenantId, 'ticket.opened', `novo atendimento pela API (${req.api.name}) — protocolo ${t.number}: ${b.subject}`, { ticket_id: t.id, number: t.number });
      await audit(c, null, 'ticket.create', 'ticket', t.id, { number: t.number, via: 'api', token: req.api.name }, 'ok', apiActor(req.api));
      return { id: t.id, number: t.number, status: t.status, sla_due_at: t.sla_due_at ?? null };
    });
  });

  app.post('/public/v1/work-orders', { preHandler: guardApi('work_orders:write') }, async (req, reply) => {
    // por API não se escolhe responsável nem endereço livre: a equipe distribui e confere no painel
    const b = zWorkOrderCreate.pick({ kind: true, subscriber_id: true, contract_id: true, description: true, scheduled_for: true }).parse(req.body);
    return idempotent(req, reply, async (c) => {
      const w = await createWorkOrder(c, apiCtx(req.api), { ...b, estimated_minutes: 60, address_origin: 'subscriber' });
      await audit(c, null, 'work_order.create', 'work_order', w.id, { number: w.number, kind: b.kind, via: 'api', token: req.api.name }, 'ok', apiActor(req.api));
      return { id: w.id, number: w.number, status: w.status, sla_due_at: w.sla_due_at ?? null };
    });
  });

  app.get('/public/v1/work-orders/:id', { preHandler: guardApi('work_orders:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(apiScope(req.api), async (c) => {
      const w = (await c.query(
        `select id, number, kind, status, subscriber_id, contract_id, scheduled_for, description, resolution, created_at, finished_at, sla_due_at, en_route_at, started_at
         from work_orders where id = $1`, [id])).rows[0];
      if (!w) throw new HttpError(404, 'ordem de serviço não encontrada');
      return w;
    });
  });
}
