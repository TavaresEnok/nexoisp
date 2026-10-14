import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncAccounting } from '../src/radius/executor.js';
import { call, login } from './helpers.js';

// Carga do RADIUS integrado (manual: NEXO_LOAD=radius). Monta N contas com sessão aberta num concentrador e mede a sincronização
// completa (processo recém-iniciado) e a incremental (regime normal: uma fração das contas manda accounting entre dois ciclos).
process.env.NEXO_RADIUS_KEY ??= 'chave-de-teste-do-radius-integrado-0001';
const N = Number(process.env.NEXO_LOAD_N ?? 100_000);
let admin: string, tenantId: string, owner: pg.Client;
const ms = async (f: () => Promise<unknown>) => { const t = Date.now(); const r = await f(); return [Date.now() - t, r] as const; };

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  const planId = (await call(admin, 'POST', '/api/plans', { name: 'Plano carga', price_cents: 9990, down_kbps: 100000, up_kbps: 50000, profile_name: 'carga' })).body.id;
  const dev = (await call(admin, 'POST', '/api/radius/devices', { name: 'conc-carga', vendor: 'mikrotik', nas_ip: '198.18.200.1' })).body;
  const pv = (await owner.query('select id from plan_versions where plan_id = $1', [planId])).rows[0].id;
  // tudo em SQL direto: o que se mede é a sincronização, não o cadastro
  await owner.query(`insert into subscribers (tenant_id, name) select $1, 'Carga ' || g from generate_series(1, $2::int) g`, [tenantId, N]);
  await owner.query(`insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) select $1, s.id, $2, 10 from subscribers s where s.tenant_id = $1 and s.name like 'Carga %'`, [tenantId, pv]);
  await owner.query(
    `insert into service_resources (tenant_id, contract_id, device_id, pppoe_username, desired_profile, desired_version, desired_policy)
     select $1, k.id, $2, 'carga' || row_number() over (), 'carga', 1, 'active' from contracts k join subscribers s on s.id = k.subscriber_id where s.tenant_id = $1 and s.name like 'Carga %'`, [tenantId, dev.id]);
  await owner.query(`insert into radius_account (tenant_id, username, secret_enc, policy, profile, applied_version) select $1, 'carga' || g, '\\x00', 'active', 'carga', 1 from generate_series(1, $2::int) g`, [tenantId, N]);
  await owner.query(
    `insert into radius_acct (tenant_id, unique_id, session_id, username, nas_ip, started_at, updated_at, framed_ip, bytes_in, bytes_out, session_seconds)
     select $1, 'u' || g, 's' || g, 'carga' || g, '198.18.200.1', now() - interval '3 hours', now(), '100.64.0.1', 1000, 9000, 10800 from generate_series(1, $2::int) g`, [tenantId, N]);
  await owner.query('analyze');
}, 900_000);
afterAll(async () => { await owner.end(); });

describe(`RADIUS integrado com ${N} contas online`, () => {
  it('passada completa cabe em poucos segundos e a incremental é proporcional ao que mudou', async () => {
    await new Promise((r) => setTimeout(r, 5500));      // a marca tem 5 s de folga: sem esperar, a carga recém-inserida contaria como mudança
    const [full, r1] = await ms(() => syncAccounting(tenantId, { full: true }));
    console.log(`CARGA completa: ${full} ms`, r1);
    await new Promise((r) => setTimeout(r, 5500));
    const [idle, r2] = await ms(() => syncAccounting(tenantId));
    console.log(`CARGA sem mudança: ${idle} ms`, r2);
    // entre dois ciclos de 15 s com atualização a cada 5 min, 5% das contas mandam accounting
    await owner.query(`update radius_acct set updated_at = now(), bytes_out = bytes_out + 5000, session_seconds = session_seconds + 300 where tenant_id = $1 and username in (select 'carga' || g from generate_series(1, $2::int) g)`, [tenantId, Math.round(N * 0.05)]);
    await new Promise((r) => setTimeout(r, 300));
    const [inc, r3] = await ms(() => syncAccounting(tenantId));
    console.log(`CARGA incremental (5% das contas): ${inc} ms`, r3);
    const [online] = await ms(() => call(admin, 'GET', '/api/network/online'));
    console.log(`CARGA lista de online (painel): ${online} ms`);
    expect((r1 as any).accounts).toBe(N);
    expect((r2 as any).accounts).toBe(0);
    expect((r3 as any).accounts).toBe(Math.round(N * 0.05));
    expect(inc).toBeLessThan(full);
  });
});
