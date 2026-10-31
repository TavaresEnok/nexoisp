import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

// Entregas de 20/10/2026 sem decisão do dono: catálogo de ONU, portas PON,
// SLA no expediente e estoque com depósitos, fornecedores e compras.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1342, height: 805 }, timezoneId: 'America/Fortaleza' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [];
const errors = [];
const token = Date.now();
page.on('pageerror', (error) => errors.push(error.message));
function check(description) { checks.push(description); console.log(description); }
const dialog = (name) => page.getByRole('dialog', { name });
async function request(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function confirm() {
  await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await dialog('Confirme a ação').waitFor({ state: 'hidden' });
}
try {
  await request('/auth/login', { email: 'admin@alfa.demo', password: 'demo1234' });

  // Catálogo de ONU
  const code = `HG${token}`.slice(0, 20);
  await page.goto(`${base}/rede/ftth/fttx-onu-tipo`);
  await page.getByRole('heading', { name: 'Hardware com perfil definido.', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Novo modelo', exact: true }).click();
  await dialog('Novo modelo de ONU').getByLabel('Código do modelo', { exact: true }).fill(code);
  await dialog('Novo modelo de ONU').getByLabel('Fabricante', { exact: true }).fill('Huawei');
  await dialog('Novo modelo de ONU').getByLabel('Modo de operação', { exact: true }).selectOption('Router');
  await dialog('Novo modelo de ONU').getByLabel('OLTs compatíveis (uma por linha)', { exact: true }).fill('MA5800\nMA5608T');
  await dialog('Novo modelo de ONU').getByRole('button', { name: 'Cadastrar modelo', exact: true }).click();
  await dialog('Novo modelo de ONU').waitFor({ state: 'hidden' });
  await page.getByText(code, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Novo template', exact: true }).click();
  const template = `Router padrão ${token}`;
  await dialog('Novo template de ONU').getByLabel('Nome do template', { exact: true }).fill(template);
  await dialog('Novo template de ONU').getByLabel('Fabricante', { exact: true }).fill('Huawei');
  await dialog('Novo template de ONU').getByLabel(code, { exact: true }).check();
  await dialog('Novo template de ONU').getByLabel('Parâmetros GPON', { exact: true }).fill('ont add %pon% sn-auth %sn%');
  await dialog('Novo template de ONU').getByRole('button', { name: 'Cadastrar template', exact: true }).click();
  await dialog('Novo template de ONU').waitFor({ state: 'hidden' });
  const templates = await request('/olt/onu-templates', null, 'GET');
  const saved = templates.find((item) => item.name === template);
  assert.equal(saved.model_ids.length, 1);
  await page.goto(`${base}/rede/ftth/fttx-onu-tipo`);
  await page.getByRole('button', { name: `Detalhes do modelo ${code}`, exact: true }).click();
  await page.getByRole('button', { name: 'Excluir modelo', exact: true }).click();
  await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await page.getByText('o modelo está associado a templates', { exact: false }).first().waitFor();
  check('Catálogo de ONU: modelo e template cadastrados pela tela original do v0, associação persistida e exclusão de modelo em uso recusada pelo Go');

  // Portas PON (dados do cenário óptico anterior na fumaça)
  await page.goto(`${base}/rede/ftth/fttx-pon`);
  await page.getByRole('heading', { name: 'Portas PON', exact: true }).waitFor();
  const ports = await request('/olt/pon-ports', null, 'GET');
  const linked = ports.find((port) => port.subscribers.length);
  if (linked) {
    await page.getByRole('button', { name: new RegExp(`^Assinantes de ${linked.olt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first().click();
    await page.getByRole('button', { name: new RegExp(linked.subscribers[0].name) }).first().waitFor();
  } else {
    await page.getByText('Nenhuma porta PON identificada', { exact: true }).waitFor();
  }
  check(`Portas PON: ${ports.length} porta(s) derivadas das ONUs e descobertas; assinantes da porta abertos pela tela do v0`);

  // SLA no expediente
  await page.goto(`${base}/administracao/catalogos-sla?aba=sla`);
  await page.getByRole('heading', { name: 'Calendário de expediente', exact: true }).waitFor();
  await page.getByLabel('Fuso do expediente', { exact: true }).selectOption('America/Fortaleza');
  await page.getByRole('button', { name: 'Salvar expediente', exact: true }).click();
  await page.getByText('Calendário de expediente salvo.', { exact: true }).waitFor();
  const holiday = `2027-0${(token % 9) + 1}-1${token % 9}`;
  await page.getByRole('button', { name: 'Novo feriado', exact: true }).click();
  await dialog('Novo feriado').getByLabel('Data do feriado', { exact: true }).fill(holiday);
  await dialog('Novo feriado').getByLabel('Nome do feriado', { exact: true }).fill(`Feriado ${token}`);
  await dialog('Novo feriado').getByRole('button', { name: 'Cadastrar feriado', exact: true }).click();
  await dialog('Novo feriado').waitFor({ state: 'hidden' });
  await page.getByText(`Feriado ${token}`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nova política de SLA', exact: true }).click();
  await dialog('Nova política de SLA').getByLabel('Nome da política', { exact: true }).fill(`Expediente ${token}`);
  await dialog('Nova política de SLA').getByLabel('Contagem do prazo', { exact: true }).selectOption('yes');
  await dialog('Nova política de SLA').getByLabel('Prazo em minutos', { exact: true }).fill('600');
  await dialog('Nova política de SLA').getByRole('button', { name: 'Salvar', exact: true }).click();
  await dialog('Nova política de SLA').waitFor({ state: 'hidden' });
  const policy = (await request('/sla-policies', null, 'GET')).find((item) => item.name === `Expediente ${token}`);
  assert.equal(policy.business_hours, true);
  const calendar = await request('/sla-calendar', null, 'GET');
  assert.equal(calendar.timezone, 'America/Fortaleza');
  assert.equal(calendar.hours.filter(Boolean).length, 6);
  check('SLA: calendário de expediente, feriado e política "Somente no expediente" gravados pela interface e relidos no Go');

  // Estoque: depósito, fornecedor e compra
  const item = await request('/stock/items', { name: `Conector ${token}`, unit: 'un' });
  await page.goto(`${base}/estoque?aba=depositos`);
  await page.getByRole('button', { name: 'Novo depósito', exact: true }).click();
  await dialog('Novo depósito').getByLabel('Nome do depósito', { exact: true }).fill(`Depósito ${token}`);
  await dialog('Novo depósito').getByRole('button', { name: 'Cadastrar depósito', exact: true }).click();
  await dialog('Novo depósito').waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: 'Fornecedores', exact: true }).click();
  await page.getByRole('button', { name: 'Novo fornecedor', exact: true }).click();
  await dialog('Novo fornecedor').getByLabel('Nome do fornecedor', { exact: true }).fill(`Fornecedor ${token}`);
  await dialog('Novo fornecedor').getByLabel('CPF ou CNPJ (somente números)', { exact: true }).fill('12345678000199');
  await dialog('Novo fornecedor').getByRole('button', { name: 'Cadastrar fornecedor', exact: true }).click();
  await dialog('Novo fornecedor').waitFor({ state: 'hidden' });
  await page.getByText('12.345.678/0001-99', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Compras', exact: true }).click();
  await page.getByRole('button', { name: 'Novo pedido de compra', exact: true }).click();
  const order = dialog('Novo pedido de compra');
  await order.getByLabel('Fornecedor do pedido', { exact: true }).selectOption({ label: `Fornecedor ${token}` });
  await order.getByLabel('Depósito de entrada', { exact: true }).selectOption({ label: `Depósito ${token}` });
  await order.getByLabel('Item 1 do pedido', { exact: true }).selectOption({ label: `Conector ${token}` });
  await order.getByLabel('Quantidade do item 1', { exact: true }).fill('40');
  await order.getByLabel('Custo unitário do item 1 (R$)', { exact: true }).fill('1,25');
  await order.getByRole('button', { name: 'Registrar pedido', exact: true }).click();
  await order.waitFor({ state: 'hidden' });
  const purchase = (await request('/stock/purchases', null, 'GET')).find((row) => row.items.some((line) => line.item_id === item.id));
  assert.equal(purchase.total_cents, 5000);
  await page.getByRole('button', { name: `Receber pedido #${purchase.number}`, exact: true }).click();
  await confirm();
  await page.getByText(/^Recebido em/).first().waitFor();
  const balances = await request(`/stock/items/${item.id}/balances`, null, 'GET');
  assert.equal(balances.find((row) => row.name === `Depósito ${token}`).balance, 40);
  assert.equal(balances.find((row) => row.warehouse_id === null).balance, 0);
  await page.getByRole('tab', { name: 'Materiais', exact: true }).click();
  await page.getByRole('row').filter({ hasText: `Conector ${token}` }).getByRole('button', { name: 'Movimentos', exact: true }).click();
  const moves = dialog(`Movimentos · Conector ${token}`);
  await moves.getByLabel('Depósito de origem', { exact: true }).selectOption({ label: `Depósito ${token}` });
  await moves.getByLabel('Depósito de destino', { exact: true }).selectOption({ label: 'Depósito principal' });
  await moves.getByLabel('Quantidade a transferir', { exact: true }).fill('15');
  const transferUrl = `${base}/api/stock/items/${item.id}/transfer`;
  const [transferResponse] = await Promise.all([
    page.waitForResponse((response) => response.url() === transferUrl && response.request().method() === 'POST'),
    moves.getByRole('button', { name: 'Transferir entre depósitos', exact: true }).click(),
  ]);
  assert.equal(transferResponse.ok(), true, `POST ${transferUrl}: ${await transferResponse.text()}`);
  const after = await request(`/stock/items/${item.id}/balances`, null, 'GET');
  assert.equal(after.find((row) => row.warehouse_id === null).balance, 15);
  assert.equal(after.find((row) => row.name === `Depósito ${token}`).balance, 25);
  check('Estoque: depósito, fornecedor e pedido de compra pela interface; recebimento gera entrada no depósito e a transferência move o saldo para o principal');

  assert.deepEqual(errors, []);
  await writeFile(new URL(`../docs/integracao-v0/evidencias/${process.env.EVOLUTION_EVIDENCE ?? 'integracao-evolucao.json'}`, import.meta.url), JSON.stringify({ ok: true, base, verified_at: new Date().toISOString(), backend: 'Go/PostgreSQL isolados; dados sintéticos', checks }, null, 2) + '\n');
} finally {
  await context.close();
  await browser.close();
}
