import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { runNotices } from '../src/notices.js';
import { deliverWebhooks } from '../src/webhooks.js';
import { notify, resetAlertState } from '../src/worker.js';
import { call, login, testAgent } from './helpers.js';

// Correções da revisão: fila de avisos fora de transação, alerta operacional que não se perde, eventos de acesso solicitado × confirmado.
let admin: string, op: string, tenantId: string, url: string;
const tag = String(Date.now()).slice(-6);
const got: any[] = [];
let status = 200, delayMs = 0, onRequest: (() => Promise<void>) | null = null;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    if (onRequest) await onRequest();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    got.push({ path: req.url, event: req.headers['x-nexo-event'], body: body ? JSON.parse(body) : null });
    res.writeHead(status).end('x');
  });
});
const sql = (q: string, p: unknown[] = []) => withScope({ tenantId, operator: false }, async (c) => (await c.query(q, p)).rows);
const modules = async (add: string[], remove: string[] = []) => {
  const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
  await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: [...new Set([...cur, ...add])].filter((m) => !remove.includes(m)) });
};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = await login('admin@alfa.demo');
  op = await login('operador@nexoisp.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  await modules(['messages', 'api']);
});
afterAll(async () => {
  for (const e of (await call(admin, 'GET', '/api/webhook-endpoints')).body) if (e.name.endsWith(tag)) await call(admin, 'DELETE', `/api/webhook-endpoints/${e.id}`);
  await new Promise((r) => server.close(r));
});

describe('avisos ao assinante com fila', () => {
  it('a chamada externa acontece sem transação aberta e o que já foi enviado fica gravado mesmo se o resto falhar', async () => {
    const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano fila ${tag}`, price_cents: 7990, down_kbps: 1000, up_kbps: 1000, profile_name: `fl${tag}` })).body.id;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());   // hoje no fuso do provedor
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Fila ${n} ${tag}` })).body;
      const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body;
      await call(admin, 'PUT', `/api/subscribers/${sub.id}/contacts`, { contacts: [{ kind: 'mobile', value: `8199999000${n}`, purpose: 'billing', allow_notices: true }] });
      ids.push((await call(admin, 'POST', '/api/invoices', { contract_id: k.id, description: 'Fila', amount_cents: 7990, due_date: day })).body.id);
    }
    const ch = (await call(admin, 'POST', '/api/notice-channels', { name: `canal fila ${tag}`, url: `${url}/sms` })).body;
    const tp = (await call(admin, 'POST', '/api/notice-templates', { name: `modelo fila ${tag}`, body: 'Olá {nome}, vence hoje {valor}.' })).body;
    const rule = (await call(admin, 'POST', '/api/notice-rules', { name: `regra fila ${tag}`, template_id: tp.id, channel_id: ch.id, days_relative: 0, plan_id: plan, hour_from: 0, hour_to: 24 })).body;

    // durante cada envio: nenhuma transação desta rotina pode estar aberta no banco, e a linha já está reservada ("sending")
    const seen: { open: number; sending: number }[] = [];
    got.length = 0;
    onRequest = async () => {
      const open = (await sql(`select count(*)::int as n from pg_stat_activity where state = 'idle in transaction' and query ilike '%notice_log%'`))[0].n;
      const sending = (await sql(`select count(*)::int as n from notice_log where rule_id = $1 and status = 'sending'`, [rule.id]))[0].n;
      seen.push({ open, sending });
    };
    const r = await runNotices(tenantId);
    onRequest = null;
    expect(r.sent).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.open === 0 && s.sending === 1)).toBe(true);
    const log = await sql(`select status, message from notice_log where rule_id = $1`, [rule.id]);
    expect(log.map((l) => l.status)).toEqual(['sent', 'sent']);
    expect(log.every((l) => l.message === null)).toBe(true);          // a mensagem não fica guardada depois do envio

    // processo caiu entre enviar e gravar: a reserva antiga vira "resultado desconhecido" e NÃO é reenviada
    await sql(`update notice_log set status = 'sending', claimed_at = now() - interval '30 minutes' where rule_id = $1 and invoice_id = $2`, [rule.id, ids[0]]);
    got.length = 0;
    await runNotices(tenantId);
    expect(got.filter((g) => g.path === '/sms')).toHaveLength(0);
    expect((await sql(`select status from notice_log where rule_id = $1 and invoice_id = $2`, [rule.id, ids[0]]))[0].status).toBe('uncertain');
    expect((await call(admin, 'GET', '/api/notice-log')).body.some((l: any) => l.status === 'uncertain')).toBe(true);

    for (const id of ids) await call(admin, 'POST', `/api/invoices/${id}/cancel`, { reason: 'limpeza do teste' });
    await call(admin, 'DELETE', `/api/notice-rules/${rule.id}`);
  });
});

describe('alerta operacional', () => {
  it('destino com erro não marca como avisado: tenta de novo até ser aceito, e depois não repete', async () => {
    const before = process.env.NEXO_ALERT_WEBHOOK_URL;
    process.env.NEXO_ALERT_WEBHOOK_URL = `${url}/alerta`;
    resetAlertState();
    const alerts = [{ tenant_id: tenantId, agents_offline: 1, uncertain: 0 }];
    const logs: string[] = [];
    const hits = () => got.filter((g) => g.path === '/alerta').length;
    got.length = 0;
    status = 500;
    await notify(alerts, (m) => logs.push(m));
    expect(hits()).toBe(1);
    expect(logs.join(' ')).toMatch(/respondeu 500/);
    await notify(alerts, (m) => logs.push(m));          // mesmo estado: precisa tentar de novo
    expect(hits()).toBe(2);
    status = 200;
    await notify(alerts, () => {});
    expect(hits()).toBe(3);
    await notify(alerts, () => {});                      // aceito: não repete
    expect(hits()).toBe(3);
    await notify([], () => {});                          // normalizou: avisa
    expect(hits()).toBe(4);
    process.env.NEXO_ALERT_WEBHOOK_URL = before;
    resetAlertState();
  });
});

describe('eventos de acesso', () => {
  it('o pedido sai como *_requested; suspended/resumed só depois que o agente confirma', async () => {
    status = 200;
    const ep = (await call(admin, 'POST', '/api/webhook-endpoints', { name: `acesso-${tag}`, url: `${url}/hook`,
      events: ['access.suspend_requested', 'access.resume_requested', 'access.suspended', 'access.resumed', 'access.change_failed'] })).body;
    expect(ep.id).toBeTruthy();
    const ag = await testAgent(admin, `rev-${tag}`);
    const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano ev ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `ev${tag}` })).body.id;
    const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Evento ${tag}` })).body;
    const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
    const res = (await call(admin, 'POST', `/api/contracts/${k}/service`, { device_id: ag.deviceId, pppoe_username: `ev${tag}` })).body.resource_id;
    await ag.runNext();                                   // provisionamento
    const events = async () => (await call(admin, 'GET', `/api/webhook-deliveries?endpoint_id=${ep.id}`)).body.map((d: any) => d.event).reverse();

    expect((await call(admin, 'POST', `/api/resources/${res}/suspend`, { reason: 'teste de evento' })).status).toBe(200);
    expect(await events()).toEqual(['access.suspend_requested']);      // agente ainda não executou: nada de "suspended"
    await ag.runNext();
    expect(await events()).toEqual(['access.suspend_requested', 'access.suspended']);
    await call(admin, 'POST', `/api/resources/${res}/resume`, { reason: 'teste de evento' });
    await ag.runNext();
    expect(await events()).toEqual(['access.suspend_requested', 'access.suspended', 'access.resume_requested', 'access.resumed']);
    got.length = 0;
    await deliverWebhooks(() => {}, tenantId);
    const conf = got.find((g) => g.event === 'access.suspended');
    expect(conf.body.data).toMatchObject({ contract_id: k, stage: 'blocked' });
    expect(conf.body.data.operation_id).toBeTruthy();
  });
});
