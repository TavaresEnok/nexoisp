import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Relatórios de cobrança e painéis: números que batem com a lista de faturas, estorno descontado, outro provedor isolado.
let admin: string, beta: string, fin: string, noc: string, contractId: string;
const tag = String(Date.now()).slice(-6);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const created: string[] = [];

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  fin = await login('financeiro@alfa.demo');
  noc = await login('noc@alfa.demo');
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano relatório ${tag}`, price_cents: 8000, down_kbps: 100000, up_kbps: 50000, profile_name: `rel${tag}` })).body;
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Relatório ${tag}` })).body;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan.id, due_day: 10 })).body.id;
});
afterAll(async () => {
  for (const id of created) await call(admin, 'POST', `/api/invoices/${id}/cancel`, { reason: 'limpeza do teste' });
});

describe('relatórios de cobrança', () => {
  it('aging: cada fatura cai na faixa certa e o total bate com a soma', async () => {
    const mk = async (cents: number, due: number) => {
      const r = await call(admin, 'POST', '/api/invoices', { contract_id: contractId, description: 'aging', amount_cents: cents, due_date: day(due) });
      created.push(r.body.id);
    };
    const plan = (await call(admin, 'GET', `/api/contracts/${contractId}`)).body.plan_id;
    await mk(1000, 5); await mk(2000, -10); await mk(4000, -45); await mk(8000, -120);
    const a = (await call(admin, 'GET', `/api/finance/reports/aging?plan_id=${plan}`)).body;
    const by = Object.fromEntries(a.rows.map((r: any) => [r.faixa, r]));
    expect(by['A vencer']).toMatchObject({ faturas: 1, cents: 1000 });
    expect(by['1 a 30 dias']).toMatchObject({ faturas: 1, cents: 2000 });
    expect(by['31 a 60 dias']).toMatchObject({ faturas: 1, cents: 4000 });
    expect(by['Mais de 90 dias']).toMatchObject({ faturas: 1, cents: 8000 });
    expect(a.total).toMatchObject({ faturas: 4, cents: 15000 });
    const csv = await call(admin, 'GET', `/api/finance/reports/aging?plan_id=${plan}&format=csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain('Mais de 90 dias');
    expect((await call(noc, 'GET', '/api/finance/reports/aging')).status).toBe(403);           // sem permissão financeira
    expect((await call(beta, 'GET', `/api/finance/reports/aging?plan_id=${plan}`)).body.total.faturas).toBe(0);
  });

  it('recebido: soma por plano e por forma, com estorno descontado', async () => {
    const r = await call(admin, 'POST', '/api/invoices', { contract_id: contractId, description: 'recebido', amount_cents: 3000, due_date: day(0) });
    created.push(r.body.id);
    const pay = await call(admin, 'POST', `/api/invoices/${r.body.id}/manual-payment`, { amount_cents: 3000, paid_at: day(0), method: 'pix', note: 'recebido no teste' });
    expect(pay.body.status).toBe('paid');
    const rep = async () => (await call(admin, 'GET', `/api/finance/reports/receipts?from=${day(-1)}&to=${day(1)}`)).body;
    let x = await rep();
    expect(x.by_plan.find((g: any) => g.grupo === `Plano relatório ${tag}`)).toMatchObject({ pagamentos: 1, cents: 3000 });
    expect(x.by_method.find((g: any) => g.grupo === 'pix').cents).toBeGreaterThanOrEqual(3000);
    const inv = (await call(admin, 'GET', `/api/invoices/${r.body.id}`)).body;
    await call(admin, 'POST', `/api/invoices/${r.body.id}/payments/${inv.payments[0].id}/reverse`, { reason: 'estorno no teste do relatório' });
    x = await rep();
    expect(x.by_plan.find((g: any) => g.grupo === `Plano relatório ${tag}`).cents).toBe(0);
    expect((await call(admin, 'GET', `/api/finance/reports/receipts?from=${day(1)}&to=${day(-1)}`)).status).toBe(200);
  });

  it('sem fatura e a cancelar', async () => {
    const sem = (await call(admin, 'GET', '/api/finance/reports/without-invoice')).body.rows;
    expect(Array.isArray(sem)).toBe(true);
    const cancel = (await call(admin, 'GET', '/api/finance/reports/to-cancel?days=90')).body;
    expect(cancel.rows.some((r: any) => r.contract_id === contractId && r.dias_atraso > 90)).toBe(true);
    expect((await call(admin, 'GET', '/api/finance/reports/to-cancel?days=200')).body.rows.some((r: any) => r.contract_id === contractId)).toBe(false);
    expect((await call(beta, 'GET', '/api/finance/reports/to-cancel?days=1')).body.rows.some((r: any) => r.contract_id === contractId)).toBe(false);
    expect((await call(admin, 'GET', '/api/finance/reports/to-cancel?format=csv')).status).toBe(200);
  });
});

describe('painéis', () => {
  it('devolve offline por faixa, contratos por mês e caixa do dia; financeiro só para quem pode', async () => {
    const p = (await call(admin, 'GET', '/api/dashboard/panels')).body;
    expect(Array.isArray(p.offline)).toBe(true);
    expect(p.contracts_by_month).toHaveLength(12);
    expect(p.cash_today).toHaveProperty('cents');
    expect(typeof p.without_invoice).toBe('number');
    expect(Array.isArray(p.recent_operations)).toBe(true);
    const n = (await call(noc, 'GET', '/api/dashboard/panels')).body;
    expect(n.cash_today).toBeUndefined();
    expect(n.contracts_by_month).toHaveLength(12);
    expect((await call(fin, 'GET', '/api/dashboard/panels')).status).toBe(403);               // financeiro não tem permissão de rede
  });
});
