import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { csrf } from './csrf.mjs';
import { waitAcsState } from './acs-task-state.mjs';

// Aplicação de template ACS pela ficha do contrato, com o ACS sintético
// (tests/contrato/fixtures/acs_v0.py, NEXO_V0_ACS=1): sugestão pelo modelo do
// CPE, pré-visualização com senha mascarada, intenção durável sem duplicar na
// repetição e confirmação somente por leitura. Nenhum roteador físico é tocado.
const base = process.env.BASE ?? 'http://127.0.0.1:3002';
const fixture = process.env.V0_ACS_FIXTURE ?? 'http://127.0.0.1:18982';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1342, height: 805 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const token = Date.now();
const wifiPassword = `senha-template-${token}`;
const dialog = title => page.getByRole('dialog', { name: title, exact: true });
async function request(path, data, method = 'POST', ctx = context) {
  const response = await ctx.request.fetch(`${base}/api${path}`, { method, headers: await csrf(ctx, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.json();
}
async function confirm() { await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click(); await dialog('Confirme a ação').waitFor({ state: 'hidden' }); }
let contract;
let template;
try {
  await request('/auth/login', { email: 'admin@alfa.demo', password: 'demo1234' });
  template = await request('/acs/templates', {
    name: `Template laboratório ${token}`, manufacturer: 'Laboratório*', model: '*tr098', firmware: '0.0-*', inform_interval: 300,
    parameters: [
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', value: '{{wifi_ssid}}', type: 'xsd:string' },
      { path: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', value: '{{wifi_senha}}', type: 'xsd:string' },
      { path: 'InternetGatewayDevice.DeviceInfo.ProvisioningCode', value: 'NX-{{contrato_codigo}}', type: 'xsd:string' },
    ],
  });
  const generic = await request('/acs/templates', { name: `Template genérico ${token}`, inform_interval: 600 });
  const subscriber = await request('/subscribers', { name: `Titular template ${token}` });
  const plan = (await request('/plans', null, 'GET')).find(item => item.name === 'Fibra 200');
  contract = await request('/contracts', { subscriber_id: subscriber.id, plan_id: plan.id, due_day: 10 });
  await page.goto(`${base}/contratos?contrato=${contract.id}`);
  await page.getByRole('tab', { name: 'Acesso', exact: true }).click();
  await page.getByLabel('Número de série do roteador', { exact: true }).fill('V0ACS098');
  await page.getByRole('button', { name: 'Procurar roteador', exact: true }).click();
  await page.getByRole('button', { name: 'Vincular roteador', exact: true }).click();
  await page.getByText('192.0.2.98', { exact: true }).waitFor();
  const suggestions = page.waitForResponse(r => r.url().endsWith(`/api/contracts/${contract.id}/cpe/templates`) && r.request().method() === 'GET');
  await page.getByRole('button', { name: 'Aplicar template', exact: true }).click();
  const suggested = await (await suggestions).json();
  assert.equal(suggested.suggested_id, template.id);
  assert.ok(suggested.templates.some(item => item.id === generic.id));
  const apply = dialog('Aplicar template ACS');
  await apply.getByRole('option', { name: `${template.name} (sugerido)`, exact: true }).waitFor({ state: 'attached' });
  let selected = '';
  for (let i = 0; i < 50 && selected !== template.id; i++) {
    selected = await apply.getByLabel('Template a aplicar', { exact: true }).inputValue();
    if (selected !== template.id) await page.waitForTimeout(100);
  }
  assert.equal(selected, template.id);
  console.log('Template ACS: a ficha sugere o template mais específico que casa com fabricante, modelo e firmware do CPE');
  await apply.getByLabel('Nome da rede Wi-Fi do template', { exact: true }).fill('Rede template v0');
  await apply.getByLabel('Senha do Wi-Fi do template', { exact: true }).fill(wifiPassword);
  const previewed = page.waitForResponse(r => r.url().endsWith(`/api/contracts/${contract.id}/cpe/template/preview`));
  await apply.getByRole('button', { name: 'Pré-visualizar valores', exact: true }).click();
  const preview = await (await previewed).json();
  assert.equal(preview.ready, true);
  assert.equal(JSON.stringify(preview).includes(wifiPassword), false);
  await apply.getByText('Rede template v0', { exact: true }).waitFor();
  await apply.getByText('Senha mascarada', { exact: true }).waitFor();
  await apply.getByText('InternetGatewayDevice.ManagementServer.PeriodicInformInterval', { exact: true }).waitFor();
  assert.equal((await apply.innerText()).includes(wifiPassword), false);
  console.log('Template ACS: pré-visualização resolve variáveis do contrato e mascara a senha do Wi-Fi');
  const applied = page.waitForResponse(r => r.url().endsWith(`/api/contracts/${contract.id}/cpe/template`) && r.request().method() === 'POST');
  await apply.getByRole('button', { name: 'Registrar aplicação do template', exact: true }).click();
  const appliedResponse = await applied;
  const body = await appliedResponse.json();
  assert.equal(body.result, 'prepared');
  await apply.waitFor({ state: 'hidden' });
  const intent = appliedResponse.request().postDataJSON().intent_id;
  const replay = await request(`/contracts/${contract.id}/cpe/template`, { template_id: template.id, intent_id: intent, wifi_ssid: 'Rede template v0', wifi_senha: wifiPassword });
  assert.equal(replay.task_id, body.task_id);
  assert.equal((await request(`/contracts/${contract.id}/cpe/tasks`, null, 'GET')).filter(task => task.kind === 'template').length, 1);
  await waitAcsState(request, `/contracts/${contract.id}/cpe/tasks`, 'observed', { lookup: true });
  const tasks = await (await context.request.get(`${fixture}/_fixture/tasks`)).json();
  const sent = tasks.filter(task => task.device === 'V0ACS098' && task.payload.parameterValues?.some(value => value[0] === 'InternetGatewayDevice.DeviceInfo.ProvisioningCode'));
  assert.equal(sent.length, 1);
  const values = Object.fromEntries(sent[0].payload.parameterValues.map(([path, value]) => [path, value]));
  assert.equal(values['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'], 'Rede template v0');
  assert.equal(values['InternetGatewayDevice.ManagementServer.PeriodicInformInterval'], 300);
  assert.equal(values['InternetGatewayDevice.DeviceInfo.ProvisioningCode'], `NX-${contract.id.slice(0, 8).toUpperCase()}`);
  await page.reload();
  await page.getByRole('tab', { name: 'Acesso', exact: true }).click();
  await page.getByText('Aplicar template ACS', { exact: true }).first().waitFor();
  await page.getByText('Alteração observada por leitura', { exact: true }).first().waitFor();
  assert.equal((await page.locator('body').innerText()).includes(wifiPassword), false);
  assert.equal(JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).includes(wifiPassword), false);
  console.log('Template ACS: aplicação gera uma única intenção durável, enviada pelo diário ACS e confirmada por leitura');
  const beta = await browser.newContext();
  await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } });
  assert.equal((await beta.request.get(`${base}/api/contracts/${contract.id}/cpe/templates`)).status(), 404);
  await beta.close();
  await page.getByRole('button', { name: 'Desvincular roteador', exact: true }).click();
  await confirm();
  assert.equal((await request(`/contracts/${contract.id}/cpe`, null, 'GET')).linked, false);
  for (const item of [template, generic]) await request(`/acs/templates/${item.id}`, null, 'DELETE');
  assert.deepEqual(errors, []);
  console.log('Template ACS: isolamento entre provedores e desvínculo ao final, sem roteador físico');
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-4000));
  await page.screenshot({ path: '/tmp/nexo-v0-acs-template-failure.png' }).catch(() => {});
  throw error;
} finally { await context.close(); await browser.close(); }
