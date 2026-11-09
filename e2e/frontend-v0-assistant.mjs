import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { csrf } from './csrf.mjs';

// Assistente determinístico: perguntas em linguagem natural reconhecidas por
// regras e respondidas com a busca global, o diagnóstico NOC, as faturas, as
// ordens de serviço e a consulta de IP, sempre com as permissões da sessão.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const token = Date.now();
const name = `Assistente ${token}`;
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
const answer = (page, question) => page.locator('.nexo-panel').filter({ has: page.getByRole('heading', { name: `“${question}”`, exact: true }) });
async function ask(page, question, waitFor) {
  const response = waitFor ? page.waitForResponse(r => waitFor.test(new URL(r.url()).pathname)) : null;
  await page.getByLabel('Pergunta ao assistente', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Perguntar', exact: true }).click();
  await answer(page, question).waitFor();
  if (response) assert.equal((await response).status(), 200, question);
  return answer(page, question);
}
const contexts = [];
try {
  const admin = await open('admin@alfa.demo');
  contexts.push(admin.context);
  const { page, context } = admin;
  async function request(path, data, method = 'POST') {
    const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
    assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
    return response.json();
  }
  const subscriber = await request('/subscribers', { name });
  const plan = (await request('/plans', null, 'GET')).find(item => item.name === 'Fibra 200');
  const contract = await request('/contracts', { subscriber_id: subscriber.id, plan_id: plan.id, due_day: 10 });
  const order = await request('/work-orders', { subscriber_id: subscriber.id, contract_id: contract.id, kind: 'other', description: 'Visita sintética do assistente' });
  await page.goto(`${base}/assistente`);
  await page.getByRole('heading', { name: 'Assistente', exact: true }).first().waitFor();
  assert.equal(await page.getByText('Recurso planejado', { exact: true }).count(), 0);
  await page.getByRole('group', { name: 'Sugestões de perguntas', exact: true }).first().waitFor();

  let card = await ask(page, `cliente ${name}`, /^\/api\/search$/);
  const link = card.getByRole('link', { name, exact: true }).first();
  assert.equal(await link.getAttribute('href'), `/assinantes?ficha=${subscriber.id}`);
  console.log('Assistente: busca de cliente pela busca global com link para a ficha');

  card = await ask(page, `por que o cliente ${name} está sem internet?`, /^\/api\/contracts\/[^/]+\/diagnosis$/);
  const diagnosis = await request(`/contracts/${contract.id}/diagnosis`, null, 'GET');
  await card.getByText(diagnosis.verdict, { exact: false }).first().waitFor();
  assert.equal(await card.getByRole('link', { name: 'Abrir contrato e diagnóstico completo', exact: true }).getAttribute('href'), `/contratos?contrato=${contract.id}`);
  console.log('Assistente: diagnóstico NOC do contrato encontrado, sem executar comandos na rede');

  card = await ask(page, `faturas vencidas de ${name}`, /^\/api\/invoices$/);
  await card.getByText(`Nenhuma fatura vencida de ${name}.`, { exact: true }).waitFor();
  await ask(page, 'faturas vencidas', /^\/api\/invoices$/);
  console.log('Assistente: faturas vencidas do cliente e da carteira pelo financeiro');

  await ask(page, 'OS abertas de hoje', /^\/api\/work-orders$/);
  card = await ask(page, `O.S. do cliente ${name}`, /^\/api\/work-orders$/);
  assert.equal(await card.getByRole('link', { name: `OS ${order.number}`, exact: true }).getAttribute('href'), `/ordens-de-servico?ordem=${order.id}`);
  console.log('Assistente: ordens de serviço abertas de hoje e do cliente com link para a OS');

  card = await ask(page, 'IP 192.0.2.77 às 10h', /^\/api\/search$/);
  await card.getByLabel('Número do ofício ou processo', { exact: true }).fill(`Ofício sintético ${token}`);
  const lookup = page.waitForResponse(r => new URL(r.url()).pathname === '/api/legal/ip-lookup');
  await card.getByRole('button', { name: 'Consultar IP no instante', exact: true }).click();
  assert.equal((await lookup).status(), 200);
  await card.getByText('Nenhuma sessão encontrada no instante consultado.', { exact: true }).waitFor();
  console.log('Assistente: consulta de IP no instante informado, com referência legal e auditoria');

  card = await ask(page, 'qual a previsão do tempo?');
  await card.getByText('Não entendi a pergunta', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'OS abertas de hoje', exact: true }).waitFor();

  const finance = await open('financeiro@alfa.demo');
  contexts.push(finance.context);
  const requests = [];
  finance.page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/work-orders')) requests.push(r.url()); });
  await finance.page.goto(`${base}/assistente`);
  await finance.page.getByRole('heading', { name: 'Assistente', exact: true }).first().waitFor();
  assert.equal(await finance.page.getByRole('button', { name: 'OS abertas de hoje', exact: true }).count(), 0);
  const denied = await ask(finance.page, 'OS abertas de hoje');
  await denied.getByText('Consulta indisponível para sua sessão', { exact: true }).waitFor();
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
  console.log('Assistente: pergunta não reconhecida mostra sugestões e a sessão sem permissão não consulta ordens de serviço');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
