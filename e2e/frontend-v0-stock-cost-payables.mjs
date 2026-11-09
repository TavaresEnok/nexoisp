import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

// Custo médio ponderado do estoque, valor por depósito e contas a pagar geradas
// pelo recebimento de compra. Somente dados sintéticos do laboratório.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1342, height: 805 }, timezoneId: 'America/Fortaleza' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [];
const errors = [];
const token = Date.now();
page.on('pageerror', (error) => errors.push(error.message));
function check(description) { checks.push(description); console.log(description); }
const dialog = (name) => page.getByRole('dialog', { name, exact: true });
const row = (text) => page.getByRole('row').filter({ has: page.getByText(text, { exact: true }) });
async function request(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function costsOf(id, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const costs = await request(`/stock/items/${id}/costs`, null, 'GET');
    if (costs.balance === expected) return costs;
    await page.waitForTimeout(100);
  }
  throw new Error(`Saldo não atingiu ${expected}`);
}
async function payablesOf(supplier) {
  return request(`/finance/payables?supplier_id=${supplier}`, null, 'GET');
}
try {
  await request('/auth/login', { email: 'admin@alfa.demo', password: 'demo1234' });
  const itemName = `Cabo custo ${token}`;
  const supplierName = `Fornecedor contas ${token}`;
  const item = await request('/stock/items', { name: itemName, unit: 'm', min_qty: 0, serialized: false });
  const supplier = await request('/stock/suppliers', { name: supplierName, document: null, email: null, phone: null, notes: '' });

  await page.goto(`${base}/estoque`);
  await page.getByLabel('Buscar no catálogo de estoque', { exact: true }).fill(itemName);
  await row(itemName).getByRole('button', { name: 'Movimentos', exact: true }).click();
  const moves = dialog(`Movimentos · ${itemName}`);
  await moves.getByLabel('Quantidade do movimento', { exact: true }).fill('10');
  await moves.getByLabel('Custo unitário da entrada (R$)', { exact: true }).fill('10,00');
  await moves.getByRole('button', { name: 'Registrar movimento', exact: true }).click();
  await costsOf(item.id, 10);
  await moves.getByLabel('Quantidade do movimento', { exact: true }).fill('10');
  await moves.getByLabel('Custo unitário da entrada (R$)', { exact: true }).fill('10,03');
  await moves.getByRole('button', { name: 'Registrar movimento', exact: true }).click();
  let costs = await costsOf(item.id, 20);
  assert.equal(costs.avg_cost_cents, 1002, '(10 × 10,00 + 10 × 10,03) / 20 = 10,015 → 10,02');
  await moves.getByText(/Custo médio vigente R\$\s10,02/).waitFor();
  await moves.getByLabel('Tipo de movimento', { exact: true }).selectOption('out');
  assert.equal(await moves.getByLabel('Custo unitário da entrada (R$)', { exact: true }).count(), 0);
  await moves.getByLabel('Quantidade do movimento', { exact: true }).fill('5');
  await moves.getByRole('button', { name: 'Registrar movimento', exact: true }).click();
  costs = await costsOf(item.id, 15);
  assert.equal(costs.movements[0].unit_cost_cents, 1002);
  assert.equal(costs.movements[0].cost_source, 'average');
  assert.equal(costs.avg_cost_cents, 1002);
  await moves.getByText('Custo da entrada', { exact: true }).first().waitFor();
  await moves.getByText('Custo médio', { exact: true }).first().waitFor();
  await moves.getByRole('button', { name: 'Fechar', exact: true }).click();
  await moves.waitFor({ state: 'hidden' });
  await row(itemName).getByText(/R\$\s10,02/).first().waitFor();
  check('Entradas com custo recalculam o custo médio com arredondamento em centavos; a saída usa o médio vigente e o catálogo mostra custo e valor');

  const order = await request('/stock/purchases', { supplier_id: supplier.id, warehouse_id: null, expected_at: null, note: '', items: [{ item_id: item.id, qty: 4, unit_cost_cents: 1250 }] });
  await page.goto(`${base}/estoque?aba=compras`);
  await page.getByRole('button', { name: `Receber pedido #${order.number}`, exact: true }).click();
  const receive = dialog(`Receber pedido #${order.number}`);
  await receive.getByLabel('Vencimento da primeira parcela', { exact: true }).fill('2031-01-31');
  await receive.getByLabel('Número de parcelas', { exact: true }).fill('3');
  await receive.getByRole('button', { name: 'Confirmar recebimento', exact: true }).click();
  await receive.waitFor({ state: 'hidden' });
  await page.getByText(/^Recebido em/).first().waitFor();
  costs = await costsOf(item.id, 19);
  assert.equal(costs.avg_cost_cents, 1054, '(15 × 10,02 + 4 × 12,50) / 19 = 10,5421 → 10,54');
  let payables = await payablesOf(supplier.id);
  assert.deepEqual(payables.items.map((p) => [p.amount_cents, p.due_date, p.status, p.purchase_order_number]), [
    [1667, '2031-01-31', 'open', order.number],
    [1667, '2031-02-28', 'open', order.number],
    [1666, '2031-03-31', 'open', order.number],
  ]);
  check('Recebimento do pedido gera títulos parcelados ao fornecedor e recalcula o custo médio pelo custo do pedido');

  await page.getByRole('tab', { name: 'Valor do estoque', exact: true }).click();
  await page.getByRole('heading', { name: /^Valor do estoque por depósito/ }).waitFor();
  await page.getByLabel('Depósito do relatório', { exact: true }).selectOption('principal');
  const valued = page.getByRole('tabpanel').getByRole('row').filter({ has: page.getByText(itemName, { exact: true }) });
  await valued.getByText(/R\$\s10,54/).waitFor();
  await valued.getByText(/R\$\s200,26/).waitFor();
  const valuation = await request('/stock/valuation', null, 'GET');
  assert.equal(valuation.lines.find((line) => line.item_id === item.id && line.warehouse_id === null).value_cents, 19 * 1054);
  check('Relatório de valor do estoque por depósito usa saldo × custo médio calculado pelo servidor');

  await page.goto(`${base}/financeiro/contas-a-pagar`);
  await page.getByLabel('Fornecedor dos títulos', { exact: true }).selectOption(supplier.id);
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  const [first, second] = payables.items;
  await page.getByRole('button', { name: `Baixar título ${first.number}`, exact: true }).click();
  const pay = dialog(`Baixar título ${first.number}`);
  await pay.getByLabel('Forma de pagamento', { exact: true }).selectOption('boleto');
  await pay.getByLabel('Observação da baixa', { exact: true }).fill('Baixa sintética');
  await pay.getByRole('button', { name: 'Confirmar baixa', exact: true }).click();
  await pay.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: `Baixar título ${first.number}`, exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: `Cancelar título ${second.number}`, exact: true }).click();
  const cancel = dialog(`Cancelar título ${second.number}`);
  await cancel.getByLabel('Motivo do cancelamento', { exact: true }).fill('Desconto sintético negociado');
  await cancel.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click();
  await cancel.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: `Cancelar título ${second.number}`, exact: true }).waitFor({ state: 'hidden' });
  payables = await payablesOf(supplier.id);
  assert.equal(payables.items.find((p) => p.id === first.id).status, 'paid');
  assert.equal(payables.items.find((p) => p.id === first.id).paid_method, 'boleto');
  assert.equal(payables.items.find((p) => p.id === second.id).status, 'canceled');
  assert.deepEqual([payables.totals.open_cents, payables.totals.paid_cents, payables.totals.canceled_cents], [1666, 1667, 1667]);
  await page.getByLabel('Situação dos títulos', { exact: true }).selectOption('paid');
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  await row(`Nº ${first.number}`).getByText('Pago', { exact: true }).waitFor();
  check('Contas a pagar filtra por fornecedor e situação, baixa com data e forma, cancela com motivo e recalcula os totais');

  await page.getByRole('button', { name: 'Novo título a pagar', exact: true }).click();
  const manual = dialog('Novo título a pagar');
  await manual.getByLabel('Fornecedor do título', { exact: true }).selectOption(supplier.id);
  await manual.getByLabel('Descrição do título', { exact: true }).fill(`Aluguel de torre ${token}`);
  await manual.getByLabel('Valor total (R$)', { exact: true }).fill('150,01');
  await manual.getByLabel('Vencimento da primeira parcela', { exact: true }).fill('2020-01-10');
  await manual.getByLabel('Número de parcelas', { exact: true }).fill('2');
  await manual.getByRole('button', { name: 'Lançar título', exact: true }).click();
  await manual.waitFor({ state: 'hidden' });
  await page.getByLabel('Situação dos títulos', { exact: true }).selectOption('overdue');
  await page.getByRole('button', { name: 'Aplicar filtros', exact: true }).click();
  await page.getByText(`Aluguel de torre ${token} · parcela 2/2`, { exact: true }).waitFor();
  const overdue = await request(`/finance/payables?supplier_id=${supplier.id}&status=overdue`, null, 'GET');
  assert.deepEqual(overdue.items.map((p) => [p.amount_cents, p.due_date, p.overdue]), [[7501, '2020-01-10', true], [7500, '2020-02-10', true]]);
  assert.equal(overdue.totals.overdue_cents, 15001);
  check('Lançamento manual parcelado divide centavos, segue vencimentos mensais e aparece no filtro de vencidos');

  const attendant = await browser.newContext();
  await attendant.request.post(`${base}/api/auth/login`, { data: { email: 'atendimento@alfa.demo', password: 'demo1234' } });
  const readPage = await attendant.newPage();
  await readPage.goto(`${base}/financeiro/contas-a-pagar`);
  await readPage.getByRole('heading', { name: /^Títulos a pagar/ }).waitFor();
  assert.equal(await readPage.getByRole('button', { name: 'Novo título a pagar', exact: true }).count(), 0);
  assert.equal(await readPage.getByRole('button', { name: /^Baixar título/ }).count(), 0);
  assert.equal((await attendant.request.post(`${base}/api/finance/payables/${overdue.items[0].id}/pay`, { headers: await csrf(attendant, base), data: { paid_on: '2026-01-05', method: 'pix' } })).status(), 403);
  await attendant.close();
  const noc = await browser.newContext();
  await noc.request.post(`${base}/api/auth/login`, { data: { email: 'noc@alfa.demo', password: 'demo1234' } });
  assert.equal((await noc.request.get(`${base}/api/finance/payables`)).status(), 403);
  assert.equal((await noc.request.get(`${base}/api/stock/valuation`)).status(), 200);
  await noc.close();
  const beta = await browser.newContext();
  await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } });
  assert.equal((await (await beta.request.get(`${base}/api/finance/payables`)).json()).items.some((p) => p.supplier_id === supplier.id), false);
  assert.equal((await beta.request.post(`${base}/api/finance/payables/${overdue.items[0].id}/pay`, { headers: await csrf(beta, base), data: { paid_on: '2026-01-05', method: 'pix' } })).status(), 404);
  assert.equal((await beta.request.get(`${base}/api/stock/items/${item.id}/costs`)).status(), 404);
  await beta.close();
  check('Contas a pagar exige finance:read/finance:write, custo do estoque exige stock:read e o Go isola os provedores');

  assert.deepEqual(errors, []);
  await writeFile(new URL('../docs/integracao-v0/evidencias/integracao-custo-contas-pagar.json', import.meta.url), JSON.stringify({ ok: true, base, verified_at: new Date().toISOString(), backend: 'Go/PostgreSQL isolados; somente dados sintéticos', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.error('Verificações concluídas:', checks);
  await page.screenshot({ path: '/tmp/nexo-v0-stock-cost-payables-failure.png' }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
