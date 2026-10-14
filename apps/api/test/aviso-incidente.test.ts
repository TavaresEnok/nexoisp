import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNotices } from '../src/notices.js';
import { call, login } from './helpers.js';

// Aviso de manutenção/queda enviado aos afetados pela fila de saída: só com consentimento, um por assinante e fase, e a normalização depois.
let admin: string, op: string, noc: string, tenantId: string, url: string, planId: string, channelId: string;
const tag = String(Date.now()).slice(-6);
const got: any[] = [];
const server = createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.writeHead(200).end('ok'); }); });
const iso = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
let deviceId: string;

async function cliente(nome: string, allow: boolean, device: string | null) {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: nome })).body;
  const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body;
  await call(admin, 'PUT', `/api/subscribers/${sub.id}/contacts`, { contacts: [{ kind: 'mobile', value: `(81) 9${tag}-${Math.floor(Math.random() * 9000 + 1000)}`, purpose: 'technical', allow_notices: allow }] });
  if (device) await call(admin, 'POST', `/api/contracts/${k.id}/service`, { device_id: device, pppoe_username: `inc${tag}${Math.random().toString(36).slice(2, 6)}` });
  return sub.id as string;
}

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sms`;
  admin = await login('admin@alfa.demo'); op = await login('operador@nexoisp.demo'); noc = await login('noc@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano inc ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `inc${tag}` })).body.id;
  const ag = (await call(admin, 'POST', '/api/agents', { name: `ag-inc-${tag}` })).body;
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-inc-${tag}`, driver: 'demo', agent_id: ag.id })).body.id;
});
afterAll(async () => {
  const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
  await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: cur.filter((m) => m !== 'messages') });
  await new Promise((r) => server.close(r));
});

describe('aviso de incidente aos afetados', () => {
  it('sem o módulo de avisos é recusado', async () => {
    const m = (await call(admin, 'POST', '/api/maintenance-notices', { title: `Sem módulo ${tag}`, message: 'x y z', starts_at: iso(-1), ends_at: iso(2), device_id: deviceId })).body;
    expect((await call(noc, 'POST', `/api/maintenance-notices/${m.id}/notify`, { channel_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(409);
  });

  it('só os afetados com consentimento; uma vez por fase; normalização depois do início', async () => {
    const cur = (await call(admin, 'GET', '/api/me')).body.modules as string[];
    await call(op, 'PATCH', `/api/tenants/${tenantId}`, { modules: [...new Set([...cur, 'messages'])] });
    channelId = (await call(admin, 'POST', '/api/notice-channels', { name: `Canal inc ${tag}`, url, phone_field: 'numero', message_field: 'texto' })).body.id;
    await cliente(`Afetado Sim ${tag}`, true, deviceId);
    await cliente(`Afetado Nao ${tag}`, false, deviceId);
    await cliente(`Outro NAS ${tag}`, true, null);
    const m = (await call(admin, 'POST', '/api/maintenance-notices', { title: `Queda na fibra ${tag}`, message: 'Equipe trabalhando no reparo', severity: 'outage',
      starts_at: iso(-1), ends_at: iso(3), device_id: deviceId })).body;
    expect((await call(noc, 'POST', `/api/maintenance-notices/${m.id}/notify`, { channel_id: channelId, phase: 'resolved' })).status).toBe(409);   // antes do início
    const r1 = (await call(noc, 'POST', `/api/maintenance-notices/${m.id}/notify`, { channel_id: channelId })).body;
    expect(r1).toMatchObject({ phase: 'start', queued: 1, skipped_no_consent: 1 });
    await runNotices(tenantId);
    const mine = () => got.filter((g) => String(g.texto).includes(tag));
    expect(mine()).toHaveLength(1);
    expect(mine()[0].texto).toMatch(/Queda na fibra .*Equipe trabalhando/);
    const r2 = (await call(noc, 'POST', `/api/maintenance-notices/${m.id}/notify`, { channel_id: channelId })).body;
    expect(r2).toMatchObject({ queued: 0, skipped_no_consent: 0 });                      // repetir não manda de novo
    const r3 = (await call(noc, 'POST', `/api/maintenance-notices/${m.id}/notify`, { channel_id: channelId, phase: 'resolved', text: 'Olá {nome}, a internet voltou (ref ' + tag + ').' })).body;
    expect(r3).toMatchObject({ phase: 'resolved', queued: 1 });
    await runNotices(tenantId);
    expect(mine()).toHaveLength(2);
    expect(mine()[1].texto).toBe(`Olá Afetado, a internet voltou (ref ${tag}).`);
    expect((await call(await login('financeiro@alfa.demo'), 'POST', `/api/maintenance-notices/${m.id}/notify`, { channel_id: channelId })).status).toBe(403);
  });
});
