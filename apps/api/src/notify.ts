import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './auth.js';
import { noScope, withScope, type Tx } from './db.js';

/** Avisos ao provedor por webhook. O texto vai no campo `text` (formato aceito pelos webhooks de chat mais comuns). */
const MAX_ATTEMPTS = 5;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const a = ip.toLowerCase();
    return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80') || a.startsWith('::ffff:');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * O servidor faz uma requisição para um endereço escolhido pelo provedor: fora do modo demonstração só aceita HTTPS
 * e recusa destinos internos (loopback, redes privadas, metadados de nuvem), para o painel não virar ponte para a rede do SaaS.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'endereço do webhook inválido'); }
  if (u.username || u.password) throw new HttpError(400, 'o endereço do webhook não pode conter usuário e senha');
  if (process.env.NEXO_DEMO_MODE === '1') { if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'use http ou https'); return u; }
  if (u.protocol !== 'https:') throw new HttpError(400, 'o webhook precisa usar https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!addrs.length) throw new HttpError(400, 'não foi possível resolver o endereço do webhook');
  if (addrs.some(privateAddress)) throw new HttpError(400, 'o webhook aponta para um endereço interno, o que não é permitido');
  return u;
}

/** Grava o aviso na transação do fato. Sem webhook configurado, nada é gravado. */
export async function queueNotice(c: Tx, tenantId: string, event: string, text: string, data: Record<string, unknown> = {}) {
  await c.query(
    `insert into notifications (tenant_id, event, payload) select $1, $2, $3 from tenant_settings where tenant_id = $1 and notify_webhook_url is not null`,
    [tenantId, event, JSON.stringify({ text: `NexoISP: ${text}`, event, ...data })]);
}

async function post(url: string, body: unknown) {
  const u = await assertSafeWebhookUrl(url);
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`o destino respondeu ${r.status}`);
}

/** Entrega os avisos pendentes de um provedor (ou de todos). Falha agenda nova tentativa; depois de 5, o aviso fica como "falhou". */
export async function deliverNotifications(log: (m: string) => void = () => {}, onlyTenant?: string): Promise<{ sent: number; failed: number }> {
  const tenants: string[] = onlyTenant ? [onlyTenant]
    : (await withScope(noScope, async (c) => (await c.query('select tenant_id from worker_tenants()')).rows)).map((t) => t.tenant_id);
  let sent = 0, failed = 0;
  for (const tenantId of tenants) {
    const scope = { tenantId, operator: false };
    const { url, due } = await withScope(scope, async (c) => ({
      url: (await c.query('select notify_webhook_url from tenant_settings where tenant_id = $1', [tenantId])).rows[0]?.notify_webhook_url as string | undefined,
      due: (await c.query(`select id, payload, attempts from notifications where status = 'pending' and next_attempt_at <= now() order by id limit 20`)).rows,
    }));
    for (const n of due) {
      let error: string | null = null;
      try {
        if (!url) throw new Error('webhook removido da configuração');
        await post(url, n.payload);      // fora de transação: não se segura conexão do banco durante a chamada externa
      } catch (e) { error = (e as Error).message.slice(0, 300); }
      const giveUp = !!error && (n.attempts + 1 >= MAX_ATTEMPTS || !url);
      await withScope(scope, (c) => c.query(
        `update notifications set attempts = attempts + 1, last_error = $2, status = $3, sent_at = case when $2::text is null then now() end,
                next_attempt_at = now() + (attempts + 1) * interval '2 minutes' where id = $1`, [n.id, error, error ? (giveUp ? 'failed' : 'pending') : 'sent']));
      if (error) { failed++; log(`aviso ${n.id} do provedor ${tenantId} não entregue: ${error}`); } else sent++;
    }
  }
  return { sent, failed };
}

export async function sendTestNotice(url: string) {
  await post(url, { text: 'NexoISP: aviso de teste. Se você está lendo isto, o webhook está funcionando.', event: 'test' });
}
