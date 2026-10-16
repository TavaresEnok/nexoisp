import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentCall, call, freeContract, login } from './helpers.js';

// Suspensão por perfil de bloqueio: configuração por provedor, exigência de agente 0.4.0 e conta encerrada sempre rejeitada.
let admin: string, agentToken: string, deviceId: string;
const SESSION = `sess-perfil-${Date.now()}`;
const settings = async (extra: object) =>
  call(admin, 'PUT', '/api/finance/settings', { gateway: 'none', billing_auto: false, auto_suspend: false, suspend_after_days: null, auto_resume_on_payment: false, ...extra });
const hello = (version: string) => agentCall(agentToken, 'hello', { session_id: SESSION, version });
async function provision(): Promise<{ contractId: string; resourceId: string }> {
  const k = await freeContract(admin);
  const s = await call(admin, 'POST', `/api/contracts/${k.id}/service`, { device_id: deviceId, pppoe_username: `perfil${Date.now()}${Math.floor(Math.random() * 1000)}` });
  expect(s.status).toBe(200);
  return { contractId: k.id, resourceId: s.body.resource_id };
}
/** Última tarefa do recurso, lida do próprio envelope assinado. */
async function lastEnvelope(contractId: string) {
  const svc = (await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body;
  const op = (await call(admin, 'GET', `/api/operations/${svc.operations[0].id}`)).body;
  return { op, params: op.parameters };
}

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-perfil-${Date.now()}` })).body;
  agentToken = a.token;
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-perfil-${Date.now()}`, driver: 'demo', agent_id: a.id })).body.id;
});
afterAll(async () => { await settings({ suspension_mode: 'reject' }); });

describe('suspensão por perfil de bloqueio', () => {
  it('a modalidade por perfil exige o nome do perfil e o padrão continua sendo a rejeição', async () => {
    expect((await call(admin, 'GET', '/api/finance/settings')).body.suspension_mode).toBe('reject');
    expect((await settings({ suspension_mode: 'profile' })).status).toBe(400);
    expect((await settings({ suspension_mode: 'profile', suspension_profile: 'nome com espaço' })).status).toBe(400);
    const ok = await settings({ suspension_mode: 'profile', suspension_profile: 'nexo-bloqueado' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ suspension_mode: 'profile', suspension_profile: 'nexo-bloqueado' });
    // salvar de novo sem os campos novos não desfaz a escolha
    expect((await settings({})).body).toMatchObject({ suspension_mode: 'profile', suspension_profile: 'nexo-bloqueado' });
  });

  it('agente anterior à 0.4.0 recusaria o envelope: a API não o emite', async () => {
    await hello('0.3.0');
    const { resourceId } = await provision();
    const r = await call(admin, 'POST', `/api/resources/${resourceId}/suspend`, { reason: 'teste' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/0\.4\.0/);
  });

  it('com agente 0.4.0 o envelope traz o perfil; contrato encerrado continua sendo rejeitado', async () => {
    await hello('0.4.0');
    const a = await provision();
    // com IP fixo: ativo leva o endereço; suspenso por perfil não (precisa cair no endereço de bloqueio)
    const octet = 100 + Math.floor(Math.random() * 100);
    const pool = (await call(admin, 'POST', '/api/ipam/pools', { name: `ip-fixo-${Date.now()}`, cidr: `10.${octet}.${Math.floor(Math.random() * 200)}.0/24`, kind: 'cgnat' })).body;
    const alloc = await call(admin, 'POST', `/api/ipam/pools/${pool.id}/allocations`, { contract_id: a.contractId });
    expect(alloc.status).toBe(200);
    expect((await lastEnvelope(a.contractId)).params.framed_ip).toBe(alloc.body.address);
    expect((await call(admin, 'POST', `/api/resources/${a.resourceId}/suspend`, { reason: 'teste' })).status).toBe(200);
    const susp = (await lastEnvelope(a.contractId)).params;
    expect(susp.suspension).toEqual({ mode: 'profile', profile: 'nexo-bloqueado', session: 'disconnect' });
    expect(susp.framed_ip).toBeUndefined();
    await call(admin, 'POST', `/api/resources/${a.resourceId}/resume`, { reason: 'teste' });
    expect((await lastEnvelope(a.contractId)).params.framed_ip).toBe(alloc.body.address);

    const b = await provision();
    expect((await call(admin, 'PATCH', `/api/contracts/${b.contractId}`, { end: true })).status).toBe(200);
    const e = await lastEnvelope(b.contractId);
    expect(e.op.action).toBe('subscriber.suspend');
    expect(e.params.suspension).toEqual({ mode: 'reject', session: 'disconnect' });
  });

  it('na modalidade de rejeição o envelope continua o de sempre', async () => {
    await settings({ suspension_mode: 'reject' });
    const c = await provision();
    await call(admin, 'POST', `/api/resources/${c.resourceId}/suspend`, { reason: 'teste' });
    expect((await lastEnvelope(c.contractId)).params.suspension).toEqual({ mode: 'reject', session: 'disconnect' });
  });
});
