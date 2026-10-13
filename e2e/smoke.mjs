// Teste de fumaça da interface: abre o sistema em um navegador de verdade e percorre o essencial com contas de demonstração.
// Uso:  BASE=http://localhost:18080 node smoke.mjs     (o servidor precisa estar em modo demonstração)
// Falha com código 1 se alguma etapa falhar, houver erro de página, chamada de API com erro inesperado ou janela nativa do navegador.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:18080';
const problems = [];
const browser = await chromium.launch();

async function open(email, viewport = { width: 1366, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`[${email}] erro de página: ${e.message}`));
  page.on('dialog', (d) => { problems.push(`[${email}] janela nativa do navegador: ${d.message()}`); d.dismiss(); });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (r.status() >= 400 && u.pathname.startsWith('/api/') && !['/api/me'].includes(u.pathname)) problems.push(`[${email}] ${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  await page.goto(`${BASE}/login`);
  await page.fill('input[type=email]', email);
  await page.fill('input[autocomplete=current-password]', 'demo1234');
  await page.click('button[type=submit]');
  await page.waitForSelector('.side a.nav, .portal');
  return page;
}
async function step(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { problems.push(`ETAPA "${name}": ${e.message.split('\n')[0]}`); console.log('FALHA', name); }
}

await step('login recusa senha errada com mensagem clara', async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.fill('input[type=email]', 'admin@alfa.demo'); await p.fill('input[autocomplete=current-password]', 'errada'); await p.click('button[type=submit]');
  await p.waitForSelector('text=e-mail ou senha inválidos');
  await p.click('button:has-text("Mostrar")');
  if ((await p.locator('input[autocomplete=current-password]').getAttribute('type')) !== 'text') throw new Error('mostrar senha não funcionou');
  await ctx.close();
});

const admin = await open('admin@alfa.demo');
await step('início mostra saudação e menu por área', async () => {
  await admin.waitForSelector('h1:has-text("Bom"), h1:has-text("Boa")');
  for (const area of ['Cadastro', 'Financeiro', 'Rede']) await admin.waitForSelector(`button.group:has-text("${area}")`);
});
await step('assinantes: busca e ficha', async () => {
  await admin.goto(`${BASE}/assinantes`);
  await admin.fill('input.search', 'Ana');
  await admin.waitForSelector('tbody tr');
  await admin.click('tbody tr a >> nth=0');
  await admin.waitForSelector('text=Contratos');
});
await step('contrato: abas e próxima ação', async () => {
  await admin.goto(`${BASE}/contratos`);
  await admin.click('tbody tr a:has-text("abrir") >> nth=0');
  await admin.waitForSelector('.tabs');
  for (const aba of ['Acesso', 'Contrato', 'Histórico']) { await admin.click(`button[role=tab]:has-text("${aba}")`); }
  await admin.click('button[role=tab]:has-text("Acesso")');
  await admin.waitForSelector('.next');
});
await step('faturas: resumo, filtro e fatura aberta', async () => {
  await admin.goto(`${BASE}/faturas`);
  await admin.waitForSelector('text=Recebido por mês');
  await admin.click('button:has-text("Gerar faturas da competência")');          // banco novo não tem faturas; gerar é idempotente
  await admin.waitForSelector('text=nada duplicado');
  await admin.waitForSelector('tbody tr');
  await admin.click('tbody tr button:has-text("abrir") >> nth=0');
  await admin.waitForSelector('.modal');
  await admin.keyboard.press('Escape');
  await admin.waitForSelector('.modal', { state: 'detached' });
});
await step('confirmação é do sistema, não do navegador', async () => {
  await admin.goto(`${BASE}/contratos`);
  await admin.click('tbody tr a:has-text("abrir") >> nth=0');
  await admin.click('button:has-text("Encerrar contrato")');
  await admin.waitForSelector('.modal:has-text("Motivo")');                      // pede o motivo antes de qualquer coisa
  await admin.click('.modal button:has-text("Cancelar")');
  await admin.waitForSelector('.modal', { state: 'detached' });
  await admin.waitForSelector('button:has-text("Encerrar contrato")');          // nada foi encerrado
  await admin.click('button:has-text("Encerrar contrato")');
  await admin.click('.modal button.primary:has-text("Encerrar contrato"), .modal button[type="submit"]');
  await admin.waitForSelector('.modal.dialog');                                  // a confirmação é do sistema, não do navegador
  await admin.click('.modal.dialog button:has-text("Cancelar")');
  await admin.waitForSelector('.modal.dialog', { state: 'detached' });
  await admin.keyboard.press('Escape');
});
await step('NOC e operações abrem', async () => {
  for (const [path, texto] of [['/noc', 'Portas PON'], ['/operacoes', 'Operações']]) { await admin.goto(`${BASE}${path}`); await admin.waitForSelector(`text=${texto}`); }
});
await step('tema escuro alterna e persiste', async () => {
  await admin.click('button[aria-label="Usar tema escuro"]');
  await admin.reload(); await admin.waitForSelector('.side a.nav');
  if ((await admin.evaluate(() => document.documentElement.dataset.theme)) !== 'dark') throw new Error('tema não persistiu');
  await admin.click('button[aria-label="Usar tema claro"]');
});

const fin = await open('financeiro@alfa.demo');
await step('financeiro não vê a rede (menu e servidor)', async () => {
  if (await fin.locator('a.nav:has-text("Agentes e equipamentos")').count()) throw new Error('menu mostra rede ao financeiro');
  const r = await fin.request.get(`${BASE}/api/devices`);
  if (r.status() !== 403) throw new Error(`servidor respondeu ${r.status()} em /api/devices`);
});

const portalEmail = `fumaca-${Date.now() % 1e6}@exemplo.demo`;
await step('portal: assinante vê só o seu', async () => {
  const [sub] = await (await admin.request.get(`${BASE}/api/subscribers?limit=1`)).json();
  const r = await admin.request.post(`${BASE}/api/subscribers/${sub.id}/portal-access`, { headers: { 'X-Nexo-CSRF': '1' }, data: { email: portalEmail, password: 'demo1234' } });
  if (!r.ok()) throw new Error('não criou o acesso do portal');
  const p = await open(portalEmail, { width: 420, height: 860 });
  await p.waitForSelector('.portal .hello');
  await p.waitForSelector('text=Minhas faturas');
  if ((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) > 4) throw new Error('portal rola na horizontal no celular');
  const r2 = await p.request.get(`${BASE}/api/subscribers`);
  if (r2.status() !== 403) throw new Error(`assinante acessou /api/subscribers (${r2.status()})`);
});

await browser.close();
const esperado = (p) => /^\[financeiro@alfa\.demo\] 403 GET \/api\/devices|^\[fumaca-.*\] 403 GET \/api\/subscribers/.test(p);
const reais = problems.filter((p) => !esperado(p));
if (reais.length) { console.error('\nPROBLEMAS:\n' + reais.join('\n')); process.exit(1); }
console.log('\nfumaça da interface: tudo certo');
