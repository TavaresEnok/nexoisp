import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { csrf } from './csrf.mjs';

// Requires the isolated synthetic environment used by frontend-v0-field.mjs.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
async function request(path, data, method = data ? 'POST' : 'GET') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.ok(response.ok(), `${method} ${path}: ${await response.text()}`);
  return response.json();
}
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill('admin@alfa.demo');
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  const label = `R03 ${Date.now()}`;
  const subscriber = await request('/subscribers', { name: label, phone: '85999998888', address_city: 'Fortaleza' });
  const order = await request('/work-orders', { subscriber_id: subscriber.id, kind: 'other', description: label });
  const item = await request('/stock/items', { name: label, unit: 'un', min_qty: 0, serialized: false });
  await request(`/stock/items/${item.id}/movements`, { kind: 'in', qty: 10 });
  await page.goto(`${base}/ordens-de-servico?ordem=${order.id}`);
  await page.getByLabel('Material do estoque', { exact: true }).selectOption(item.id);
  let first;
  await page.route(`**/api/work-orders/${order.id}/materials`, async route => {
    first = route.request().postDataJSON();
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed'); // Real backend committed; only its response is lost.
  }, { times: 1 });
  await page.getByRole('button', { name: 'Lançar material', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal((await request('/stock/items')).find(row => row.id === item.id).balance, 9);
  const denied = await context.request.post(`${base}/api/work-orders/${order.id}/materials`, { data: first });
  assert.equal(denied.status(), 403);
  await page.reload();
  await page.getByRole('button', { name: 'Confirmar lançamento pendente', exact: true }).waitFor();
  const replay = page.waitForRequest(req => req.url().endsWith(`/work-orders/${order.id}/materials`) && req.method() === 'POST');
  await page.getByRole('button', { name: 'Confirmar lançamento pendente', exact: true }).click();
  assert.deepEqual((await replay).postDataJSON(), first);
  await page.getByRole('button', { name: 'Lançar material', exact: true }).waitFor();
  assert.equal((await request('/stock/items')).find(row => row.id === item.id).balance, 9);
  await page.getByLabel('Material do estoque', { exact: true }).selectOption(item.id);
  const second = page.waitForResponse(res => res.url().endsWith(`/work-orders/${order.id}/materials`) && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Lançar material', exact: true }).click();
  const response = await second;
  assert.equal(response.status(), 200);
  assert.notEqual(response.request().postDataJSON().intention_id, first.intention_id);
  assert.equal((await request('/stock/items')).find(row => row.id === item.id).balance, 8);
  console.log('R03: resposta perdida, replay e novo consumo iguais verificados no backend real');
} finally { await context.close(); await browser.close(); }
