// Synthetic HTTP delays verify the real React hooks, never a production API.
// Start Vite locally; BASE=http://127.0.0.1:18890 node sgp-auditoria.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.env.BASE ?? 'http://127.0.0.1:18890';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const failures = [];
page.on('pageerror', e => failures.push(e.message));
const requests = [];
let slowList;
let slowDetail;
const fulfill = (route, data) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Total-Count': '120' }, body: JSON.stringify(data) });
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await page.route('**/__auditoria_hooks', route => route.fulfill({ contentType: 'text/html', body:
    `<div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/@fs${fileURLToPath(new URL('./sgp-harness.tsx', import.meta.url))}"></script>` }));
  await page.route('**/api/audit-list?*', async route => {
    const url = new URL(route.request().url());
    requests.push({ query: url.searchParams.get('q'), offset: url.searchParams.get('offset') });
    if (url.searchParams.get('q') === 'failure') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Falha sintética de consulta' }) });
      return;
    }
    if (url.searchParams.get('q') === 'old') { slowList = route; return; }
    await fulfill(route, [{ name: url.searchParams.get('q') }]);
  });
  await page.route('**/api/audit-detail/*', async route => {
    if (route.request().url().endsWith('/slow')) { slowDetail = route; return; }
    await fulfill(route, { name: route.request().url().endsWith('/one') ? 'first' : 'second' });
  });
  const expectText = async (selector, text) => {
    await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent === text, { selector, text });
  };
  await page.goto(base+'/__auditoria_hooks');
  await expectText('#rows', 'base'); await expectText('#detail', 'first');
  await Promise.all([
    page.waitForRequest(req => req.url().includes('/api/audit-list') && req.url().includes('offset=50')),
    page.getByText('Próxima', { exact: true }).click(),
  ]);
  await expectText('#page', '1');
  await page.getByLabel('Filtro').fill('old');
  await page.waitForFunction(() => document.querySelector('#rows')?.textContent === 'loading');
  // Wait for interception, independently of browser rendering or server speed.
  for (let i = 0; !slowList && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slowList, 'requisição antiga interceptada');
  await page.getByLabel('Filtro').fill('new');
  await expectText('#rows', 'new');
  await fulfill(slowList, [{ name: 'old' }]); await settle();
  assert.equal(await page.locator('#rows').textContent(), 'new', 'resposta antiga não pode substituir novo filtro');
  assert.ok(requests.filter(r => r.query === 'new' || r.query === 'old').every(r => r.offset === '0'), 'novo filtro começa na página zero');
  const beforeReturn = requests.length;
  await page.getByLabel('Filtro').fill('base');
  await expectText('#rows', 'base'); await expectText('#page', '0');
  assert.ok(requests.slice(beforeReturn).every(r => r.offset === '0'), 'voltar a filtro anterior não recupera página antiga');
  await page.getByLabel('Filtro').fill('failure');
  await page.waitForFunction(() => !!document.querySelector('#error')?.textContent);
  await expectText('#total', '0');
  assert.equal(await page.locator('#rows').textContent(), 'loading', 'erro de outro filtro não pode manter linhas anteriores');
  await page.getByText('Detalhe lento', { exact: true }).click();
  await expectText('#detail', 'loading');
  for (let i = 0; !slowDetail && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(slowDetail);
  await page.getByText('Outro detalhe', { exact: true }).click();
  await expectText('#detail', 'second');
  await fulfill(slowDetail, { name: 'old-detail' }); await settle();
  assert.equal(await page.locator('#detail').textContent(), 'second');
  await page.getByText('Limpar detalhe', { exact: true }).click();
  await expectText('#detail', 'empty');
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ ok: true, check: 'AUD-06', viewport: '390x844',
    assertions: ['último filtro prevalece', 'filtro reinicia offset e retorno ao filtro anterior', 'erro não mantém linhas/totais de outro filtro', 'detalhe anterior oculto durante carga', 'resposta antiga ignorada', 'null limpa detalhe', 'sem erro de página'] }));
} finally { await browser.close(); }
