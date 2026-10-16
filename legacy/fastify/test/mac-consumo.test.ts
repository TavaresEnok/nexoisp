import { beforeAll, describe, expect, it } from 'vitest';
import { agentCall, call, freeContract, login } from './helpers.js';

// Vínculo de MAC e consumo mensal (agente 0.4.0+).
let admin: string, agentToken: string, deviceId: string, contractId: string, resourceId: string;
const SESSION = `sess-mac-${Date.now()}`;
const hello = (version: string) => agentCall(agentToken, 'hello', { session_id: SESSION, version });
const lastEnvelope = async () => {
  const svc = (await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body;
  return (await call(admin, 'GET', `/api/operations/${svc.operations[0].id}`)).body.parameters;
};

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-mac-${Date.now()}` })).body;
  agentToken = a.token;
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-mac-${Date.now()}`, driver: 'demo', agent_id: a.id })).body.id;
  const k = await freeContract(admin);
  contractId = k.id;
  const s = await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: deviceId, pppoe_username: `mac${Date.now()}` });
  resourceId = s.body.resource_id;
});

describe('vínculo de MAC', () => {
  it('normaliza, valida e só segue com agente que entende o campo', async () => {
    await hello('0.3.0');
    expect((await call(admin, 'PATCH', `/api/resources/${resourceId}/mac`, { mac: 'não é mac' })).status).toBe(400);
    // agente antigo: o envelope não seria aceito, então a API recusa em vez de enfileirar
    const old = await call(admin, 'PATCH', `/api/resources/${resourceId}/mac`, { mac: '02-4e-58-00-00-02' });
    expect(old.status).toBe(409);
    expect(old.body.error).toMatch(/0\.4\.0/);

    await hello('0.4.0');
    const ok = await call(admin, 'PATCH', `/api/resources/${resourceId}/mac`, { mac: '02-4e-58-00-00-02' });
    expect(ok.status).toBe(200);
    expect(ok.body.changed).toBe(true);
    expect((await lastEnvelope()).mac).toBe('02:4E:58:00:00:02');
    expect((await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body.resource.mac).toBe('02:4E:58:00:00:02');
    // mesmo valor: nada a fazer
    expect((await call(admin, 'PATCH', `/api/resources/${resourceId}/mac`, { mac: '02:4E:58:00:00:02' })).body.changed).toBe(false);
    // desvincular tira o campo do envelope
    expect((await call(admin, 'PATCH', `/api/resources/${resourceId}/mac`, { mac: null })).body.changed).toBe(true);
    expect((await lastEnvelope()).mac).toBeUndefined();
  });
});

describe('consumo mensal', () => {
  it('o relato do agente substitui o anterior, só vale para contas do equipamento e aparece para a equipe e para o assinante', async () => {
    const mes = new Date().toISOString().slice(0, 7);
    const rel = (items: object[], dev = deviceId) => agentCall(agentToken, 'usage-report', { device_id: dev, items });
    const r1 = await rel([{ resource_id: resourceId, month: mes, bytes_in: 1000, bytes_out: 5000, session_seconds: 3600, sessions: 2 }]);
    expect(r1.body).toMatchObject({ ok: true, accepted: 1 });
    await rel([{ resource_id: resourceId, month: mes, bytes_in: 2000, bytes_out: 9000, session_seconds: 7200, sessions: 3 }]);
    const u = (await call(admin, 'GET', `/api/contracts/${contractId}/usage`)).body;
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ month: mes, bytes_in: 2000, bytes_out: 9000, sessions: 3 });

    // conta de outro equipamento/agente não é aceita; equipamento que não é do agente é recusado
    const outro = (await call(admin, 'POST', '/api/devices', { name: `nas-outro-${Date.now()}`, driver: 'demo' })).body;
    expect((await rel([{ resource_id: resourceId, month: mes, bytes_in: 1, bytes_out: 1, session_seconds: 1, sessions: 1 }], outro.id)).status).toBe(404);
    expect((await rel([{ resource_id: resourceId, month: '2026-13', bytes_in: 1, bytes_out: 1, session_seconds: 1, sessions: 1 }])).status).toBe(400);

    // o assinante vê o próprio consumo; outro assinante, não
    const k = (await call(admin, 'GET', '/api/contracts?status=active')).body.find((c: any) => c.id === contractId);
    const email = `consumo-${Date.now()}@teste.local`;
    await call(admin, 'POST', `/api/subscribers/${k.subscriber_id}/portal-access`, { email, password: 'demo1234' });
    const sub = await login(email);
    const usage = (await call(sub, 'GET', '/api/portal/overview')).body.usage;
    expect(usage).toEqual([{ contract_id: contractId, month: mes, bytes_in: 2000, bytes_out: 9000, sessions: 3 }]);
    const alheio = (await call(admin, 'GET', '/api/contracts?status=active')).body.find((c: any) => c.subscriber_id !== k.subscriber_id);
    const email2 = `consumo2-${Date.now()}@teste.local`;
    await call(admin, 'POST', `/api/subscribers/${alheio.subscriber_id}/portal-access`, { email: email2, password: 'demo1234' });
    expect((await call(await login(email2), 'GET', '/api/portal/overview')).body.usage.some((x: any) => x.contract_id === contractId)).toBe(false);
  });
});
