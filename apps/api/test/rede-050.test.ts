import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { agentCall, call, login } from './helpers.js';

// Agente 0.5.0: desconexão pedida (individual e em lote) e parâmetros de rede do plano e do NAS no envelope.
let admin: string, fin: string, agentToken: string, deviceId: string, planId: string;
const tag = String(Date.now()).slice(-6);
const RATE = '50M/100M 60M/120M 40M/80M 10/10';
const hello = (version: string) => agentCall(agentToken, 'hello', { session_id: `sess-r50-${tag}`, version });
const lastOp = async (contractId: string) => {
  const s = (await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body;
  return (await call(admin, 'GET', `/api/operations/${s.operations[0].id}`)).body;
};
async function conta(n: string) {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Rede050 ${n} ${tag}` })).body;
  const contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id;
  const s = await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: deviceId, pppoe_username: `r50${n}${tag}` });
  return { contractId, resourceId: s.body.resource_id as string, status: s.status, body: s.body };
}

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  fin = await login('financeiro@alfa.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-r50-${tag}` })).body;
  agentToken = a.token;
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-r50-${tag}`, driver: 'demo', agent_id: a.id })).body.id;
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano r50 ${tag}`, price_cents: 5000, down_kbps: 100000, up_kbps: 50000, profile_name: `r50${tag}` })).body.id;
});

describe('desconexão pedida', () => {
  it('exige agente 0.5.0; não muda a autorização nem o motivo; em lote cada conta responde por si', async () => {
    await hello('0.4.0');
    const a = await conta('a');
    expect((await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'teste' })).status).toBe(409);      // agente antigo
    await hello('0.5.0');
    const d = await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'cliente pediu reinício' });
    expect(d.status).toBe(200);
    const op = await lastOp(a.contractId);
    expect(op.action).toBe('subscriber.disconnect');
    expect(op.parameters).toMatchObject({ policy: 'active', reconnect: true });
    expect(op.parameters.suspension).toBeNull();

    // conta suspensa: a desconexão mantém a suspensão, o motivo e a data
    await call(admin, 'POST', `/api/resources/${a.resourceId}/suspend`, { reason: `corte ${tag}` });
    const antes = (await call(admin, 'GET', `/api/contracts/${a.contractId}/states`)).body.access;
    await call(admin, 'POST', `/api/resources/${a.resourceId}/disconnect`, { reason: 'derrubar sessão presa' });
    const depois = (await call(admin, 'GET', `/api/contracts/${a.contractId}/states`)).body.access;
    expect(depois).toMatchObject({ state: 'blocked', reason: `corte ${tag}`, mode: 'manual', since: antes.since });
    expect((await lastOp(a.contractId)).parameters).toMatchObject({ policy: 'suspended', reconnect: true });

    // lote
    const b = await conta('b');
    expect((await call(admin, 'POST', '/api/network/disconnect', { resource_ids: [a.resourceId], reason: 'x' })).status).toBe(400);   // motivo curto
    expect((await call(fin, 'POST', '/api/network/disconnect', { resource_ids: [a.resourceId], reason: 'manutenção no POP' })).status).toBe(403);
    const lote = await call(admin, 'POST', '/api/network/disconnect', { resource_ids: [a.resourceId, b.resourceId, randomUUID()], reason: 'manutenção no POP' });
    expect(lote.body).toMatchObject({ requested: 2, refused: 1 });
    expect(lote.body.results.find((r: any) => !r.ok).error).toMatch(/não encontrada/);
    expect((await call(admin, 'GET', '/api/audit?limit=20')).body.some((e: any) => e.action === 'network.bulk_disconnect')).toBe(true);
  });
});

describe('parâmetros de rede do plano e do NAS', () => {
  it('validam o formato, entram no envelope só quando definidos e exigem agente 0.5.0', async () => {
    const put = (b: object) => call(admin, 'PUT', `/api/plans/${planId}/network`, b);
    expect((await put({ rate_limit: 'bem rápido', address_pool: null })).status).toBe(400);
    expect((await put({ rate_limit: RATE, address_pool: 'pool com espaço' })).status).toBe(400);
    expect((await call(fin, 'PUT', `/api/plans/${planId}/network`, { rate_limit: RATE, address_pool: null })).status).toBe(403);
    const ok = await put({ rate_limit: RATE, address_pool: 'pool-clientes' });
    expect(ok.status).toBe(200);
    expect(ok.body.accounts_to_reapply).toBeGreaterThanOrEqual(2);
    expect((await call(admin, 'PATCH', `/api/devices/${deviceId}`, { simultaneous_use: 0 })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/api/devices/${deviceId}`, { simultaneous_use: 1, acct_interim_seconds: 300 })).body).toMatchObject({ simultaneous_use: 1, acct_interim_seconds: 300 });

    const c = await conta('c');
    expect(c.status).toBe(200);
    expect((await lastOp(c.contractId)).parameters).toMatchObject({ rate_limit: RATE, address_pool: 'pool-clientes', simultaneous_use: 1, acct_interim: 300 });
    // agente antigo recusaria o campo: a API não entrega
    await hello('0.4.0');
    expect((await call(admin, 'POST', `/api/resources/${c.resourceId}/provision`, {})).status).toBe(409);
    await hello('0.5.0');

    // reaplicar: só as contas liberadas e sem operação em curso
    const r = (await call(admin, 'POST', `/api/plans/${planId}/reapply`)).body;
    expect(r.requested + r.refused).toBeGreaterThanOrEqual(0);
    // limpar: sem parâmetros o envelope volta a não trazer os campos
    await put({ rate_limit: null, address_pool: null });
    await call(admin, 'PATCH', `/api/devices/${deviceId}`, { simultaneous_use: null, acct_interim_seconds: null });
    const d = await conta('d');
    const p = (await lastOp(d.contractId)).parameters;
    for (const k of ['rate_limit', 'address_pool', 'simultaneous_use', 'acct_interim', 'reconnect']) expect(p).not.toHaveProperty(k);
  });
});
