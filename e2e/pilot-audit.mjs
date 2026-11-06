import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

const base = process.env.BASE;
assert.match(base ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
const output = new URL('../docs/auditoria-2026-11-06/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const checks = [], screens = [], errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Fortaleza', reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(15000);
async function command(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, data, headers: await csrf(context, base) });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()}`);
  return response.status() === 204 ? null : response.json();
}
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill('admin@alfa.demo');
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  const session = (await context.cookies()).find(cookie => cookie.name === 'nexo_session');
  assert.ok(session?.httpOnly);
  const denied = await context.request.post(`${base}/api/subscribers`, { data: { name: 'Must fail without CSRF' } });
  assert.equal(denied.status(), 403);
  checks.push('login real por cookie HttpOnly e comando sem CSRF recusado');
  const subscriber = await command('/subscribers', { name: 'Auditoria sintética 06-11', email: 'audit@example.invalid' });
  const plans = await command('/plans', undefined, 'GET');
  const contract = await command('/contracts', { subscriber_id: subscriber.id, plan_id: plans[0].id, due_day: 15 });
  const invoice = await command('/invoices', { contract_id: contract.id, description: 'Auditoria manual sintética', amount_cents: 3500, due_date: '2026-11-15' });
  const intent = crypto.randomUUID();
  for (let i = 0; i < 2; i++) await command(`/invoices/${invoice.id}/manual-payment`, { intent_id: intent, amount_cents: 3500, paid_at: '2026-11-06', note: 'Baixa manual sintética idempotente' });
  assert.equal((await command(`/invoices/${invoice.id}`, undefined, 'GET')).status, 'paid');
  checks.push('cadastro, contrato, fatura e baixa manual idempotente pela API; título pago relido');
  await command('/tickets', { subscriber_id: subscriber.id, contract_id: contract.id, subject: 'Auditoria de atendimento sintético', category: 'technical', priority: 'high', body: 'Relato sintético para conferir fila operacional' });
  const beta = await browser.newContext();
  try {
    assert.ok((await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } })).ok());
    assert.equal((await beta.request.get(`${base}/api/subscribers/${subscriber.id}`)).status(), 404);
    assert.equal((await beta.request.get(`${base}/api/invoices/${invoice.id}`)).status(), 404);
  } finally { await beta.close(); }
  checks.push('titular e título recusados para outro provedor');

  for (const [name, route, heading] of [['assinantes', '/assinantes', 'Assinantes'], ['faturas', '/financeiro/faturas', 'Faturas'], ['atendimentos', '/atendimentos', 'Atendimentos']]) {
    for (const [size, viewport] of [['desktop', { width: 1440, height: 900 }], ['estreito', { width: 390, height: 844 }]]) {
      await page.setViewportSize(viewport);
      await page.goto(base + route);
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      await page.locator('.erp-daily table tbody tr').first().waitFor();
      await page.waitForTimeout(300);
      const metrics = await page.locator('.erp-daily').evaluate(root => {
        const table = root.querySelector('table');
        const scroll = root.querySelector('[data-slot="table-container"]');
        const body = document.documentElement;
        const details = root.querySelector('.erp-management');
        return { firstRowY: table.querySelector('tbody tr').getBoundingClientRect().top, pageWidth: body.scrollWidth, viewport: innerWidth, tableScrolls: scroll.scrollWidth > scroll.clientWidth, managementCollapsed: details ? !details.open : null };
      });
      assert.ok(metrics.pageWidth <= viewport.width + 1, `overflow: ${name} ${size}`);
      assert.ok(metrics.firstRowY < viewport.height - 60, `table below viewport: ${name} ${size} ${metrics.firstRowY}`);
      if (name === 'faturas') assert.equal(metrics.managementCollapsed, true);
      const scroller = page.locator('.erp-daily [data-slot="table-container"]').first();
      await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      const action = page.locator('.erp-daily table tbody tr').first().locator('td').last();
      const bounds = await action.boundingBox();
      assert.ok(bounds && bounds.x + bounds.width <= viewport.width + 1, 'row action remains visible');
      await scroller.evaluate(element => { element.scrollLeft = 0; });
      await page.screenshot({ path: new URL(`${name}-${size}.png`, output).pathname, fullPage: true });
      screens.push({ name, size, ...metrics });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/financeiro/faturas?busca=${encodeURIComponent(subscriber.name)}`);
  await page.locator('.erp-daily table tbody tr').first().waitFor();
  const management = page.locator('.erp-management summary');
  await management.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.erp-management').getAttribute('open'), '');
  checks.push('três filas em desktop/390 px: tabela visível, sem overflow da página, ação fixa; gerencial recolhido abre pelo teclado');
  assert.deepEqual(errors, []);
  await writeFile(new URL('browser.json', output), JSON.stringify({ ok: true, checks, screens, limits: ['Vite e HTTP locais; não valida TLS/proxy público', 'avaliação automatizada não substitui uso com atendente real', 'somente dados sintéticos'] }, null, 2) + '\n');
} catch (error) {
  await page.screenshot({ path: new URL('browser-failure.png', output).pathname, fullPage: true }).catch(() => {});
  await writeFile(new URL('browser-failure.json', output), JSON.stringify({ error: String(error), checks, screens }, null, 2) + '\n');
  throw error;
} finally { await context.close(); await browser.close(); }
