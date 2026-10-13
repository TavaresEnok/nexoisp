import { createHmac, randomBytes } from 'node:crypto';
import { assertSafeWebhookUrl } from './notify.js';
import { noScope, withScope, type Tx } from './db.js';
import { decryptSecret } from './network/crypto.js';

/** Eventos que o provedor pode assinar. O nome e o formato do `data` são contrato com quem integra: não mudar sem versionar. */
export const WEBHOOK_EVENTS = [
  'invoice.paid', 'access.suspended', 'access.resumed', 'ticket.created',
  'work_order.created', 'work_order.status_changed', 'sla.breached', 'survey.answered', 'contract.changed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 6;
const BACKOFF_MIN = [1, 5, 30, 120, 720];     // minutos até a próxima tentativa
const SYS = (tenantId: string) => ({ tenantId, operator: false });

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** Assinatura: HMAC-SHA256 de `${timestamp}.${corpo}`. O timestamp vai junto para quem recebe recusar repetição antiga. */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Registra o evento para cada endpoint ativo que o assina, na transação do fato (se o fato voltar atrás, o evento também).
 * Sem módulo "api" ou sem endpoint, nada é gravado.
 */
export async function emitEvent(c: Tx, tenantId: string, event: WebhookEvent, data: Record<string, unknown>) {
  await c.query(
    `insert into webhook_deliveries (tenant_id, endpoint_id, event, payload)
     select $1, e.id, $2, $3 from webhook_endpoints e
     where e.tenant_id = $1 and e.active and $2 = any(e.events)
       and exists (select 1 from tenants t where t.id = $1 and 'api' = any(t.modules))`,
    [tenantId, event, JSON.stringify({ event, created_at: new Date().toISOString(), data })]);
}

async function post(url: string, secret: string, id: string | number, event: string, payload: unknown) {
  const u = await assertSafeWebhookUrl(url);              // resolve de novo a cada entrega
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const r = await fetch(u, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), body,
    headers: { 'content-type': 'application/json', 'user-agent': 'NexoISP-Webhook/1', 'x-nexo-event': event, 'x-nexo-delivery': String(id),
      'x-nexo-timestamp': String(ts), 'x-nexo-signature': sign(secret, ts, body) },
  });
  return r.status;
}

/** Envio imediato de um evento de teste; não passa pela fila e não fica no histórico. */
export async function sendTestEvent(url: string, secretEnc: string): Promise<{ ok: boolean; status: number | null; error?: string }> {
  try {
    const status = await post(url, decryptSecret(secretEnc), 'test', 'test', { event: 'test', created_at: new Date().toISOString(), data: { message: 'Evento de teste do NexoISP' } });
    return { ok: status >= 200 && status < 300, status, ...(status >= 300 ? { error: `o destino respondeu ${status}` } : {}) };
  } catch (e) { return { ok: false, status: null, error: (e as Error).message.slice(0, 300) }; }
}

/** Entrega os pendentes (de um provedor ou de todos). Falha agenda nova tentativa com espera crescente; depois de 6, "falhou". */
export async function deliverWebhooks(log: (m: string) => void = () => {}, onlyTenant?: string): Promise<{ sent: number; failed: number }> {
  const tenants: string[] = onlyTenant ? [onlyTenant]
    : (await withScope(noScope, async (c) => (await c.query('select tenant_id from worker_tenants()')).rows)).map((t) => t.tenant_id);
  let sent = 0, failed = 0;
  for (const tenantId of tenants) {
    const due = await withScope(SYS(tenantId), async (c) => (await c.query(
      `select d.id, d.event, d.payload, d.attempts, e.url, e.secret_enc, e.active
       from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
       where d.status = 'pending' and d.next_attempt_at <= now() order by d.id limit 20`)).rows);
    for (const d of due) {
      let error: string | null = null, status: number | null = null;
      try {
        if (!d.active) throw new Error('endpoint desativado');
        status = await post(d.url, decryptSecret(d.secret_enc), d.id, d.event, d.payload);    // fora de transação
        if (status < 200 || status >= 300) throw new Error(`o destino respondeu ${status}`);
      } catch (e) { error = (e as Error).message.slice(0, 300); }
      const attempts = d.attempts + 1;
      const giveUp = !!error && (attempts >= MAX_ATTEMPTS || !d.active);
      const waitMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
      await withScope(SYS(tenantId), (c) => c.query(
        `update webhook_deliveries set attempts = $2, last_error = $3, response_status = $4, status = $5,
                sent_at = case when $3::text is null then now() end, next_attempt_at = now() + make_interval(mins => $6::int) where id = $1`,
        [d.id, attempts, error, status, error ? (giveUp ? 'failed' : 'pending') : 'sent', waitMin]));
      if (error) { failed++; log(`webhook ${d.id} (${d.event}) do provedor ${tenantId}: ${error}`); } else sent++;
    }
    // limpeza: contadores antigos e repetições vencidas
    await withScope(SYS(tenantId), async (c) => {
      await c.query(`delete from api_rate where bucket < now() - interval '2 hours'`);
      await c.query(`delete from api_idempotency where created_at < now() - interval '24 hours'`);
    });
  }
  return { sent, failed };
}
