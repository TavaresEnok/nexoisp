import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Acompanhamento operacional: painel somente leitura da equipe com permissão de
// rede. Confere saúde da API e do banco, agentes, operações, filas e rotinas,
// a ausência de conteúdo sensível, o bloqueio do financeiro e o isolamento.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(email) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  return { context, page };
}
const contexts = [];
try {
  const noc = await open('noc@alfa.demo');
  contexts.push(noc.context);
  const overview = noc.page.waitForResponse(r => new URL(r.url()).pathname === '/api/monitoring/overview');
  await noc.page.goto(`${base}/acompanhamento`);
  await noc.page.getByRole('heading', { name: 'Acompanhamento operacional', exact: true }).waitFor();
  const response = await overview;
  assert.equal(response.status(), 200);
  const data = await response.json();
  for (const forbidden of ['secret_enc', 'contact_value', 'token_hash', 'payload'])
    assert.equal(JSON.stringify(data).includes(forbidden), false, forbidden);
  for (const title of ['Saúde da plataforma', 'Agentes de rede', 'Operações de rede', 'Filas de avisos e entregas', 'Rotinas periódicas', 'Último backup'])
    await noc.page.getByRole('heading', { name: title, exact: true }).waitFor();
  await noc.page.getByText('Respondendo', { exact: true }).waitFor();
  await noc.page.getByText(/^Disponível · \d/).waitFor();
  for (const agent of data.agents) await noc.page.getByRole('cell', { name: agent.name, exact: true }).first().waitFor();
  await noc.page.getByText('Não há registro de backup no sistema para consultar: confira o temporizador e os arquivos do servidor.', { exact: true }).waitFor();
  assert.equal(await noc.page.getByText('Recurso planejado', { exact: true }).count(), 0);
  console.log('Acompanhamento: saúde da API e do banco, agentes, operações, filas e rotinas sem conteúdo sensível');
  const refreshed = noc.page.waitForResponse(r => new URL(r.url()).pathname === '/api/monitoring/overview');
  await noc.page.getByRole('button', { name: 'Atualizar acompanhamento', exact: true }).click();
  assert.equal((await refreshed).status(), 200);
  console.log('Acompanhamento: atualização manual consulta novamente o agregado do servidor');
  const finance = await open('financeiro@alfa.demo');
  contexts.push(finance.context);
  await finance.page.goto(`${base}/acompanhamento`);
  await finance.page.getByRole('heading', { name: 'Acesso não disponível', exact: true }).waitFor();
  assert.equal((await finance.context.request.get(`${base}/api/monitoring/overview`)).status(), 403);
  const beta = await browser.newContext();
  contexts.push(beta);
  await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } });
  const theirs = await (await beta.request.get(`${base}/api/monitoring/overview`)).json();
  const mine = new Set(data.agents.map(agent => agent.id));
  assert.equal(theirs.agents.some(agent => mine.has(agent.id)), false);
  assert.deepEqual(errors, []);
  console.log('Acompanhamento: financeiro sem permissão de rede é bloqueado e cada provedor vê apenas os próprios agentes');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
