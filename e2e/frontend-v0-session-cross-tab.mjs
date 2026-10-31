import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { csrf } from './csrf.mjs';

const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext();
const a = await context.newPage(), b = await context.newPage();
const id = randomUUID();
const oldName = `R01 antiga ${id}`, newName = `R01 nova ${id}`, cachedName = `R01 cache ${id}`;
const dialog = page => page.getByRole('dialog', { name: 'Novo prospecto', exact: true });
const routePattern = '**/api/leads?*';
const routeTasks = new Set();
const routeErrors = [];
let releaseLeads, routeInstalled = false;
function bounded(promise, label, ms = 10000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function drainRoutes() {
  await bounded((async () => {
    while (routeTasks.size) await Promise.all([...routeTasks]);
  })(), 'conclusão dos handlers de leads');
}
function checkRouteErrors() {
  if (routeErrors.length) throw new AggregateError(routeErrors, 'Falha nos handlers de leads');
}
async function login(page, email, navigate = true) {
  if (navigate) await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  const today = page.waitForResponse(response => new URL(response.url()).pathname === '/api/today');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  assert.equal((await today).status(), 200);
}
async function form(page, name, navigate = true) {
  if (navigate) await page.goto(`${base}/prospectos`);
  await page.getByRole('button', { name: 'Novo prospecto', exact: true }).click();
  await dialog(page).getByLabel('Nome do prospecto', { exact: true }).fill(name);
  await dialog(page).getByLabel('Telefone', { exact: true }).fill('85999998888');
}
let primaryError;
try {
  await login(a, 'admin@alfa.demo');
  const reloadToday = a.waitForResponse(response => new URL(response.url()).pathname === '/api/today');
  await a.reload();
  assert.equal((await reloadToday).status(), 200);
  await a.getByRole('heading', { name: 'Nos bastidores da sua rede', exact: true }).waitFor();
  const created = await context.request.post(`${base}/api/leads`, { headers: await csrf(context, base), data: { name: cachedName, phone: '85999998888' } });
  assert.equal(created.ok(), true);
  const cachedLead = await created.json();
  await a.goto(`${base}/prospectos`);
  await a.getByRole('textbox', { name: 'Buscar prospectos', exact: true }).fill(cachedName);
  await a.getByRole('button', { name: `Abrir prospecto ${cachedName}`, exact: true }).waitFor();
  await form(a, oldName, false);
  await b.goto(`${base}/login`);
  const switched = await b.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email: 'admin@beta.demo', password: 'demo1234' }) })).ok);
  assert.equal(switched, true);
  await dialog(a).getByRole('button', { name: 'Salvar', exact: true }).click();
  await a.getByLabel('E-mail', { exact: true }).waitFor();
  assert.equal(await a.getByText(oldName, { exact: true }).count(), 0);
  assert.equal(await a.getByText(cachedName, { exact: true }).count(), 0);
  const list = await context.request.get(`${base}/api/leads`, { headers: await csrf(context, base) });
  assert.equal(list.ok(), true);
  assert.equal((await list.json()).some(item => item.name === oldName), false);
  assert.equal((await context.request.get(`${base}/api/leads/${cachedLead.id}`)).status(), 404);
  let observedLeads;
  const leadsHeld = new Promise(resolve => { observedLeads = resolve; });
  const continueLeads = new Promise(resolve => { releaseLeads = resolve; });
  await a.route(routePattern, route => {
    const task = (async () => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.searchParams.get('q') === cachedName) {
        observedLeads();
        await continueLeads;
      }
      await route.continue();
    })().catch(error => { routeErrors.push(error); });
    routeTasks.add(task);
    void task.then(() => routeTasks.delete(task));
    return task;
  });
  routeInstalled = true;
  await login(a, 'admin@beta.demo', false);
  await bounded(leadsHeld, 'requisição de leads retida');
  assert.equal(await a.getByRole('textbox', { name: 'Buscar prospectos', exact: true }).inputValue(), cachedName);
  assert.equal(await a.getByText(cachedName, { exact: true }).count(), 0);
  releaseLeads();
  await drainRoutes();
  checkRouteErrors();
  await bounded(a.unroute(routePattern), 'remoção da rota de leads');
  routeInstalled = false;
  await drainRoutes();
  checkRouteErrors();
  await form(a, newName, false);
  assert.equal(await a.getByText(cachedName, { exact: true }).count(), 0);
  await dialog(a).getByRole('button', { name: 'Salvar', exact: true }).click();
  await dialog(a).waitFor({ state: 'hidden' });
  const after = await context.request.get(`${base}/api/leads`, { headers: await csrf(context, base) });
  assert.equal(after.ok(), true);
  assert.equal((await after.json()).some(item => item.name === newName), true);
  const back = await context.request.post(`${base}/api/auth/login`, { data: { email: 'admin@alfa.demo', password: 'demo1234' } });
  assert.equal(back.ok(), true);
  const alfa = await context.request.get(`${base}/api/leads`, { headers: await csrf(context, base) });
  assert.equal(alfa.ok(), true);
  assert.equal((await alfa.json()).some(item => item.name === oldName), false);
  await writeFile(new URL('../docs/integracao-v0/evidencias/rastreio/frontend-v0-session-cross-tab.json', import.meta.url), JSON.stringify({ ok: true, verified_at: new Date().toISOString(), checks: ['login e reload carregam /today pelo shell SWR', 'duas abas compartilham cookie', 'intenção antiga recusada e formulário removido', 'registro persistido e cache de alfa ausentes em beta', 'operação nova no segundo provedor após login explícito'] }, null, 2) + '\n');
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors = [];
  releaseLeads?.();
  try { await drainRoutes(); } catch (error) { cleanupErrors.push(error); }
  if (routeInstalled) {
    try { await bounded(a.unroute(routePattern), 'remoção da rota de leads no cleanup'); } catch (error) { cleanupErrors.push(error); }
    try { await drainRoutes(); } catch (error) { cleanupErrors.push(error); }
  }
  try { await bounded(context.close(), 'fechamento do contexto'); } catch (error) { cleanupErrors.push(error); }
  try { await bounded(browser.close(), 'fechamento do navegador'); } catch (error) { cleanupErrors.push(error); }
  if (routeErrors.length) cleanupErrors.push(new AggregateError(routeErrors, 'Falha nos handlers de leads'));
  if (primaryError) {
    if (cleanupErrors.length) console.error('Erros adicionais no cleanup:', ...cleanupErrors);
  } else if (cleanupErrors.length) {
    primaryError = new AggregateError(cleanupErrors, 'Falha no cleanup');
  }
}
if (primaryError) throw primaryError;
