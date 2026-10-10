import { pool, withScope } from './db.js';
import { runWorkerOnce } from './finance/core.js';

let lastAlertKey = '';
/** Alerta por webhook genérico (NEXO_ALERT_WEBHOOK_URL): envia só quando o conjunto de alertas muda, inclusive ao normalizar. */
async function notify(alerts: { tenant_id: string; agents_offline: number; uncertain: number }[], log: (m: string) => void) {
  const key = JSON.stringify(alerts);
  if (key === lastAlertKey) return;
  lastAlertKey = key;
  const url = process.env.NEXO_ALERT_WEBHOOK_URL;
  if (!url) return;
  const text = alerts.length
    ? `NexoISP: ${alerts.map((a) => `provedor ${a.tenant_id}: ${a.agents_offline} agente(s) offline, ${a.uncertain} operação(ões) incerta(s)`).join('; ')}`
    : 'NexoISP: alertas de rede normalizados';
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, alerts }), signal: AbortSignal.timeout(5000) });
  } catch (e) {
    log(`falha ao enviar alerta ao webhook: ${(e as Error).message}`);
  }
}

/**
 * Trava consultiva de sessão: com mais de uma réplica da API, só uma executa a rotina por vez; as demais pulam o ciclo.
 * Devolve false quando outra sessão do banco já tem a trava.
 */
export async function withWorkerLock(work: () => Promise<void>): Promise<boolean> {
  const lock = await pool().connect();
  try {
    if (!(await lock.query('select pg_try_advisory_lock(7411002) as ok')).rows[0].ok) return false;
    try {
      await work();
    } finally {
      await lock.query('select pg_advisory_unlock(7411002)');
    }
    return true;
  } finally {
    lock.release();
  }
}

/** Rotinas periódicas no mesmo processo (ADR-001). Automação só age em tenants que a configuraram explicitamente. */
export function startWorker(log: (m: string) => void, everyMs = 60_000) {
  let n = 0, running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await withWorkerLock(async () => {
        await runWorkerOnce(log, { reconcile: n++ % 10 === 0 });
        const h = await withScope({ tenantId: null, operator: true }, async (c) =>
          (await c.query('select tenant_id, agents_offline, uncertain from platform_health() where agents_offline > 0 or uncertain > 0 order by tenant_id')).rows);
        for (const t of h) log(`ALERTA tenant=${t.tenant_id} agentes_offline=${t.agents_offline} operacoes_incertas=${t.uncertain}`);
        await notify(h, log);
      });
    } catch (e) {
      log(`rotina periódica falhou: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, everyMs);
  t.unref();
  setTimeout(tick, 5_000).unref();
  return () => clearInterval(t);
}
