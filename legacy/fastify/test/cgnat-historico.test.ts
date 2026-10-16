import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { call, login, testAgent } from './helpers.js';

// R3: a consulta por IP público + porta + horário devolve o titular NA DATA a partir das sessões relatadas pelo agente.
let admin: string, tenantId: string, planId: string, resourceId: string, contractId: string, subName: string;
const r = 200 + (Date.now() % 55);
const PRIV = `100.127.${r}.0/24`, PUB = `198.51.${r}.0/30`;
const priv = PRIV.replace('.0/24', ''), pub = PUB.replace('.0/30', '');
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  const pubPool = (await call(admin, 'POST', '/api/ipam/pools', { name: `pub-hist-${r}`, cidr: PUB, kind: 'public' })).body;
  const privPool = (await call(admin, 'POST', '/api/ipam/pools', { name: `priv-hist-${r}`, cidr: PRIV, kind: 'cgnat' })).body;
  planId = (await call(admin, 'POST', '/api/cgnat/plans', { name: `plano-hist-${r}`, public_pool_id: pubPool.id, private_pool_id: privPool.id, ports_per_subscriber: 1000 })).body.id;
  // o plano precisa existir nos horários consultados
  await withScope({ tenantId, operator: false }, (c) => c.query(`update cgnat_plans set created_at = now() - interval '2 days' where id = $1`, [planId]));
  const ag = await testAgent(admin, `hist-${r}`);
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano hist ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `h${r}` })).body.id;
  subName = `Titular hist ${r}`;
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: subName })).body;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
  resourceId = (await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: ag.deviceId, pppoe_username: `h${r}` })).body.resource_id;
});
afterAll(async () => {
  if (planId) await call(admin, 'POST', `/api/cgnat/plans/${planId}/retire`, {});
});

describe('rastreio CGNAT com titular na data', () => {
  it('sessão cobrindo o horário identifica o titular; fora do horário não; sessão aberta vale até agora', async () => {
    // 2º bloco do 1º IP público = privado .1 (mesma regra do teste de IPAM)
    const trace = async (at?: string) => (await call(admin, 'GET', `/api/cgnat/trace?ip=${pub}.0&port=2500${at ? `&at=${encodeURIComponent(at)}` : ''}`)).body;
    expect(await trace()).toMatchObject({ found: true, private_ip: `${priv}.1`, holders_at: [] });

    await withScope({ tenantId, operator: false }, (c) => c.query(
      `insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip, mac) values ($1,$2,$3,$4,$5,$6,'AA:BB:CC:00:00:01')`,
      [tenantId, resourceId, `hist-${r}-1`, ago(180), ago(60), `${priv}.1`]));
    const dentro = await trace(ago(120));
    expect(dentro.holders_at).toHaveLength(1);
    expect(dentro.holders_at[0]).toMatchObject({ subscriber_name: subName, contract_id: contractId, pppoe_username: `h${r}` });
    expect(dentro.note).toMatch(/sessões relatadas/);
    expect((await trace(ago(30))).holders_at).toEqual([]);           // depois que a sessão terminou
    expect((await trace(ago(240))).holders_at).toEqual([]);          // antes de começar

    await withScope({ tenantId, operator: false }, (c) => c.query(
      `insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip) values ($1,$2,$3,$4,null,$5)`,
      [tenantId, resourceId, `hist-${r}-2`, ago(20), `${priv}.1`]));
    expect((await trace(ago(5))).holders_at).toHaveLength(1);        // sessão aberta cobre o horário
  });
});
