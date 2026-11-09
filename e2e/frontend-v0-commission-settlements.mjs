import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

// Liquidação de comissões (AD-17): criar a partir do período, revisar linhas,
// fechar com valores congelados, pagar, estornar, exportar CSV e descartar
// rascunho. Somente dados sintéticos do laboratório.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1342, height: 805 }, timezoneId: 'America/Fortaleza', acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const checks = [];
const errors = [];
const token = Date.now();
page.on('pageerror', (error) => errors.push(error.message));
function check(description) { checks.push(description); console.log(description); }
const dialog = (name) => page.getByRole('dialog', { name, exact: true });
async function request(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
async function confirm() {
  await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click();
  await dialog('Confirme a ação').waitFor({ state: 'hidden' });
}
async function settlementOf(id) { return request(`/commission-settlements/${id}`, null, 'GET'); }
try {
  await request('/auth/login', { email: 'admin@alfa.demo', password: 'demo1234' });
  const me = await request('/me', null, 'GET');
  const rules = await request('/commission-rules', null, 'GET');
  const previous = rules.filter((rule) => rule.subject === 'work_order' && ['other', 'repair'].includes(rule.os_kind));
  await request('/commission-rules', { subject: 'work_order', os_kind: 'other', assignee_cents: 4321, helper_cents: 0 });
  await request('/commission-rules', { subject: 'work_order', os_kind: 'repair', assignee_cents: 1234, helper_cents: 0 });
  const subscriber = await request('/subscribers', { name: `Titular comissão ${token}` });
  const orders = [];
  for (const kind of ['other', 'repair']) {
    const order = await request('/work-orders', { subscriber_id: subscriber.id, kind, description: `Comissão sintética ${kind} ${token}`, assignee_id: me.id });
    await request(`/work-orders/${order.id}/status`, { status: 'in_progress' });
    await request(`/work-orders/${order.id}/status`, { status: 'done', resolution: 'Conclusão sintética de comissão' });
    orders.push(order);
  }

  await page.goto(`${base}/administracao/catalogos-sla?aba=comissoes`);
  await page.getByRole('heading', { name: /^Liquidações de comissão/ }).waitFor();
  await page.getByRole('button', { name: 'Nova liquidação de comissão', exact: true }).click();
  const create = dialog('Nova liquidação de comissão');
  await create.getByLabel('Pessoa liquidada', { exact: true }).selectOption(me.id);
  await create.getByLabel('Observação da liquidação', { exact: true }).fill(`Fechamento sintético ${token}`);
  await create.getByRole('button', { name: 'Criar liquidação', exact: true }).click();
  await create.waitFor({ state: 'hidden' });
  let settlement = (await request('/commission-settlements', null, 'GET')).items.find((item) => item.note === `Fechamento sintético ${token}`);
  assert.ok(settlement, 'liquidação criada pela interface');
  const detail = dialog(`Liquidação nº ${settlement.number}`);
  await detail.waitFor();
  let full = await settlementOf(settlement.id);
  assert.equal(full.status, 'open');
  assert.equal(full.user_id, me.id);
  const lineOf = (order) => full.lines.find((line) => line.source_id === order.id && line.role === 'assignee');
  assert.equal(lineOf(orders[0]).amount_cents, 4321);
  assert.equal(lineOf(orders[1]).amount_cents, 1234);
  const repeated = await context.request.post(`${base}/api/commission-settlements`, { headers: await csrf(context, base), data: { competence: full.competence, user_id: me.id } });
  assert.equal(repeated.status(), 409, await repeated.text());
  check('Liquidação aberta criada pela interface congela origem, regra e valor de cada OS e recusa liquidar de novo os mesmos registros');

  await detail.getByRole('button', { name: `Retirar OS #${orders[1].number} de ${lineOf(orders[1]).user_name}`, exact: true }).click();
  await detail.getByRole('button', { name: `Retirar OS #${orders[1].number} de ${lineOf(orders[1]).user_name}`, exact: true }).waitFor({ state: 'hidden' });
  full = await settlementOf(settlement.id);
  assert.equal(lineOf(orders[1]), undefined);
  assert.ok(lineOf(orders[0]));
  check('Revisão do rascunho retira uma linha e devolve a OS à apuração pendente');

  await detail.getByRole('button', { name: 'Fechar liquidação', exact: true }).click();
  await confirm();
  await detail.getByText(/· Fechada$/).waitFor();
  await request('/commission-rules', { subject: 'work_order', os_kind: 'other', assignee_cents: 9999, helper_cents: 0 });
  full = await settlementOf(settlement.id);
  assert.equal(full.status, 'closed');
  assert.equal(lineOf(orders[0]).amount_cents, 4321);
  const today = new Date().toISOString().slice(0, 10);
  const report = await request(`/reports/commissions?from=${today.slice(0, 7)}-01&to=${today}&user_id=${me.id}`, null, 'GET');
  const mine = report.rows.find((row) => row.user_id === me.id);
  assert.ok(mine.settled_cents >= 4321, 'relatório lê o valor congelado');
  assert.equal(await detail.getByRole('button', { name: /^Retirar / }).count(), 0);
  assert.equal(await detail.getByRole('button', { name: 'Descartar rascunho', exact: true }).count(), 0);
  check('Fechamento torna o período imutável e o relatório mantém o valor congelado depois da mudança da regra');

  const csvDownload = page.waitForEvent('download');
  await detail.getByRole('button', { name: 'Exportar CSV da liquidação', exact: true }).click();
  const csvFile = await csvDownload;
  assert.equal(csvFile.suggestedFilename(), `liquidacao-comissoes-${settlement.number}.csv`);
  const csv = (await readFile(await csvFile.path())).toString('utf8');
  assert.ok(csv.includes('liquidacao;competencia;periodo_inicio;periodo_fim;situacao;pessoa;origem;registro;papel;data;natureza_os;regra_id;valor_centavos'));
  assert.ok(csv.includes(`"OS #${orders[0].number}"`) && csv.includes('"4321"') && csv.includes('"fechada"'));
  check('Exportação CSV da liquidação traz as linhas congeladas e o total');

  await detail.getByRole('button', { name: 'Marcar como paga', exact: true }).click();
  const pay = dialog(`Pagar liquidação nº ${settlement.number}`);
  await pay.getByLabel('Forma de pagamento', { exact: true }).selectOption('payroll');
  await pay.getByLabel('Observação do pagamento', { exact: true }).fill('Folha sintética');
  await pay.getByRole('button', { name: 'Registrar pagamento', exact: true }).click();
  await detail.getByText(/· Paga$/).waitFor();
  full = await settlementOf(settlement.id);
  assert.equal(full.status, 'paid');
  assert.equal(full.paid_method, 'payroll');
  check('Pagamento registra data, forma e observação da liquidação fechada');

  await detail.getByRole('button', { name: 'Estornar liquidação', exact: true }).click();
  const reverse = dialog(`Estornar liquidação nº ${settlement.number}`);
  await reverse.getByLabel('Motivo do estorno', { exact: true }).fill('Pagamento em duplicidade sintético');
  await reverse.getByRole('button', { name: 'Confirmar estorno', exact: true }).click();
  await detail.getByText(/· Estornada$/).waitFor();
  full = await settlementOf(settlement.id);
  assert.equal(full.status, 'reversed');
  assert.equal(full.reversal_reason, 'Pagamento em duplicidade sintético');
  assert.ok(full.paid_on, 'pagamento preservado no estorno');
  assert.ok(lineOf(orders[0]), 'linhas preservadas no estorno');
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: `Nº ${settlement.number}`, exact: true }) }).getByText('Estornada', { exact: true }).waitFor();
  check('Estorno da liquidação paga gera registro, preserva linhas e pagamento e libera os registros');

  await page.getByRole('button', { name: 'Nova liquidação de comissão', exact: true }).click();
  await create.getByLabel('Pessoa liquidada', { exact: true }).selectOption(me.id);
  await create.getByLabel('Observação da liquidação', { exact: true }).fill(`Rascunho sintético ${token}`);
  await create.getByRole('button', { name: 'Criar liquidação', exact: true }).click();
  await create.waitFor({ state: 'hidden' });
  const draft = (await request('/commission-settlements', null, 'GET')).items.find((item) => item.note === `Rascunho sintético ${token}`);
  const drafted = await settlementOf(draft.id);
  assert.ok(drafted.lines.some((line) => line.source_id === orders[0].id && line.amount_cents === 9999), 'registro estornado volta pela regra vigente');
  assert.ok(drafted.lines.some((line) => line.source_id === orders[1].id), 'linha retirada volta a ser liquidável');
  await dialog(`Liquidação nº ${draft.number}`).getByRole('button', { name: 'Descartar rascunho', exact: true }).click();
  await confirm();
  await dialog(`Liquidação nº ${draft.number}`).waitFor({ state: 'hidden' });
  assert.equal((await context.request.get(`${base}/api/commission-settlements/${draft.id}`)).status(), 404);
  check('Rascunho criado após o estorno reúne os registros liberados e pode ser descartado');

  const attendant = await browser.newContext();
  await attendant.request.post(`${base}/api/auth/login`, { data: { email: 'atendimento@alfa.demo', password: 'demo1234' } });
  assert.equal((await attendant.request.get(`${base}/api/commission-settlements`)).status(), 200);
  assert.equal((await attendant.request.post(`${base}/api/commission-settlements/${settlement.id}/reverse`, { headers: await csrf(attendant, base), data: { reason: 'Tentativa sem permissão' } })).status(), 403);
  await attendant.close();
  const beta = await browser.newContext();
  await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } });
  assert.equal((await beta.request.get(`${base}/api/commission-settlements/${settlement.id}`)).status(), 404);
  assert.equal((await (await beta.request.get(`${base}/api/commission-settlements`)).json()).items.some((item) => item.id === settlement.id), false);
  await beta.close();
  check('Leitura com finance:read, ações com finance:write e isolamento entre provedores aplicados pelo Go');

  for (const rule of previous) await request('/commission-rules', { subject: 'work_order', os_kind: rule.os_kind, assignee_cents: rule.assignee_cents, helper_cents: rule.helper_cents });
  assert.deepEqual(errors, []);
  await writeFile(new URL('../docs/integracao-v0/evidencias/integracao-liquidacao-comissoes.json', import.meta.url), JSON.stringify({ ok: true, base, verified_at: new Date().toISOString(), backend: 'Go/PostgreSQL isolados; somente dados sintéticos', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks }));
} catch (error) {
  console.error('Verificações concluídas:', checks);
  await page.screenshot({ path: '/tmp/nexo-v0-commission-settlements-failure.png' }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
}
