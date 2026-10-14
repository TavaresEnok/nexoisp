import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { call, login, testAgent } from './helpers.js';

// Consulta de IP para ofício: quem estava com o endereço no período, resolvendo o CGNAT pela porta quando houver.
let admin: string, beta: string, fin: string, noc: string, tenantId: string, planId: string;
const r = 100 + (Date.now() % 99);
const PRIV = `100.126.${r}.0/24`, PUB = `198.51.${r}.0/30`;
const priv = PRIV.replace('.0/24', ''), pub = PUB.replace('.0/30', '');
const T = (h: number) => new Date(Date.UTC(2031, 2, 10, h, 0, 0)).toISOString();   // 10/03/2031, horas em UTC
const S: Record<string, { resourceId: string; contractId: string; subscriberId: string; name: string }> = {};
const lookup = (t: string, b: object) => call(t, 'POST', '/api/legal/ip-lookup', { reference: 'Ofício 123/2031', ...b });
const session = (who: string, ip: string, from: string, to: string | null, key = `${who}-${ip}-${from}`) =>
  withScope({ tenantId, operator: false }, (c) => c.query(
    `insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip, mac, nas_ip) values ($1,$2,$3,$4,$5,$6,'02:4E:58:00:00:77','10.0.0.1')`,
    [tenantId, S[who].resourceId, key, from, to, ip]));

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  fin = await login('financeiro@alfa.demo');
  noc = await login('noc@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  const pubPool = (await call(admin, 'POST', '/api/ipam/pools', { name: `pub-of-${r}`, cidr: PUB, kind: 'public' })).body;
  const privPool = (await call(admin, 'POST', '/api/ipam/pools', { name: `priv-of-${r}`, cidr: PRIV, kind: 'cgnat' })).body;
  planId = (await call(admin, 'POST', '/api/cgnat/plans', { name: `plano-of-${r}`, public_pool_id: pubPool.id, private_pool_id: privPool.id, ports_per_subscriber: 1000 })).body.id;
  await withScope({ tenantId, operator: false }, (c) => c.query(`update cgnat_plans set created_at = '2031-01-01' where id = $1`, [planId]));
  const ag = await testAgent(admin, `of-${r}`);
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano of ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `of${r}` })).body.id;
  for (const who of ['ana', 'bia', 'caio']) {
    const name = `Oficio ${who} ${r}`;
    const sub = (await call(admin, 'POST', '/api/subscribers', { name, document: undefined })).body;
    const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
    const res = (await call(admin, 'POST', `/api/contracts/${k}/service`, { device_id: ag.deviceId, pppoe_username: `of${who}${r}` })).body.resource_id;
    S[who] = { resourceId: res, contractId: k, subscriberId: sub.id, name };
  }
  // CGNAT: com 1000 portas por assinante, o 1º IP público atende os privados .0 a .63; a porta 2500 cai no bloco do privado .1
  await session('ana', `${priv}.1`, T(8), T(12));        // ana usou o privado .1 das 8h às 12h
  await session('bia', `${priv}.1`, T(12), T(18));       // depois bia recebeu o mesmo privado
  await session('caio', `${priv}.2`, T(9), T(11));       // caio estava em outro bloco do mesmo IP público
  await session('caio', '203.0.113.77', new Date(Date.now() - 2 * 3600_000).toISOString(), null);    // IP público entregue direto, sessão aberta há 2 h
});
afterAll(async () => { await call(admin, 'POST', `/api/cgnat/plans/${planId}/retire`, {}); });

describe('consulta de IP para ofício', () => {
  it('IP público + porta + horário identifica uma só pessoa, mesmo com o IP privado reaproveitado', async () => {
    const q = await lookup(noc, { ip: `${pub}.0`, port: 2500, from: T(10), to: T(10) });
    expect(q.status).toBe(200);
    expect(q.body.mode).toBe('cgnat_port');
    expect(q.body.targets).toEqual([expect.objectContaining({ ip: `${priv}.1`, cgnat: expect.objectContaining({ public_ip: `${pub}.0`, port_start: 2024, port_end: 3023 }) })]);
    expect(q.body.sessions.map((s: any) => s.name)).toEqual([S.ana.name]);
    expect(q.body.sessions[0]).toMatchObject({ login: `ofana${r}`, mac: '02:4E:58:00:00:77', ip: `${priv}.1` });
    // mesma porta à tarde: era a bia
    expect((await lookup(noc, { ip: `${pub}.0`, port: 2500, from: T(15), to: T(15) })).body.sessions.map((s: any) => s.name)).toEqual([S.bia.name]);
    // período que pega a troca: as duas, em ordem
    expect((await lookup(noc, { ip: `${pub}.0`, port: 2500, from: T(11), to: T(13) })).body.sessions.map((s: any) => s.name)).toEqual([S.ana.name, S.bia.name]);
  });

  it('sem a porta, o IP público é compartilhado: lista todos e avisa', async () => {
    const q = (await lookup(noc, { ip: `${pub}.0`, from: T(10), to: T(10) })).body;
    expect(q.mode).toBe('cgnat_shared');
    expect(q.targets.length).toBe(64);
    expect(q.sessions.map((s: any) => s.name).sort()).toEqual([S.ana.name, S.caio.name].sort());
    expect(q.notes.join(' ')).toMatch(/compartilhado por até 64/);
  });

  it('IP entregue direto (sessão ainda aberta), margem de minutos e porta fora de bloco', async () => {
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const d = (await lookup(noc, { ip: '203.0.113.77', port: 443, from: ago(1), to: ago(0.5) })).body;
    expect(d.mode).toBe('direct');
    expect(d.sessions.map((s: any) => s.name)).toEqual([S.caio.name]);
    expect(d.notes.join(' ')).toMatch(/porta não muda/);
    // 12h05: sem margem só a bia; com 10 min de margem pega o fim da sessão da ana também
    expect((await lookup(noc, { ip: `${priv}.1`, from: '2031-03-10T12:05:00Z', to: '2031-03-10T12:05:00Z' })).body.sessions.map((s: any) => s.name)).toEqual([S.bia.name]);
    expect((await lookup(noc, { ip: `${priv}.1`, from: '2031-03-10T12:05:00Z', to: '2031-03-10T12:05:00Z', margin_minutes: 10 })).body.sessions.map((s: any) => s.name)).toEqual([S.ana.name, S.bia.name]);
    // horário do ofício em Brasília (−03:00): 09h de Brasília = 12h UTC
    expect((await lookup(noc, { ip: `${priv}.1`, from: '2031-03-10T09:30:00-03:00', to: '2031-03-10T09:30:00-03:00' })).body.sessions.map((s: any) => s.name)).toEqual([S.bia.name]);
    const fora = (await lookup(noc, { ip: `${pub}.0`, port: 80, from: T(10), to: T(10) })).body;
    expect(fora.sessions).toEqual([]);
    expect(fora.notes.join(' ')).toMatch(/não pertence a nenhum bloco/);
  });

  it('exige o número do ofício, período válido e permissão; fica na auditoria; outro provedor não encontra nada', async () => {
    expect((await call(noc, 'POST', '/api/legal/ip-lookup', { ip: `${priv}.1`, from: T(10), to: T(10) })).status).toBe(400);
    expect((await lookup(noc, { ip: 'não-é-ip', from: T(10), to: T(10) })).status).toBe(400);
    expect((await lookup(noc, { ip: `${priv}.1`, from: T(12), to: T(10) })).status).toBe(400);
    expect((await lookup(noc, { ip: `${priv}.1`, from: '2031-01-01T00:00:00Z', to: '2031-06-01T00:00:00Z' })).status).toBe(400);   // mais de 92 dias
    expect((await lookup(fin, { ip: `${priv}.1`, from: T(10), to: T(10) })).status).toBe(403);
    expect((await lookup(beta, { ip: `${pub}.0`, port: 2500, from: T(10), to: T(10) })).body.sessions).toEqual([]);
    const hist = (await call(noc, 'GET', '/api/legal/ip-lookup/history')).body;
    expect(hist[0].detail).toMatchObject({ reference: 'Ofício 123/2031' });
    expect(hist[0].user_name).toBeTruthy();
    expect((await call(fin, 'GET', '/api/legal/ip-lookup/history')).status).toBe(403);
  });

  it('IPv6 encontra a delegação de prefixo do contrato', async () => {
    const pool6 = (await call(admin, 'POST', '/api/ipam/pools', { name: `v6-of-${r}`, cidr: `2001:db8:${r.toString(16)}::/48`, kind: 'public', delegation_len: 56 })).body;
    expect(pool6.id).toBeTruthy();
    const dlg = await call(admin, 'POST', `/api/ipam/pools/${pool6.id}/delegations`, { contract_id: S.ana.contractId });
    expect(dlg.status).toBe(200);
    const addr = String(dlg.body.prefix).split('/')[0].replace(/::$/, '::1234');
    const q = (await lookup(noc, { ip: addr, from: T(10), to: T(10) })).body;
    expect(q.mode).toBe('ipv6');
    expect(q.ipv6.map((d: any) => d.name)).toEqual([S.ana.name]);
  });
});
