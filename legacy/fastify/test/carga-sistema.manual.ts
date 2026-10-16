import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { generateMonthly } from '../src/finance/core.js';
import { runNotices } from '../src/notices.js';
import { call, login } from './helpers.js';

// Carga do SISTEMA INTEIRO (manual: NEXO_LOAD=sistema). Monta N assinantes/contratos/contas e mede o que o provedor usa no dia a dia:
// faturamento mensal, listas e painéis, busca, relatórios e a régua de avisos. Os tempos são impressos como "CARGA ...".
const N = Number(process.env.NEXO_LOAD_N ?? 100_000);
let admin: string, tenantId: string, owner: pg.Client;
const ms = async <T>(f: () => Promise<T>) => { const t = Date.now(); const r = await f(); return [Date.now() - t, r] as const; };
const out = (label: string, t: number, extra = '') => console.log(`CARGA ${label.padEnd(46)} ${String(t).padStart(7)} ms ${extra}`);

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  owner = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await owner.connect();
  const planId = (await call(admin, 'POST', '/api/plans', { name: 'Plano carga sistema', price_cents: 9990, down_kbps: 100000, up_kbps: 50000, profile_name: 'cs' })).body.id;
  const pv = (await owner.query('select id from plan_versions where plan_id = $1', [planId])).rows[0].id;
  const dev = (await call(admin, 'POST', '/api/radius/devices', { name: 'conc-carga-sistema', vendor: 'mikrotik', nas_ip: '198.18.201.1' })).body;
  await owner.query(
    `insert into subscribers (tenant_id, name, document, phone, address_city) select $1, 'Cliente ' || lpad(g::text, 6, '0'), lpad(g::text, 11, '0'), '81' || lpad(g::text, 9, '9'), 'Recife' from generate_series(1, $2::int) g`, [tenantId, N]);
  await owner.query(
    `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, start_date)
     select $1, s.id, $2, 1 + (row_number() over (order by s.name) % 28)::int, current_date - 200 from subscribers s where s.tenant_id = $1 and s.name like 'Cliente %'`, [tenantId, pv]);
  await owner.query(
    `insert into service_resources (tenant_id, contract_id, device_id, pppoe_username, desired_profile, desired_version, desired_policy)
     select $1, k.id, $2, 'cs' || row_number() over (order by s.name), 'cs', 1, 'active' from contracts k join subscribers s on s.id = k.subscriber_id where s.tenant_id = $1 and s.name like 'Cliente %'`, [tenantId, dev.id]);
  // 6 meses de histórico: ~90% pagas, o restante em aberto
  await owner.query(
    `insert into invoices (tenant_id, contract_id, subscriber_id, kind, competence, due_date, amount_cents, status, paid_at)
     select k.tenant_id, k.id, k.subscriber_id, 'monthly', (date_trunc('month', current_date) - make_interval(months => m))::date,
            (date_trunc('month', current_date) - make_interval(months => m))::date + k.due_day - 1, 9990,
            case when (abs(hashtext(k.id::text || m)) % 10) = 0 then 'open' else 'paid' end,
            case when (abs(hashtext(k.id::text || m)) % 10) = 0 then null else now() - make_interval(months => m) end
     from contracts k, generate_series(1, 6) m where k.tenant_id = $1 and k.start_date < current_date - 100`, [tenantId]);
  await owner.query('analyze');
}, 1_800_000);
afterAll(async () => { await owner.end(); });

describe(`sistema com ${N} contratos`, () => {
  it('mede o dia a dia', async () => {
    const t: Record<string, number> = {};
    const timed = async (label: string, f: () => Promise<any>, check?: (r: any) => void) => {
      const [d, r] = await ms(f); t[label] = d; out(label, d); check?.(r);
    };
    await timed('painel inicial (/dashboard)', () => call(admin, 'GET', '/api/dashboard'));
    await timed('lista de assinantes (1ª página)', () => call(admin, 'GET', '/api/subscribers?limit=50'));
    await timed('busca de assinante por nome', () => call(admin, 'GET', '/api/subscribers?q=Cliente%20050000&limit=50'));
    await timed('busca por CPF', () => call(admin, 'GET', '/api/subscribers?q=00000050000'));
    await timed('lista de contratos (1ª página)', () => call(admin, 'GET', '/api/contracts?status=active&limit=50'));
    await timed('lista de contratos com busca', () => call(admin, 'GET', '/api/contracts?q=Cliente%20040000&limit=50'));
    await timed('lista de faturas (1ª página)', () => call(admin, 'GET', '/api/invoices?limit=50'));
    await timed('faturas em aberto', () => call(admin, 'GET', '/api/invoices?status=open&limit=50'));
    await timed('faturas vencidas', () => call(admin, 'GET', '/api/invoices?status=overdue&limit=50'));
    await timed('resumo de faturamento', () => call(admin, 'GET', '/api/finance/summary'));
    await timed('painéis (conexões, caixa, ONUs)', () => call(admin, 'GET', '/api/dashboard/panels'));
    await timed('relatório: aging', () => call(admin, 'GET', '/api/finance/reports/aging'));
    await timed('relatório: recebido por plano', () => call(admin, 'GET', `/api/finance/reports/receipts?from=${new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`));
    await timed('relatório: contratos a cancelar', () => call(admin, 'GET', '/api/finance/reports/to-cancel'));
    await timed('busca única', () => call(admin, 'GET', '/api/search?q=cs050000'));
    await timed('online agora (10 mil linhas pela API)', () => call(admin, 'GET', '/api/network/online?limit=50'));

    // faturamento mensal da competência corrente: 100 mil faturas de uma vez, e de novo (deve ser idempotente)
    const comp = new Date(); comp.setUTCDate(1);
    const competence = comp.toISOString().slice(0, 10);
    await timed('FATURAMENTO MENSAL (gerar a competência)', () => withScope({ tenantId, operator: false }, (c) => generateMonthly(c, tenantId, competence)),
      (n) => console.log(`CARGA   faturas geradas: ${n}`));
    await timed('faturamento mensal repetido (idempotência)', () => withScope({ tenantId, operator: false }, (c) => generateMonthly(c, tenantId, competence)));

    // régua de avisos: 1 regra, contatos com consentimento em 20% dos clientes, vencimento hoje
    const hour = 'with tz as (select coalesce((select timezone from tenant_settings where tenant_id = $1), \'America/Sao_Paulo\') as z)';
    await owner.query(`${hour} update invoices i set due_date = (now() at time zone (select z from tz))::date where i.tenant_id = $1 and i.competence = $2 and i.status = 'open'`, [tenantId, competence]);
    await owner.query(`insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, purpose, allow_notices)
      select $1, s.id, 'mobile', '81' || lpad(row_number() over ()::text, 9, '8'), 'billing', true from subscribers s where s.tenant_id = $1 and s.name like 'Cliente %' and abs(hashtext(s.id::text)) % 5 = 0`, [tenantId]);
    await owner.query(`update tenants set modules = array(select distinct unnest(modules || '{messages}'::text[])) where id = $1`, [tenantId]);
    const ch = (await call(admin, 'POST', '/api/notice-channels', { name: 'canal carga', url: 'http://127.0.0.1:9/x' })).body;
    const tp = (await call(admin, 'POST', '/api/notice-templates', { name: 'modelo carga', body: 'Olá {nome}, {valor} vence hoje.' })).body;
    await call(admin, 'POST', '/api/notice-rules', { name: 'regra carga', template_id: tp.id, channel_id: ch.id, days_relative: 0, hour_from: 0, hour_to: 24 });
    await timed('RÉGUA: enfileirar (fase 1, sem envio)', async () => {
      // o canal aponta para uma porta fechada: o que se mede é a seleção e o enfileiramento; os envios falham rápido
      const r = await runNotices(tenantId, { force: true });
      console.log(`CARGA   avisos: ${JSON.stringify(r)}`);
      return r;
    });
    const q = (await owner.query(`select status, count(*)::int n from notice_log where tenant_id = $1 group by 1 order by 1`, [tenantId])).rows;
    console.log('CARGA   fila:', JSON.stringify(q));
    expect(t['FATURAMENTO MENSAL (gerar a competência)']).toBeGreaterThan(0);
  });
});
