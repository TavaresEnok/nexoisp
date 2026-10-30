import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1342, height: 805 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const token = `${Date.now()}`;
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function request(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
try {
  await request('/auth/login', { email: 'admin@alfa.demo', password: 'demo1234' });
  const subscriber = await request('/subscribers', { name: `Titular sintético ${token}` });
  const order = await request('/work-orders', { subscriber_id: subscriber.id, kind: 'other', description: 'Visita sintética para anexo' });
  const itemName = `Item cotação ${token}`;
  const supplierName = `Fornecedor cotação ${token}`;
  const title = `Cotação sintética ${token}`;
  const item = await request('/stock/items', { name: itemName, unit: 'un', min_qty: 0, serialized: false });
  const supplier = await request('/stock/suppliers', { name: supplierName, document: null, email: null, phone: null, notes: '' });
  const fileName = `visita-${token}.pdf`;
  const content = Buffer.from('%PDF-1.4\n% Anexo sintético de teste\n%%EOF\n');

  await page.goto(`${base}/ordens-de-servico?ordem=${order.id}`);
  await page.getByLabel('Adicionar foto ou PDF', { exact: true }).setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: content });
  await page.getByText(fileName, { exact: true }).waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: `Baixar ${fileName}`, exact: true }).click();
  const downloaded = await download;
  assert.equal(downloaded.suggestedFilename(), fileName);
  assert.deepEqual(await readFile(await downloaded.path()), content);
  await page.getByRole('button', { name: `Excluir ${fileName}`, exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirme a ação', exact: true });
  await confirmation.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await page.getByText(fileName, { exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await request(`/work-orders/${order.id}/attachments`, null, 'GET')).items.length, 0);
  console.log('Anexo sintético enviado, baixado e excluído pela OS.');

  await page.goto(`${base}/estoque?aba=cotacoes`);
  await page.getByRole('button', { name: 'Nova cotação', exact: true }).click();
  await page.getByLabel('Título', { exact: true }).fill(title);
  await page.getByLabel('Item 1', { exact: true }).selectOption(item.id);
  await page.getByLabel('Quantidade 1', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Criar cotação', exact: true }).click();
  await page.getByRole('heading', { name: `${title} · Rascunho`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cadastrar oferta', exact: true }).click();
  await page.getByLabel('Fornecedor', { exact: true }).selectOption(supplier.id);
  await page.getByLabel(`Preço unitário de ${itemName} (R$)`, { exact: true }).fill('1,25');
  await page.getByRole('button', { name: 'Cadastrar oferta', exact: true }).last().click();
  await page.getByText(supplierName, { exact: true }).waitFor();
  const quoteId = (await request('/stock/quotations', null, 'GET')).items.find(row => row.title === title).id;
  const offer = (await request(`/stock/quotations/${quoteId}`, null, 'GET')).offers.find(row => row.supplier_id === supplier.id);
  await page.getByLabel('Oferta escolhida', { exact: true }).selectOption(offer.id);
  await page.getByRole('button', { name: 'Gerar pedido em rascunho', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir Compras', exact: true }).waitFor();
  const quote = (await request('/stock/quotations', null, 'GET')).items.find(row => row.title === title);
  const purchase = (await request('/stock/purchases', null, 'GET')).find(row => row.id === quote.purchase_order_id);
  assert.equal(purchase.status, 'draft');
  assert.equal(purchase.items.find(line => line.item_id === item.id).qty, 4);
  assert.equal((await request('/stock/items', null, 'GET')).find(row => row.id === item.id).balance, 0);
  assert.deepEqual(errors, []);
  console.log('Cotação e oferta geraram pedido em rascunho sem entrada de estoque.');
} finally {
  await browser.close();
}
