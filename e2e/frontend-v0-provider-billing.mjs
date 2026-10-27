// Focused lab journey. No PSP calls; issued/review states are explicit owner fixtures.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';
assert.equal(process.env.NEXO_PAYMENT_LAB, '1');
const base = process.env.BASE;
assert.match(base ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const fixture = JSON.parse(await readFile('/evidence/fixture.json', 'utf8'));
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1342, height: 900 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const checks = [];
async function login(email) {
 const r = await context.request.post(base + '/api/auth/login', { headers: await csrf(context, base), data: { email, password: 'demo1234' } }); assert.equal(r.ok(), true);
}
async function open(id) {
 await page.goto(base + '/financeiro/faturas?fatura=' + id);
 await page.getByText('Cobrança no provedor', { exact: true }).waitFor();
 await page.getByRole('button', { name: 'Atualizar cobrança', exact: true }).waitFor();
}
try {
 await login('financeiro@alfa.demo');
 for (const [product, invoice] of Object.entries(fixture.issue)) {
  await open(invoice);
  await page.getByRole('button', { name: 'Preparar emissão Efí', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Preparar emissão Efí', exact: true });
  await form.getByLabel('Conta e produto Efí sandbox').selectOption(`${product === 'bolix' ? fixture.charges : fixture.pix}:${product}`);
  if (product !== 'pix_cob') {
   for (const [label, value] of Object.entries({ 'Nome / razão social': 'Synthetic payer', 'CPF ou CNPJ numérico (somente dígitos)': '12345678909', Logradouro: 'Synthetic street', Cidade: 'Fortaleza', UF: 'ce', 'CEP (somente dígitos)': '60000000' })) await form.getByLabel(label, { exact: true }).fill(value);
   if (product === 'bolix') for (const [label, value] of Object.entries({ 'E-mail do pagador': 'synthetic@example.invalid', 'Número do endereço': '1', Bairro: 'Synthetic' })) await form.getByLabel(label, { exact: true }).fill(value);
  }
  if (product === 'pix_cob') await page.route(/\/api\/financial-connections\/[^/]+\/issuance$/, async (route) => {
   const r = await route.fetch(); assert.equal(r.status(), 200); await route.abort('failed');
  }, { times: 1 });
  await form.getByRole('button', { name: 'Registrar intenção', exact: true }).click();
  await form.waitFor({state: 'hidden'});
  await page.getByText(/Intenção preservada: emissão/).waitFor();
  await page.reload();
  await page.getByText('Preparada · aguardando processamento', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Preparar emissão Efí', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Recuperar intenção pendente', exact: true }).count(), 0);
  const pending = await page.evaluate((id) => Object.keys(localStorage).filter((k) => k.startsWith('nexo:provider-billing:') && k.includes(id)).map((k) => JSON.parse(localStorage.getItem(k))), invoice);
  assert.equal(pending.length, 1); assert.equal(pending[0].body.options.product, product);
  checks.push(product + ' prepared through official UI; reload retains one immutable intention' + (product === 'pix_cob' ? ' after response lost following commit' : ''));
 }
 await open(fixture.refund);
 await page.getByRole('button', { name: 'Preparar devolução Pix', exact: true }).click();
 let form = page.getByRole('dialog', { name: 'Preparar devolução Pix', exact: true });
 await form.getByLabel('Valor a devolver (R$)', { exact: true }).fill('40,00');
 await form.getByLabel('Justificativa (10 a 500 caracteres)', { exact: true }).fill('Synthetic UI partial refund');
 await form.getByRole('button', { name: 'Registrar intenção', exact: true }).click();
 await form.waitFor({state: 'hidden'});
 await page.getByText('Synthetic UI partial refund', { exact: true }).waitFor();
 await page.reload(); await page.getByText('Synthetic UI partial refund', { exact: true }).waitFor();
 assert.equal(await page.getByRole('button', { name: 'Preparar devolução Pix', exact: true }).count(), 0);
 checks.push('Pix refund reserves 4000 cents without posting cash; reload does not create another intention');
 await open(fixture.cancel);
 await page.getByRole('button', { name: 'Remover cobrança no provedor', exact: true }).click();
 form = page.getByRole('dialog', { name: 'Remover cobrança no provedor', exact: true });
 await form.getByLabel('Justificativa (10 a 500 caracteres)', { exact: true }).fill('Synthetic UI unpaid cancellation');
 await form.getByRole('button', { name: 'Registrar intenção', exact: true }).click();
 await form.waitFor({state: 'hidden'});
 await page.getByText('Synthetic UI unpaid cancellation', { exact: true }).waitFor();
 checks.push('Provider cancellation prepares audited operation without canceling ERP debt');
 await open(fixture.review);
 await page.getByRole('button', { name: 'Reagendar consulta da cobrança', exact: true }).click();
 form = page.getByRole('dialog', { name: 'Reagendar consulta', exact: true });
 await form.getByLabel('Justificativa (10 a 500 caracteres)', { exact: true }).fill('Synthetic UI operator requests lookup');
 await form.getByRole('button', { name: 'Reagendar consulta', exact: true }).click();
 await form.waitFor({state: 'hidden'});
 await page.getByText('Resultado desconhecido · consultar antes de decidir', { exact: true }).waitFor();
 checks.push('Review action queues lookup only, never resends creation');
 if (fixture.artifact) {
  await open(fixture.artifact);
  await page.getByRole('img',{name:'QR Code Pix retornado pelo provedor',exact:true}).waitFor();
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  await page.getByRole('button',{name:'Copiar Pix',exact:true}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),fixture.copy);
  checks.push('Stored provider QR renders as image and copy action writes the exact Pix payload');
 }
 await page.screenshot({ path: '/evidence/billing-desktop.png', fullPage: true });
 await page.setViewportSize({ width: 390, height: 844 }); await open(fixture.refund);
 await page.getByText('Synthetic UI partial refund', { exact: true }).waitFor();
 await page.getByText('Cobrança no provedor',{exact:true}).scrollIntoViewIfNeeded();
 const dialog=page.getByRole('dialog').first();
 if (fixture.artifact) assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+2),true,'operational invoice overflows horizontally');
 await page.screenshot({ path: '/evidence/billing-mobile.png', fullPage: true });
 await context.request.post(base + '/api/auth/logout', { headers: await csrf(context, base), data: {} });
 await login('atendimento@alfa.demo'); await open(fixture.refund);
 await page.getByText('Synthetic UI partial refund', { exact: true }).waitFor();
 for (const label of ['Preparar devolução Pix', 'Remover cobrança no provedor', 'Preparar emissão Efí']) assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
 checks.push('Read-only profile can inspect journal without operational write actions');
 const result = { ok: true, checks, real_psp_called: false, scope: 'Synthetic loopback API/database; issued and review states are owner fixtures, not bank confirmations' };
 await writeFile('/evidence/browser.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
 await writeFile('/evidence/browser-failure.txt', await page.locator('body').innerText());
 await page.screenshot({path:'/evidence/browser-failure.png',fullPage:true});
 throw error;
} finally { await context.close(); await browser.close(); }
