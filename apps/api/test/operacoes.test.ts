import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildAgentApp } from '../src/agent-api.js';
import { withScope } from '../src/db.js';
import { call, freeContract, login } from './helpers.js';

// Regressões essenciais do motor: suspensão obsoleta não executa; efeito incerto é verificado antes de repetir;
// reentrega de resultado é idempotente; resultado antigo não altera a intenção atual.
let agentApp: FastifyInstance;
let admin: string, agentToken: string, resourceId: string, contractId: string, tenantId: string;
const SESSION = 'sessao-teste-0001';

async function agent(token: string, path: string, body: unknown = {}) {
  const r = await agentApp.inject({ method: 'POST', url: `/agent/v1/${path}`, payload: body as any, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
}
const poll = async () => (await agent(agentToken, 'poll', { session_id: SESSION })).body;
let profile = '';
const obs = (policy: string) => ({ policy, profile, session: null, at: new Date().toISOString() });
const service = async () => (await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body;
const request = async (action: string) => (await call(admin, 'POST', `/api/resources/${resourceId}/${action}`, { reason: 'teste' })).body;
const opStatus = async (id: string) => (await call(admin, 'GET', `/api/operations/${id}`)).body.status;

beforeAll(async () => {
  agentApp = (await buildAgentApp())!;
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-teste-${Date.now()}` })).body;
  agentToken = a.token;
  const dev = (await call(admin, 'POST', '/api/devices', { name: `nas-teste-${Date.now()}`, driver: 'demo', agent_id: a.id })).body;
  const k = await freeContract(admin);
  contractId = k.id;
  profile = k.profile_name;
  const s = await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: dev.id, pppoe_username: `teste${Date.now()}` });
  expect(s.status).toBe(200);
  expect(s.body.generated_password).toBeTruthy();
  resourceId = s.body.resource_id;
});

describe('motor de operações de rede', () => {
  it('agente só recebe escritas depois da sincronização completa', async () => {
    expect((await poll()).need_sync).toBe(true);
    const h = (await agent(agentToken, 'hello', { session_id: SESSION, version: 'teste' })).body;
    expect(h.snapshot.complete).toBe(true);
    await agent(agentToken, 'sync-done', { session_id: SESSION, observations: [] });
  });

  it('provisiona: begin revalida e entrega o segredo fora do envelope; resultado registra a observação', async () => {
    const d = (await poll()).operation;
    const env = JSON.parse(d.envelope);
    expect(env.action).toBe('subscriber.provision');
    expect(d.envelope).not.toMatch(/password|secret"\s*:/);
    const b = (await agent(agentToken, `attempts/${d.attempt_id}/begin`)).body;
    expect(b.go).toBe(true);
    expect(b.secret).toBeTruthy();
    const r = (await agent(agentToken, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], observed: obs('active') })).body;
    expect(r.status).toBe('SUCCEEDED');
    // reentrega do mesmo resultado: reconhecida, sem novo efeito
    const dup = (await agent(agentToken, `attempts/${d.attempt_id}/result`, { outcome: 'FAILED', steps: [], error: 'x' })).body;
    expect(dup).toMatchObject({ duplicate: true, status: 'SUCCEEDED' });
    const s = (await service()).resource;
    expect(s).toMatchObject({ desired_policy: 'active', observed_policy: 'active', observed_version: 1, drift: false });
  });

  it('suspensão ainda não iniciada é substituída quando a intenção muda (pagamento antes da execução)', async () => {
    const susp = await request('suspend');
    const res = await request('resume');
    expect(await opStatus(susp.operation_id)).toBe('SUPERSEDED');
    const d = (await poll()).operation;
    expect(JSON.parse(d.envelope).operation_id).toBe(res.operation_id);
    await agent(agentToken, `attempts/${d.attempt_id}/begin`);
    await agent(agentToken, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], observed: obs('active') });
    expect((await service()).resource.desired_policy).toBe('active');
  });

  it('suspensão já reservada pelo agente é barrada na revalidação (begin) se ficou obsoleta', async () => {
    const susp = await request('suspend');
    const d = (await poll()).operation; // agente já pegou a suspensão
    expect(JSON.parse(d.envelope).operation_id).toBe(susp.operation_id);
    const res = await request('resume'); // intenção mudou antes da escrita
    const b = (await agent(agentToken, `attempts/${d.attempt_id}/begin`)).body;
    expect(b).toMatchObject({ go: false, reason: 'superseded' });
    expect(await opStatus(susp.operation_id)).toBe('SUPERSEDED');
    const d2 = (await poll()).operation;
    expect(JSON.parse(d2.envelope).operation_id).toBe(res.operation_id);
    await agent(agentToken, `attempts/${d2.attempt_id}/begin`);
    await agent(agentToken, `attempts/${d2.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], observed: obs('active') });
  });

  it('posse expirada durante execução vira UNCERTAIN, bloqueia o equipamento e é reentregue para verificação antes de repetir', async () => {
    const susp = await request('suspend');
    const d = (await poll()).operation;
    expect((await agent(agentToken, `attempts/${d.attempt_id}/begin`)).body.go).toBe(true);
    await withScope({ tenantId, operator: false }, (c) => c.query(`update operations set lease_until = now() - interval '1 second' where id = $1`, [susp.operation_id]));
    const res = await request('resume'); // intenção muda enquanto a anterior está incerta
    expect(await opStatus(susp.operation_id)).toBe('UNCERTAIN');
    const health = (await call(admin, 'GET', '/api/network/health')).body;
    expect(health.uncertain).toBe(1);

    const d2 = (await poll()).operation; // a incerta vem primeiro, marcada para recuperação
    expect(JSON.parse(d2.envelope).operation_id).toBe(susp.operation_id);
    expect(d2.recover).toBe(true);
    // agente consultou e encontrou o efeito aplicado: relata sem repetir
    const r = (await agent(agentToken, `attempts/${d2.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], recovered: true, observed: obs('suspended') })).body;
    expect(r.status).toBe('SUCCEEDED');
    // resultado antigo NÃO substituiu a intenção atual
    let s = (await service()).resource;
    expect(s).toMatchObject({ desired_policy: 'active', observed_policy: 'suspended' });
    expect(s.desired_version).toBeGreaterThan(s.observed_version);
    // e a intenção atual converge em seguida
    const d3 = (await poll()).operation;
    expect(JSON.parse(d3.envelope).operation_id).toBe(res.operation_id);
    await agent(agentToken, `attempts/${d3.attempt_id}/begin`);
    await agent(agentToken, `attempts/${d3.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], observed: obs('active') });
    s = (await service()).resource;
    expect(s).toMatchObject({ desired_policy: 'active', observed_policy: 'active', drift: false });
    expect(s.observed_version).toBe(s.desired_version);
    expect((await poll()).operation).toBeNull();
  });

  it('incerta cuja consulta mostra que nada foi aplicado e que ficou obsoleta não é reexecutada', async () => {
    const susp = await request('suspend');
    const d = (await poll()).operation;
    await agent(agentToken, `attempts/${d.attempt_id}/begin`);
    await withScope({ tenantId, operator: false }, (c) => c.query(`update operations set lease_until = now() - interval '1 second' where id = $1`, [susp.operation_id]));
    const res = await request('resume');
    const d2 = (await poll()).operation;
    expect(d2.recover).toBe(true);
    const r = (await agent(agentToken, `attempts/${d2.attempt_id}/result`, { outcome: 'NOT_APPLIED', steps: [], recovered: true, observed: obs('active') })).body;
    expect(r.status).toBe('SUPERSEDED');
    const d3 = (await poll()).operation;
    expect(JSON.parse(d3.envelope).operation_id).toBe(res.operation_id);
    await agent(agentToken, `attempts/${d3.attempt_id}/begin`);
    await agent(agentToken, `attempts/${d3.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], observed: obs('active') });
  });

  it('alteração manual externa aparece como divergência, sem correção automática', async () => {
    await agent(agentToken, 'observations', { items: [{ resource_id: resourceId, ...obs('suspended') }] });
    const s = (await service()).resource;
    expect(s).toMatchObject({ desired_policy: 'active', observed_policy: 'suspended', drift: true });
    expect((await poll()).operation).toBeNull();
    await agent(agentToken, 'observations', { items: [{ resource_id: resourceId, ...obs('active') }] });
  });

  it('agente de outro provedor não alcança tentativas nem recursos deste', async () => {
    const beta = await login('admin@beta.demo');
    const b = (await call(beta, 'POST', '/api/agents', { name: `agente-beta-${Date.now()}` })).body;
    const susp = await request('suspend');
    const d = (await poll()).operation;
    expect((await agent(b.token, `attempts/${d.attempt_id}/begin`)).status).toBe(404);
    expect((await agent(b.token, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [] })).status).toBe(404);
    await agent(b.token, 'observations', { items: [{ resource_id: resourceId, ...obs('absent') }] });
    expect((await service()).resource.observed_policy).toBe('active');
    expect(await opStatus(susp.operation_id)).toBe('RESERVED');
    expect((await agent('token-invalido', 'poll', { session_id: 'x' })).status).toBe(401);
    // limpa: conclui a suspensão e reativa
    await agent(agentToken, `attempts/${d.attempt_id}/begin`);
    await agent(agentToken, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], observed: obs('suspended') });
  });
});
