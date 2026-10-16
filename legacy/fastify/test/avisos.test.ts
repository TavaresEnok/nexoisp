import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl, deliverNotifications } from '../src/notify.js';
import { notify } from '../src/worker.js';
import { call, login } from './helpers.js';

// Avisos por webhook contra um servidor HTTP de verdade (local): entrega, nova tentativa após falha e isolamento.
let admin: string, tenant: string, url: string, fail = 0;
const got: any[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (fail > 0) { fail--; res.writeHead(500).end(); return; }
    got.push(JSON.parse(body));
    res.writeHead(200).end('ok');
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  admin = await login('admin@alfa.demo');
  tenant = (await call(admin, 'GET', '/api/me')).body.tenant.id;
});
afterAll(async () => {
  await call(admin, 'PUT', '/api/notifications/settings', { webhook_url: null });
  await new Promise((r) => server.close(r));
});

describe('avisos ao provedor', () => {
  it('sem webhook nada entra na fila; com webhook o aviso é gravado com o fato e entregue', async () => {
    const sub = (await call(admin, 'GET', '/api/subscribers')).body[0];
    await call(admin, 'POST', '/api/work-orders', { kind: 'other', subscriber_id: sub.id, description: 'sem aviso' });
    expect((await call(admin, 'GET', '/api/notifications')).body.recent).toEqual([]);

    expect((await call(await login('noc@alfa.demo'), 'PUT', '/api/notifications/settings', { webhook_url: url })).status).toBe(403);
    expect((await call(admin, 'PUT', '/api/notifications/settings', { webhook_url: 'ftp://x' })).status).toBe(400);
    expect((await call(admin, 'PUT', '/api/notifications/settings', { webhook_url: url })).status).toBe(200);
    expect((await call(admin, 'POST', '/api/notifications/test', {})).status).toBe(200);
    expect(got.pop()).toMatchObject({ event: 'test' });

    const wo = (await call(admin, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: sub.id, description: 'com aviso' })).body;
    expect((await call(admin, 'GET', '/api/notifications')).body.recent[0]).toMatchObject({ event: 'work_order.created', status: 'pending' });
    expect(await deliverNotifications(() => {}, tenant)).toEqual({ sent: 1, failed: 0 });
    expect(got.pop()).toMatchObject({ event: 'work_order.created', number: wo.number, text: expect.stringContaining(`OS ${wo.number} aberta`) });
    expect(await deliverNotifications(() => {}, tenant)).toEqual({ sent: 0, failed: 0 });        // não reenvia o que já foi entregue
  });

  it('destino fora do ar: o aviso fica pendente com o erro e é entregue na tentativa seguinte', async () => {
    const eu = (await call(admin, 'GET', '/api/me')).body;
    const wo = (await call(admin, 'GET', '/api/work-orders?status=pending')).body[0];
    fail = 1;
    await call(admin, 'PATCH', `/api/work-orders/${wo.id}`, { assignee_id: eu.id });
    expect(await deliverNotifications(() => {}, tenant)).toEqual({ sent: 0, failed: 1 });
    const n = (await call(admin, 'GET', '/api/notifications')).body.recent[0];
    expect(n).toMatchObject({ event: 'work_order.assigned', status: 'pending', attempts: 1, last_error: expect.stringContaining('500') });
    expect(await deliverNotifications(() => {}, tenant)).toEqual({ sent: 0, failed: 0 });        // respeita o intervalo antes de tentar de novo
    const { withScope } = await import('../src/db.js');
    await withScope({ tenantId: tenant, operator: false }, (c) => c.query('update notifications set next_attempt_at = now() where id = $1', [n.id]));
    expect(await deliverNotifications(() => {}, tenant)).toEqual({ sent: 1, failed: 0 });
    expect(got.pop().text).toContain('atribuída a');
    const beta = await login('admin@beta.demo');
    expect((await call(beta, 'GET', '/api/notifications')).body).toEqual({ webhook_url: null, recent: [] });
  });

  it('fora do modo demonstração só https e nunca um endereço interno', async () => {
    const demo = process.env.NEXO_DEMO_MODE;
    process.env.NEXO_DEMO_MODE = '0';
    try {
      for (const bad of [url, 'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://localhost/x', 'https://u:p@exemplo.com/x'])
        await expect(assertSafeWebhookUrl(bad)).rejects.toThrow();
      expect((await assertSafeWebhookUrl('https://203.0.113.10/hook')).hostname).toBe('203.0.113.10');
    } finally { process.env.NEXO_DEMO_MODE = demo; }
  });

  it('alerta de rede (agente offline / operação incerta) chega a um webhook real e só quando o conjunto muda', async () => {
    process.env.NEXO_ALERT_WEBHOOK_URL = url;
    try {
      const a = [{ tenant_id: tenant, agents_offline: 1, uncertain: 0 }];
      await notify(a, () => {});
      await notify(a, () => {});                                                                  // mesmo conjunto: não repete
      await notify([], () => {});                                                                 // normalizou: avisa
      expect(got.map((g) => g.text)).toEqual([expect.stringContaining('1 agente(s) offline'), 'NexoISP: alertas de rede normalizados']);
    } finally { delete process.env.NEXO_ALERT_WEBHOOK_URL; }
  });
});
