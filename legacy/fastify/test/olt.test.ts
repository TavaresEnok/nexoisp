import { beforeAll, describe, expect, it } from 'vitest';
import { agentCall, call, freeContract, login } from './helpers.js';

// Expansão OLT/ONU: descoberta, autorização, leitura de estado — com as mesmas proteções do motor (obsoleta, isolamento).
let admin: string, token: string, oltId: string, contractId: string, onuId: string;
const SESSION = `olt-${Date.now()}`;
const SERIAL = `FHTT${String(Date.now()).slice(-8)}`;
const poll = async () => (await agentCall(token, 'poll', { session_id: SESSION })).body.operation;
const onu = async () => (await call(admin, 'GET', `/api/contracts/${contractId}/onu`)).body;
const obs = (state: string, online = true) => ({ state, online, rx_dbm: state === 'authorized' ? -19.5 : null, tx_dbm: state === 'authorized' ? 2.1 : null, at: new Date().toISOString() });
const report = (unauthorized: any[], states: any[] = [], complete = true) => agentCall(token, 'olt-report', { device_id: oltId, complete, unauthorized, states });

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-${SESSION}` })).body;
  token = a.token;
  oltId = (await call(admin, 'POST', '/api/devices', { name: `olt-${SESSION}`, driver: 'olt_demo', agent_id: a.id })).body.id;
  await agentCall(token, 'hello', { session_id: SESSION, version: 'teste' });
  await agentCall(token, 'sync-done', { session_id: SESSION, observations: [] });
  contractId = (await freeContract(admin, (k) => true)).id;
});

describe('OLT/ONU', () => {
  it('descoberta: relato completo substitui a lista; parcial não remove; outro provedor não vê', async () => {
    await report([{ serial: SERIAL, pon_port: '0/1/3', vendor: 'FHTT', model: 'x' }, { serial: 'ZTEG00000001', pon_port: '0/1/4' }]);
    let d = (await call(admin, 'GET', '/api/olt/discoveries')).body.filter((x: any) => x.device_id === oltId);
    expect(d.map((x: any) => x.serial).sort()).toEqual([SERIAL, 'ZTEG00000001'].sort());
    await report([{ serial: SERIAL, pon_port: '0/1/3' }], [], false);       // parcial: a outra continua listada
    expect((await call(admin, 'GET', '/api/olt/discoveries')).body.filter((x: any) => x.device_id === oltId)).toHaveLength(2);
    await report([{ serial: SERIAL, pon_port: '0/1/3' }]);                  // completo: a outra some
    d = (await call(admin, 'GET', '/api/olt/discoveries')).body.filter((x: any) => x.device_id === oltId);
    expect(d.map((x: any) => x.serial)).toEqual([SERIAL]);
    const beta = await login('admin@beta.demo');
    expect((await call(beta, 'GET', '/api/olt/discoveries')).body.some((x: any) => x.serial === SERIAL)).toBe(false);
    expect((await call(beta, 'GET', '/api/onus')).body.some((x: any) => x.serial === SERIAL)).toBe(false);
  });

  it('autoriza: operação assinada passa pelo agente; estado e sinal ficam registrados com data', async () => {
    const bad = await call(admin, 'POST', `/api/contracts/${contractId}/onu`, { device_id: oltId, serial: SERIAL, pon_port: 'gpon0/1', line_profile: 'residencial', service_vlan: 100 });
    expect(bad.status).toBe(400);
    const r = await call(admin, 'POST', `/api/contracts/${contractId}/onu`, { device_id: oltId, serial: SERIAL.toLowerCase(), pon_port: '0/1/3', line_profile: 'residencial', service_vlan: 100 });
    expect(r.status).toBe(200);
    onuId = r.body.onu_id;
    const d = await poll();
    const env = JSON.parse(d.envelope);
    expect(env).toMatchObject({ action: 'onu.authorize', resource_id: onuId, parameters: { serial: SERIAL, pon_port: '0/1/3', service_vlan: 100, state: 'authorized' } });
    expect(env.parameters.description).toMatch(/^nexo:[0-9a-f]{8}:v1$/);
    expect((await agentCall(token, `attempts/${d.attempt_id}/begin`)).body).toEqual({ go: true });
    expect((await agentCall(token, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], onu_observed: obs('authorized') })).body.status).toBe('SUCCEEDED');
    const s = await onu();
    expect(s.onu).toMatchObject({ serial: SERIAL, desired_state: 'authorized', observed_state: 'authorized', observed_online: true, observed_version: 1, drift: false });
    expect(Number(s.onu.observed_rx_dbm)).toBe(-19.5);
    expect(s.operations[0]).toMatchObject({ action: 'onu.authorize', status: 'SUCCEEDED' });
    // ONU autorizada sai da lista de pendentes e aparece na lista geral de operações
    expect((await call(admin, 'GET', '/api/olt/discoveries')).body.some((x: any) => x.serial === SERIAL)).toBe(false);
    expect((await call(admin, 'GET', '/api/operations')).body.some((o: any) => o.pppoe_username === `ONU ${SERIAL}`)).toBe(true);
    // mesmo serial ou mesmo contrato não podem ser vinculados de novo
    expect((await call(admin, 'POST', `/api/contracts/${contractId}/onu`, { device_id: oltId, serial: 'OUTRA0000001', pon_port: '0/1/3', line_profile: 'x', service_vlan: 100 })).status).toBe(409);
  });

  it('leitura periódica atualiza sinal; remoção manual na OLT aparece como divergência sem correção automática', async () => {
    await report([], [{ onu_id: onuId, ...obs('authorized', false) }]);
    expect((await onu()).onu).toMatchObject({ observed_online: false, drift: false });
    await report([{ serial: SERIAL, pon_port: '0/1/3' }], [{ onu_id: onuId, ...obs('absent') }]);
    expect((await onu()).onu).toMatchObject({ desired_state: 'authorized', observed_state: 'absent', drift: true });
    expect(await poll()).toBeNull();
    await report([], [{ onu_id: onuId, ...obs('authorized') }]);
  });

  it('desautorização obsoleta não executa; depois de removida, o contrato aceita a troca de ONU', async () => {
    const de = (await call(admin, 'POST', `/api/onus/${onuId}/deauthorize`, {})).body;
    const d = await poll();                                                     // agente já reservou a remoção
    const re = (await call(admin, 'POST', `/api/onus/${onuId}/authorize`, {})).body; // intenção mudou
    expect((await agentCall(token, `attempts/${d.attempt_id}/begin`)).body).toMatchObject({ go: false, reason: 'superseded' });
    expect((await call(admin, 'GET', `/api/operations/${de.operation_id}`)).body.status).toBe('SUPERSEDED');
    const d2 = await poll();
    expect(JSON.parse(d2.envelope).operation_id).toBe(re.operation_id);
    await agentCall(token, `attempts/${d2.attempt_id}/begin`);
    await agentCall(token, `attempts/${d2.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], onu_observed: obs('authorized') });

    await call(admin, 'POST', `/api/onus/${onuId}/deauthorize`, { reason: 'equipamento com defeito' });
    const d3 = await poll();
    await agentCall(token, `attempts/${d3.attempt_id}/begin`);
    await agentCall(token, `attempts/${d3.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], onu_observed: obs('absent') });
    expect((await onu()).onu).toMatchObject({ desired_state: 'removed', observed_state: 'absent', drift: false });
    const novo = `ZTEG${String(Date.now()).slice(-8)}`;
    const troca = await call(admin, 'POST', `/api/contracts/${contractId}/onu`, { device_id: oltId, serial: novo, pon_port: '0/2/1', line_profile: 'residencial', service_vlan: 100 });
    expect(troca.status).toBe(200);
    expect(troca.body.onu_id).toBe(onuId);
    expect((await onu()).onu).toMatchObject({ serial: novo, desired_state: 'authorized', observed_state: null });
    expect((await onu()).operations[0].reason).toContain(SERIAL);
  });

  it('OLT Huawei exige perfil de serviço e o envia ao agente', async () => {
    const a = (await call(admin, 'POST', '/api/agents', { name: `agente-hw-${SESSION}` })).body;
    const hw = (await call(admin, 'POST', '/api/devices', { name: `huawei-${SESSION}`, driver: 'olt_huawei', host: '192.0.2.10', api_port: 22, credential_ref: 'x', agent_id: a.id })).body;
    await agentCall(a.token, 'hello', { session_id: 'hw', version: 'teste' });
    await agentCall(a.token, 'sync-done', { session_id: 'hw', observations: [] });
    const k = await freeContract(admin, (c) => c.id !== contractId);
    const body = { device_id: hw.id, serial: '48575443A1B2C3D4', pon_port: '0/1/0', line_profile: 'residencial', service_vlan: 100 };
    const semPerfil = await call(admin, 'POST', `/api/contracts/${k.id}/onu`, body);
    expect(semPerfil.status).toBe(400);
    expect(semPerfil.body.error).toContain('perfil de serviço');
    expect((await call(admin, 'POST', `/api/contracts/${k.id}/onu`, { ...body, serial: 'HWTCA1B2C3D4', service_profile: 'bridge-1ge' })).status).toBe(200); // forma curta é convertida
    const d = (await agentCall(a.token, 'poll', { session_id: 'hw' })).body.operation;
    expect(JSON.parse(d.envelope).parameters).toMatchObject({ serial: '48575443A1B2C3D4', service_profile: 'bridge-1ge', line_profile: 'residencial' });
  });

  it('agente de outro provedor não relata nem altera ONUs deste; conta PPPoE não pode apontar para OLT', async () => {
    const beta = await login('admin@beta.demo');
    const b = (await call(beta, 'POST', '/api/agents', { name: `agente-beta-${SESSION}` })).body;
    expect((await agentCall(b.token, 'olt-report', { device_id: oltId, complete: true, unauthorized: [], states: [{ onu_id: onuId, ...obs('absent') }] })).status).toBe(404);
    const k = await freeContract(admin);
    expect((await call(admin, 'POST', `/api/contracts/${k.id}/service`, { device_id: oltId, pppoe_username: `x${Date.now()}` })).status).toBe(400);
    expect((await call(await login('financeiro@alfa.demo'), 'POST', `/api/onus/${onuId}/deauthorize`, {})).status).toBe(403);
  });
});
