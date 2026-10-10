import { beforeAll, describe, expect, it } from 'vitest';
import { fakeCpf } from '../src/seed.js';
import { agentCall, call, login, testAgent } from './helpers.js';

// Expansão 5: o NOC e o diagnóstico só leem. As regressões cobrem a distinção entre falha individual e coletiva,
// o limiar de sinal definido pelo provedor e o isolamento.
let admin: string, token: string, oltId: string;
const tag = String(Date.now()).slice(-6), SESSION = `noc-${tag}`, PON = '0/9/1';
const onus: { id: string; contractId: string }[] = [];
const obs = (state: string, online = true, rx = -20) => ({ state, online, rx_dbm: state === 'authorized' ? rx : null, tx_dbm: state === 'authorized' ? 2 : null, at: new Date().toISOString() });
const report = (states: any[]) => agentCall(token, 'olt-report', { device_id: oltId, complete: false, unauthorized: [], states });
const overview = async (t = admin) => (await call(t, 'GET', '/api/noc/overview')).body;
const diag = async (i: number, t = admin) => (await call(t, 'GET', `/api/contracts/${onus[i].contractId}/diagnosis`)).body;
const mine = (o: any, kind: string) => o.alerts.filter((a: any) => a.kind === kind && (a.title.includes(`olt-${SESSION}`) || JSON.stringify(a.items ?? []).includes(`olt-${SESSION}`)));

async function newContract(i: number) {
  const s = (await call(admin, 'POST', '/api/subscribers', { name: `NOC ${tag} ${i}`, document: fakeCpf(Number(tag) * 10 + i), phone: '11900000000' })).body;
  const plan = (await call(admin, 'GET', '/api/plans')).body[0];
  return (await call(admin, 'POST', '/api/contracts', { subscriber_id: s.id, plan_id: plan.id, due_day: 10 })).body;
}

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-${SESSION}` })).body;
  token = a.token;
  oltId = (await call(admin, 'POST', '/api/devices', { name: `olt-${SESSION}`, driver: 'olt_demo', agent_id: a.id })).body.id;
  await agentCall(token, 'hello', { session_id: SESSION, version: 'teste' });
  await agentCall(token, 'sync-done', { session_id: SESSION, observations: [] });
  for (let i = 0; i < 4; i++) {
    const k = await newContract(i);
    const r = (await call(admin, 'POST', `/api/contracts/${k.id}/onu`, { device_id: oltId, serial: `NOCT${tag}${i}0`, pon_port: PON, line_profile: 'res', service_vlan: 100 })).body;
    const d = (await agentCall(token, 'poll', { session_id: SESSION })).body.operation;
    await agentCall(token, `attempts/${d.attempt_id}/begin`);
    await agentCall(token, `attempts/${d.attempt_id}/result`, { outcome: 'SUCCEEDED', steps: [], onu_observed: obs('authorized') });
    onus.push({ id: r.onu_id, contractId: k.id });
  }
});

describe('NOC e diagnóstico', () => {
  it('tudo online: sem alerta para a porta; diagnóstico mostra a evidência com data', async () => {
    const o = await overview();
    expect(o.pons.find((g: any) => g.device_id === oltId)).toMatchObject({ pon_port: PON, total: 4, down: 0, outage: false });
    expect(mine(o, 'pon_outage')).toHaveLength(0);
    const d = await diag(0);
    const ok = d.findings.find((f: any) => f.code === 'onu_ok');
    expect(ok.evidence.find((e: any) => e.label === 'RX')).toMatchObject({ value: expect.stringContaining('-20.00 dBm') });
    expect(ok.evidence[0].at).toBeTruthy();
    expect(d.findings.some((f: any) => f.code === 'not_provisioned')).toBe(true);      // sem conta PPPoE
  });

  it('uma ONU offline com vizinhas normais = problema no assinante; metade da porta offline = falha coletiva', async () => {
    await report([{ onu_id: onus[0].id, ...obs('authorized', false) }]);
    let d = await diag(0);
    expect(d.findings[0]).toMatchObject({ code: 'onu_offline', severity: 'warning' });
    expect(d.verdict).toContain('endereço do assinante');
    let o = await overview();
    expect(mine(o, 'pon_outage')).toHaveLength(0);
    expect(mine(o, 'onu_down')).toHaveLength(1);

    await report([1, 2].map((i) => ({ onu_id: onus[i].id, ...obs('authorized', false) })));
    o = await overview();
    expect(mine(o, 'pon_outage')[0]).toMatchObject({ severity: 'critical', detail: expect.stringContaining('3 de 4') });
    expect(mine(o, 'onu_down')).toHaveLength(0);                                        // as três já estão explicadas pela falha coletiva
    d = await diag(0);
    expect(d).toMatchObject({ severity: 'critical' });
    expect(d.findings[0]).toMatchObject({ code: 'pon_outage' });
    expect(d.findings[0].suggestion).toContain('visita individual');
    expect((await diag(3)).findings.some((f: any) => f.code === 'onu_ok')).toBe(true); // a que continua online não é afetada

    // limite de falha coletiva é do provedor: com mínimo 4, três offline deixam de ser tratadas como coletivas
    await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: null, pon_outage_min: 4 });
    expect(mine(await overview(), 'pon_outage')).toHaveLength(0);
    await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: null, pon_outage_min: 3 });
    await report(onus.map((n) => ({ onu_id: n.id, ...obs('authorized') })));
  });

  it('sinal fraco só existe quando o provedor define o limite', async () => {
    await report([{ onu_id: onus[3].id, ...obs('authorized', true, -27.5) }]);
    expect(mine(await overview(), 'onu_weak')).toHaveLength(0);
    expect((await diag(3)).findings.find((f: any) => f.code === 'onu_ok').evidence.at(-1).value).toContain('não definiu limite');
    expect((await call(await login('atendimento@alfa.demo'), 'PUT', '/api/noc/settings', { onu_rx_min_dbm: -25, pon_outage_min: 3 })).status).toBe(403);
    expect((await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: -25, pon_outage_min: 3 })).body.onu_rx_min_dbm).toBe(-25);
    expect(mine(await overview(), 'onu_weak')).toHaveLength(1);
    expect((await diag(3)).findings[0]).toMatchObject({ code: 'onu_weak', severity: 'warning' });
    expect((await diag(0)).findings.some((f: any) => f.code === 'onu_weak')).toBe(false);
    await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: null, pon_outage_min: 3 });
  });

  it('suspensão aparece como causa, com o financeiro só para quem pode vê-lo; outro provedor não acessa', async () => {
    const ag = await testAgent(admin, `noc-nas-${tag}`);
    const k = onus[1].contractId;
    const s = (await call(admin, 'POST', `/api/contracts/${k}/service`, { device_id: ag.deviceId, pppoe_username: `noc${tag}` })).body;
    await ag.runNext();
    expect((await call(admin, 'GET', `/api/contracts/${k}/diagnosis`)).body.findings.some((f: any) => f.code === 'no_session')).toBe(true);
    await call(admin, 'POST', `/api/resources/${s.resource_id}/suspend`, { reason: 'inadimplência' });
    await ag.runNext();
    const d = (await call(admin, 'GET', `/api/contracts/${k}/diagnosis`)).body;
    const sus = d.findings.find((f: any) => f.code === 'suspended');
    expect(sus.title).toContain('inadimplência');
    expect(sus.evidence.some((e: any) => e.label === 'Faturas vencidas')).toBe(true);
    const nocView = (await call(await login('noc@alfa.demo'), 'GET', `/api/contracts/${k}/diagnosis`)).body.findings.find((f: any) => f.code === 'suspended');
    expect(nocView.evidence.some((e: any) => e.label === 'Faturas vencidas')).toBe(false);
    expect(nocView.evidence.some((e: any) => e.value === 'não visível para o seu perfil')).toBe(true);

    const beta = await login('admin@beta.demo');
    expect((await call(beta, 'GET', `/api/contracts/${k}/diagnosis`)).status).toBe(404);
    expect(JSON.stringify(await overview(beta))).not.toContain(SESSION);
    expect((await call(await login('financeiro@alfa.demo'), 'GET', '/api/noc/overview')).status).toBe(403);
    // diagnóstico e painel não criam operações
    const antes = (await call(admin, 'GET', '/api/operations')).body.length;
    await overview(); await diag(0);
    expect((await call(admin, 'GET', '/api/operations')).body.length).toBe(antes);
  });
  it('encerrar contrato só desautoriza a ONU se o provedor ligou a regra', async () => {
    const poll = async () => (await agentCall(token, 'poll', { session_id: SESSION })).body.operation;
    await call(admin, 'PATCH', `/api/contracts/${onus[2].contractId}`, { end: true });
    expect(await poll()).toBeNull();                                           // regra desligada (padrão): só o aviso no painel
    expect((await call(admin, 'GET', `/api/contracts/${onus[2].contractId}/onu`)).body.onu.desired_state).toBe('authorized');
    expect((await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: null, pon_outage_min: 3, onu_remove_on_contract_end: true })).body.onu_remove_on_contract_end).toBe(true);
    await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: null, pon_outage_min: 3 });   // omitir a regra não a desliga
    await call(admin, 'PATCH', `/api/contracts/${onus[3].contractId}`, { end: true });
    const d = await poll();
    expect(JSON.parse(d.envelope)).toMatchObject({ action: 'onu.deauthorize', resource_id: onus[3].id });
    expect((await call(admin, 'GET', `/api/contracts/${onus[3].contractId}/onu`)).body.onu).toMatchObject({ desired_state: 'removed', desired_reason: 'contrato encerrado' });
    await call(admin, 'PUT', '/api/noc/settings', { onu_rx_min_dbm: null, pon_outage_min: 3, onu_remove_on_contract_end: false });
  });
});
