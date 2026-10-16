import { beforeAll, describe, expect, it } from 'vitest';
import { agentCall, call, freeContract, login, testAgent } from './helpers.js';

// Atendimento no dia a dia: busca única, linha do tempo, sessões com motivo de encerramento, online, contatos e POP.
let admin: string, beta: string, fin: string, agentToken: string, deviceId: string, contract: any, resourceId: string, username: string;
const SESSION = `sess-atend-${Date.now()}`;
const tag = String(Date.now()).slice(-6);

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  fin = await login('financeiro@alfa.demo');
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-atend-${tag}` })).body;
  agentToken = a.token;
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-atend-${tag}`, driver: 'demo', agent_id: a.id })).body.id;
  await agentCall(agentToken, 'hello', { session_id: SESSION, version: '0.4.0' });
  contract = await freeContract(admin);
  username = `atend${tag}`;
  const s = await call(admin, 'POST', `/api/contracts/${contract.id}/service`, { device_id: deviceId, pppoe_username: username });
  resourceId = s.body.resource_id;
});

describe('sessões com motivo de encerramento', () => {
  it('o agente relata, a API guarda por sessão (idempotente) e a equipe consulta por período e em CSV', async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const items = [
      { resource_id: resourceId, session_key: 's1', started_at: day(3), stopped_at: day(3 - 0.1), ip: '100.64.7.10', mac: '02:4E:58:00:00:99', nas_ip: '10.0.0.1', bytes_in: 1000, bytes_out: 9000, seconds: 8640, terminate_cause: 'Lost-Carrier' },
      { resource_id: resourceId, session_key: 's2', started_at: day(1), stopped_at: null, ip: '100.64.7.10', mac: '02:4E:58:00:00:99', nas_ip: '10.0.0.1', bytes_in: 50, bytes_out: 70, seconds: 100, terminate_cause: null },
    ];
    const r = await agentCall(agentToken, 'sessions-report', { device_id: deviceId, items });
    expect(r.body).toMatchObject({ ok: true, accepted: 2 });
    // mesma sessão reportada de novo, agora encerrada: atualiza, não duplica
    await agentCall(agentToken, 'sessions-report', { device_id: deviceId, items: [{ ...items[1], stopped_at: day(0.5), terminate_cause: 'User-Request', seconds: 3600 }] });
    const s = (await call(admin, 'GET', `/api/contracts/${contract.id}/sessions`)).body;
    expect(s.rows).toHaveLength(2);
    expect(s.rows.find((x: any) => x.session_key === 's2')).toMatchObject({ terminate_cause: 'User-Request', seconds: 3600 });
    expect(s.totals).toMatchObject({ sessions: 2, bytes_in: 1050, bytes_out: 9070 });
    expect(s.daily.length).toBeGreaterThanOrEqual(1);
    const csv = await call(admin, 'GET', `/api/contracts/${contract.id}/sessions?format=csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('Lost-Carrier');
    // período: só a sessão de 1 dia atrás
    const d1 = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await call(admin, 'GET', `/api/contracts/${contract.id}/sessions?from=${d1}`)).body.rows).toHaveLength(1);
    // equipamento que não é do agente; conta de outro equipamento
    const outro = (await call(admin, 'POST', '/api/devices', { name: `nas-outro-${tag}`, driver: 'demo' })).body;
    expect((await agentCall(agentToken, 'sessions-report', { device_id: outro.id, items })).status).toBe(404);
    expect((await agentCall(agentToken, 'sessions-report', { device_id: deviceId, items: [{ ...items[0], resource_id: crypto.randomUUID(), session_key: 'x' }] })).body.accepted).toBe(0);
    // outro provedor não vê
    expect((await call(beta, 'GET', `/api/contracts/${contract.id}/sessions`)).body.rows ?? []).toHaveLength(0);
  });
});

describe('busca única', () => {
  it('acha pelo nome, login, IP e MAC, com o contexto do contrato; não vaza para outro provedor', async () => {
    const byLogin = (await call(admin, 'GET', `/api/search?q=${username}`)).body;
    expect(byLogin.results.length).toBeGreaterThanOrEqual(1);
    const r = byLogin.results.find((x: any) => x.contract_id === contract.id);
    expect(r).toMatchObject({ pppoe_username: username, contract_status: 'active' });
    expect(r.matched).toContain('login');
    expect(r.overdue).not.toBeNull();                       // o financeiro vê a inadimplência
    const byName = (await call(admin, 'GET', `/api/search?q=${encodeURIComponent(contract.subscriber_name.split(' ')[0])}`)).body;
    expect(byName.results.some((x: any) => x.contract_id === contract.id)).toBe(true);
    // IP de sessão anterior
    expect((await call(admin, 'GET', '/api/search?q=100.64.7.10')).body.results.some((x: any) => x.contract_id === contract.id)).toBe(true);
    expect((await call(beta, 'GET', `/api/search?q=${username}`)).body.results).toHaveLength(0);
    expect((await call(admin, 'GET', '/api/search?q=a')).status).toBe(400);                           // curto demais
    // quem não vê financeiro não recebe a inadimplência
    const f = (await call(fin, 'GET', `/api/search?q=${username}`)).body.results.find((x: any) => x.contract_id === contract.id);
    expect(f).toBeTruthy();
  });
});

describe('linha do tempo', () => {
  it('reúne contrato, rede, financeiro e OS em ordem, e respeita o provedor', async () => {
    await call(admin, 'POST', `/api/resources/${resourceId}/suspend`, { reason: 'teste da linha do tempo' });
    await call(admin, 'POST', '/api/invoices', { contract_id: contract.id, description: 'Avulsa da linha do tempo', amount_cents: 1234, due_date: new Date().toISOString().slice(0, 10) });
    const t = (await call(admin, 'GET', `/api/subscribers/${contract.subscriber_id}/timeline`)).body;
    const kinds = new Set(t.map((e: any) => e.kind));
    expect(kinds.has('contract')).toBe(true);
    expect(kinds.has('network')).toBe(true);
    expect(kinds.has('invoice')).toBe(true);
    expect(t.some((e: any) => e.title === 'Acesso suspenso' && String(e.detail).includes('teste da linha do tempo'))).toBe(true);
    for (let i = 1; i < t.length; i++) expect(+new Date(t[i - 1].at)).toBeGreaterThanOrEqual(+new Date(t[i].at));
    expect((await call(beta, 'GET', `/api/subscribers/${contract.subscriber_id}/timeline`)).status).toBe(404);
  });
});

describe('contatos, POP e online', () => {
  it('contatos por tipo com consentimento de avisos; POP com contagem; usuários online em CSV', async () => {
    const put = await call(admin, 'PUT', `/api/subscribers/${contract.subscriber_id}/contacts`, { contacts: [
      { kind: 'mobile', value: '(81) 99999-0001', purpose: 'billing', allow_notices: true },
      { kind: 'whatsapp', value: '(81) 99999-0002', purpose: 'general' },
      { kind: 'responsible', value: 'Fulano (pai)', label: 'responsável', purpose: 'technical' },
    ] });
    expect(put.status).toBe(200);
    expect(put.body).toHaveLength(3);
    expect(put.body.find((c: any) => c.kind === 'mobile')).toMatchObject({ purpose: 'billing', allow_notices: true });
    expect((await call(admin, 'PUT', `/api/subscribers/${contract.subscriber_id}/contacts`, { contacts: [{ kind: 'telegrama', value: 'x' }] })).status).toBe(400);
    expect((await call(beta, 'GET', `/api/subscribers/${contract.subscriber_id}/contacts`)).body).toEqual([]);

    const pop = (await call(admin, 'POST', '/api/pops', { name: `POP ${tag}`, city: 'Recife', state: 'pe' })).body;
    expect(pop.id).toBeTruthy();
    expect((await call(admin, 'POST', '/api/pops', { name: `POP ${tag}` })).status).toBe(409);
    expect((await call(admin, 'PUT', `/api/contracts/${contract.id}/pop`, { pop_id: pop.id })).status).toBe(200);
    const lista = (await call(admin, 'GET', '/api/pops')).body.find((p: any) => p.id === pop.id);
    expect(lista).toMatchObject({ name: `POP ${tag}`, state: 'PE', active_contracts: 1 });
    expect((await call(beta, 'PUT', `/api/contracts/${contract.id}/pop`, { pop_id: null })).status).toBe(404);

    const on = await call(admin, 'GET', '/api/network/online');
    expect(on.status).toBe(200);
    expect(Array.isArray(on.body.rows)).toBe(true);
    expect((await call(admin, 'GET', '/api/network/online?format=csv')).status).toBe(200);
    expect((await call(beta, 'GET', '/api/network/online')).body.rows.some((r: any) => r.login === username)).toBe(false);
  });
});

describe('disponibilidade por cliente (R4)', () => {
  it('soma o tempo com sessão aberta por dia, limita a 100% e ignora o que veio antes da conta', async () => {
    const admin = await login('admin@alfa.demo');
    const tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
    const ag = await testAgent(admin, `disp-${Date.now()}`);
    const tag = String(Date.now()).slice(-6);
    const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano disp ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `dp${tag}` })).body.id;
    const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Disp ${tag}` })).body;
    const ct = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
    expect((await call(admin, 'GET', `/api/contracts/${ct}/availability`)).body.days).toEqual([]);      // sem conta
    const resId = (await call(admin, 'POST', `/api/contracts/${ct}/service`, { device_id: ag.deviceId, pppoe_username: `dp${tag}` })).body.resource_id;
    // a conta existe desde 3 dias atrás; uma sessão de 2 h ontem e uma aberta há 30 min
    const h = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    const { withScope } = await import('../src/db.js');
    await withScope({ tenantId, operator: false }, async (c) => {
      await c.query(`update service_resources set created_at = now() - interval '3 days' where id = $1`, [resId]);
      await c.query(`insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip) values ($1,$2,'d1',$3,$4,'10.0.0.1')`, [tenantId, resId, h(36), h(34)]);
      await c.query(`insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip) values ($1,$2,'d2',$3,null,'10.0.0.1')`, [tenantId, resId, h(0.5)]);
    });
    const r = (await call(admin, 'GET', `/api/contracts/${ct}/availability?days=7`)).body;
    expect(r.days).toHaveLength(7);
    const total = r.days.reduce((a: number, d: any) => a + d.online_seconds, 0);
    expect(total).toBeGreaterThanOrEqual(2 * 3600 + 29 * 60);          // 2 h + ~30 min
    expect(total).toBeLessThanOrEqual(2 * 3600 + 32 * 60);
    expect(r.total.availability_pct).toBeGreaterThan(0);
    expect(r.total.availability_pct).toBeLessThan(10);
    // os dias antes da existência da conta não entram na janela
    expect(r.total.window_seconds).toBeLessThan(4 * 86_400 + 60);
    expect((await call(await login('admin@beta.demo'), 'GET', `/api/contracts/${ct}/availability`)).body.days).toEqual([]);
  });
});
