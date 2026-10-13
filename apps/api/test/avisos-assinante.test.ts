import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { runNotices } from '../src/notices.js';
import { call, login } from './helpers.js';

// Avisos ao assinante (só de saída): consentimento, janela, uma vez por título, falha com limite de tentativas e isolamento.
let admin: string, op: string, beta: string, tenantId: string, url: string, planId: string;
const tag = String(Date.now()).slice(-6);
const got: any[] = [];
let failNext = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (failNext > 0) { failNext--; res.writeHead(503).end(); return; }
    got.push({ auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200).end('ok');
  });
});
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const made: string[] = [];

async function cliente(nome: string, allow: boolean, due: number): Promise<{ contractId: string; subId: string; invoiceId: string }> {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: nome })).body;
  const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body;
  await call(admin, 'PUT', `/api/subscribers/${sub.id}/contacts`, { contacts: [{ kind: 'mobile', value: '(81) 99999-1234', purpose: 'billing', allow_notices: allow }] });
  const inv = (await call(admin, 'POST', '/api/invoices', { contract_id: k.id, description: 'Aviso', amount_cents: 7990, due_date: day(due) })).body;
  made.push(inv.id);
  return { contractId: k.id, subId: sub.id, invoiceId: inv.id };
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sms`;
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  op = await login('operador@nexoisp.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
  await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: [...new Set([...cur, 'messages'])] });
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano avisos ${tag}`, price_cents: 7990, down_kbps: 100000, up_kbps: 50000, profile_name: `av${tag}` })).body.id;
});
afterAll(async () => {
  for (const id of made) await call(admin, 'POST', `/api/invoices/${id}/cancel`, { reason: 'limpeza do teste' });
  const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
  await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: cur.filter((m) => m !== 'messages') });
  await new Promise((r) => server.close(r));
});

describe('avisos ao assinante', () => {
  it('módulo desligado é recusado; configuração só para quem administra; variável desconhecida não passa', async () => {
    const noc = await login('noc@alfa.demo');
    expect((await call(noc, 'GET', '/api/notice-channels')).status).toBe(403);
    expect((await call(beta, 'GET', '/api/notice-channels')).status).toBe(403);               // provedor sem o módulo: recusado pelo servidor
    expect((await call(admin, 'POST', '/api/notice-templates', { name: `ruim ${tag}`, body: 'Oi {nome}, seu {cpf}' })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/notice-channels', { name: `ruim ${tag}`, url: 'ftp://x' })).status).toBe(400);
  });

  it('régua: envia só com consentimento, uma vez por título, e guarda o segredo cifrado', async () => {
    const ch = await call(admin, 'POST', '/api/notice-channels', { name: `Canal ${tag}`, url, phone_field: 'numero', message_field: 'texto', extra_body: { remetente: 'NEXO' },
      headers: { Authorization: 'Bearer segredo-do-envio' } });
    expect(ch.status).toBe(200);
    const list = (await call(admin, 'GET', '/api/notice-channels')).body.find((c: any) => c.id === ch.body.id);
    expect(list.has_headers).toBe(true);
    expect(JSON.stringify(list)).not.toContain('segredo-do-envio');
    const tp = (await call(admin, 'POST', '/api/notice-templates', { name: `Modelo ${tag}`, body: 'Olá {nome}, sua fatura de {valor} do plano {plano} vence em {vencimento}.' })).body;
    expect(tp.preview).toBe('Olá Maria, sua fatura de R$ 79,90 do plano Fibra 200 vence em 10/11/2026.');
    const hour = new Date().getUTCHours();   // janela ampla: 0–24 em UTC cobre qualquer fuso
    const rule = await call(admin, 'POST', '/api/notice-rules', { name: `Regra ${tag}`, template_id: tp.id, channel_id: ch.body.id, days_relative: -3, plan_id: planId, hour_from: 0, hour_to: 24 });
    expect(rule.status).toBe(200);

    const com = await cliente(`Maria Aviso ${tag}`, true, 3);       // vence em 3 dias: casa com a regra (−3)
    const sem = await cliente(`João Sem Consentimento ${tag}`, false, 3);
    await cliente(`Outro Dia ${tag}`, true, 8);                      // vence em 8 dias: fora da regra
    void hour;
    const r1 = await call(admin, 'POST', '/api/notice-rules/run');
    expect(r1.body).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
    expect(got).toHaveLength(1);
    expect(got[0].auth).toBe('Bearer segredo-do-envio');
    expect(got[0].body).toMatchObject({ remetente: 'NEXO', numero: '(81) 99999-1234' });
    expect(got[0].body.texto).toMatch(/^Olá Maria, sua fatura de R\$ 79,90 do plano Plano avisos/);
    // repetir a rotina não envia de novo nem insiste em quem não consentiu
    expect((await call(admin, 'POST', '/api/notice-rules/run')).body).toMatchObject({ sent: 0, failed: 0 });
    expect(got).toHaveLength(1);
    const log = (await call(admin, 'GET', '/api/notice-log')).body;
    expect(log.filter((l: any) => l.status === 'sent' && l.contract_id === com.contractId)).toHaveLength(1);
    expect(log.some((l: any) => l.status === 'skipped_no_consent' && l.contract_id === sem.contractId)).toBe(true);
    expect((await call(beta, 'GET', '/api/notice-log')).status).toBe(403);
  });

  it('falha do provedor de envio conta tentativa e para na terceira; fora da janela nada é enviado', async () => {
    const ch = (await call(admin, 'GET', '/api/notice-channels')).body.find((c: any) => c.name === `Canal ${tag}`);
    const tp = (await call(admin, 'GET', '/api/notice-templates')).body.rows.find((t: any) => t.name === `Modelo ${tag}`);
    const planRetry = (await call(admin, 'POST', '/api/plans', { name: `Plano retry ${tag}`, price_cents: 5000, down_kbps: 50000, up_kbps: 25000, profile_name: `rt${tag}` })).body.id;
    const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Falha Envio ${tag}` })).body;
    const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planRetry, due_day: 10 })).body;
    await call(admin, 'PUT', `/api/subscribers/${sub.id}/contacts`, { contacts: [{ kind: 'whatsapp', value: '(81) 98888-0000', purpose: 'general', allow_notices: true }] });
    const inv = (await call(admin, 'POST', '/api/invoices', { contract_id: k.id, description: 'Falha', amount_cents: 5000, due_date: day(-5) })).body;
    made.push(inv.id);
    const rule = (await call(admin, 'POST', '/api/notice-rules', { name: `Regra retry ${tag}`, template_id: tp.id, channel_id: ch.id, days_relative: 5, plan_id: planRetry, hour_from: 0, hour_to: 24 })).body;

    failNext = 99;
    for (let i = 0; i < 3; i++) expect((await call(admin, 'POST', '/api/notice-rules/run')).body.failed).toBe(1);
    expect((await call(admin, 'POST', '/api/notice-rules/run')).body).toMatchObject({ sent: 0, failed: 0 });      // terceira falha: para de tentar
    failNext = 0;
    expect((await call(admin, 'POST', '/api/notice-rules/run')).body.sent).toBe(0);
    const row = (await call(admin, 'GET', '/api/notice-log')).body.find((l: any) => l.contract_id === k.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 3 });

    // janela: regra que só vale em uma hora que não é a atual
    const h = new Date().getUTCHours();
    await call(admin, 'PATCH', `/api/notice-rules/${rule.id}`, { active: false });
    const planWin = (await call(admin, 'POST', '/api/plans', { name: `Plano janela ${tag}`, price_cents: 5000, down_kbps: 50000, up_kbps: 25000, profile_name: `jn${tag}` })).body.id;
    const sub2 = (await call(admin, 'POST', '/api/subscribers', { name: `Janela ${tag}` })).body;
    const k2 = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub2.id, plan_id: planWin, due_day: 10 })).body;
    await call(admin, 'PUT', `/api/subscribers/${sub2.id}/contacts`, { contacts: [{ kind: 'mobile', value: '(81) 97777-0000', purpose: 'billing', allow_notices: true }] });
    made.push((await call(admin, 'POST', '/api/invoices', { contract_id: k2.id, description: 'Janela', amount_cents: 5000, due_date: day(0) })).body.id);
    // a hora do provedor é America/Sao_Paulo (UTC−3): escolhe uma janela de 1 hora que não contém a hora atual de lá
    const spHour = (h + 21) % 24;
    const from = (spHour + 5) % 24;
    await call(admin, 'POST', '/api/notice-rules', { name: `Regra janela ${tag}`, template_id: tp.id, channel_id: ch.id, days_relative: 0, plan_id: planWin, hour_from: Math.min(from, 22), hour_to: Math.min(from, 22) + 1 });
    const gotBefore = got.length;
    expect((await call(admin, 'POST', '/api/notice-rules/run')).body).toMatchObject({ sent: 0, failed: 0, skipped: 0 });
    expect(got.length).toBe(gotBefore);
    void withScope; void runNotices;
  });
});
