import { beforeAll, describe, expect, it } from 'vitest';
import { call, login } from './helpers.js';

// Combo = plano + produtos adicionais recorrentes: entram na mensalidade como linhas próprias.
let admin: string, beta: string, fin: string, planId: string;
const r = 100 + (Date.now() % 800);
const mk = async (n: string) => {
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `${n} ${r}` })).body;
  return (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id as string;
};
const comp = (i: number) => `${2033 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const invoiceOf = async (contract: string, competence: string) =>
  (await call(admin, 'GET', `/api/invoices?contract_id=${contract}&limit=50`)).body.find((i: any) => String(i.competence).startsWith(competence));
const detail = async (id: string) => (await call(admin, 'GET', `/api/invoices/${id}`)).body;

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); beta = await login('admin@beta.demo'); fin = await login('financeiro@alfa.demo');
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano combo ${r}`, price_cents: 10000, down_kbps: 1000, up_kbps: 1000, profile_name: `cb${r}` })).body.id;
});

describe('produtos adicionais (combo)', () => {
  let tv: any;
  it('catálogo: cria, preço novo não muda o contratado, inativo não é vendido', async () => {
    tv = (await call(admin, 'POST', '/api/addons', { name: `TV ${r}`, price_cents: 4000 })).body;
    expect(tv.id).toBeTruthy();
    expect((await call(admin, 'POST', '/api/addons', { name: `TV ${r}`, price_cents: 1 })).status).toBe(409);
    expect((await call(fin, 'POST', '/api/addons', { name: `Sem permissão ${r}`, price_cents: 1 })).status).toBe(403);
    const ip = (await call(admin, 'POST', '/api/addons', { name: `IP fixo ${r}`, price_cents: 1500 })).body;
    await call(admin, 'PATCH', `/api/addons/${ip.id}`, { active: false });
    const k = await mk('Combo X');
    expect((await call(admin, 'POST', `/api/contracts/${k}/addons`, { product_id: ip.id })).status).toBe(400);
  });

  it('a mensalidade soma plano + adicionais, com uma linha por produto, e o desconto vale só sobre o plano', async () => {
    const k = await mk('Combo A');
    expect((await call(admin, 'POST', `/api/contracts/${k}/addons`, { product_id: tv.id, quantity: 2, from_competence: comp(0) })).status).toBe(200);   // 2 x 4000
    await call(admin, 'POST', `/api/contracts/${k}/discounts`, { kind: 'percent', value: 10, reason: 'promoção do combo', from_competence: `${comp(0)}-01`, months: 12 });
    await call(admin, 'POST', '/api/finance/generate', { competence: comp(0) });
    const inv = await invoiceOf(k, comp(0));
    expect(inv.amount_cents).toBe(10000 - 1000 + 8000);                     // plano − 10% do plano + 2 TVs
    const items = (await detail(inv.id)).items.map((i: any) => i.amount_cents).sort((a: number, b: number) => a - b);
    expect(items).toEqual([-1000, 4000 * 2, 10000].sort((a, b) => a - b));
    expect((await detail(inv.id)).items.some((i: any) => /TV/.test(i.description) && /x2/.test(i.description))).toBe(true);
  });

  it('preço congelado na contratação; encerrar para de cobrar daquele mês; contrato sem adicional não muda', async () => {
    const k = await mk('Combo B'), sem = await mk('Combo C');
    await call(admin, 'POST', `/api/contracts/${k}/addons`, { product_id: tv.id, from_competence: comp(1) });
    await call(admin, 'PATCH', `/api/addons/${tv.id}`, { price_cents: 9900 });                // reajuste do catálogo
    const lista = (await call(admin, 'GET', `/api/contracts/${k}/addons`)).body;
    expect(lista[0]).toMatchObject({ unit_price_cents: 4000, from_competence: comp(1), quantity: 1 });
    await call(admin, 'POST', '/api/finance/generate', { competence: comp(1) });
    expect((await invoiceOf(k, comp(1))).amount_cents).toBe(14000);
    expect((await invoiceOf(sem, comp(1))).amount_cents).toBe(10000);
    expect((await call(admin, 'DELETE', `/api/contracts/${k}/addons/${lista[0].id}`, { ended_competence: comp(2) })).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/contracts/${k}/addons/${lista[0].id}`, { ended_competence: comp(2) })).status).toBe(409);   // já encerrado
    await call(admin, 'POST', '/api/finance/generate', { competence: comp(2) });
    expect((await invoiceOf(k, comp(2))).amount_cents).toBe(10000);
    await call(admin, 'PATCH', `/api/addons/${tv.id}`, { price_cents: 4000 });
  });

  it('outro provedor não usa o produto; contrato encerrado não recebe adicional', async () => {
    const subB = (await call(beta, 'POST', '/api/subscribers', { name: `Beta combo ${r}` })).body;
    const planB = (await call(beta, 'POST', '/api/plans', { name: `Plano B combo ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `cbb${r}` })).body.id;
    const kb = (await call(beta, 'POST', '/api/contracts', { subscriber_id: subB.id, plan_id: planB, due_day: 10 })).body.id;
    expect((await call(beta, 'POST', `/api/contracts/${kb}/addons`, { product_id: tv.id })).status).toBe(400);
    expect((await call(beta, 'GET', '/api/addons')).body.some((p: any) => p.id === tv.id)).toBe(false);
    const k = await mk('Combo D');
    await call(admin, 'PATCH', `/api/contracts/${k}`, { end: true });
    expect((await call(admin, 'POST', `/api/contracts/${k}/addons`, { product_id: tv.id })).status).toBe(409);
  });
});
