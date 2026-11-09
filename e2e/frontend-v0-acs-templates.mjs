import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { csrf } from './csrf.mjs';

// Templates ACS pela tela oficial: cadastro com validação de variáveis,
// consulta, edição, inativação, reativação, exclusão e isolamento por provedor.
// Não usa roteador nem ACS: o cadastro é passivo; a aplicação é coberta por
// frontend-v0-acs-template-apply.mjs com o ACS sintético.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const token = Date.now();
const name = `Template sintético ${token}`;
const edited = `Template editado ${token}`;
const dialog = title => page.getByRole('dialog', { name: title, exact: true });
const row = text => page.getByRole('row').filter({ has: page.getByText(text, { exact: true }) });
async function confirm() { await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click(); await dialog('Confirme a ação').waitFor({ state: 'hidden' }); }
const response = (method, pattern) => page.waitForResponse(r => r.request().method() === method && pattern.test(new URL(r.url()).pathname));
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill('admin@alfa.demo');
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  const listed = response('GET', /^\/api\/acs\/templates$/);
  await page.goto(`${base}/rede/ftth/acs-template`);
  await page.getByRole('heading', { name: 'Templates ACS', exact: true }).first().waitFor();
  assert.equal((await listed).status(), 200);
  assert.equal(await page.getByText('Recurso planejado', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Novo template ACS', exact: true }).click();
  const editor = dialog('Novo template ACS');
  await editor.getByLabel('Nome do template', { exact: true }).fill(name);
  await editor.getByLabel('Fabricante (curingas permitidos)', { exact: true }).fill('Laboratório*');
  await editor.getByLabel('Modelo (curingas permitidos)', { exact: true }).fill('*tr098');
  await editor.getByLabel('Versão de firmware (curingas permitidos)', { exact: true }).fill('0.0-*');
  await editor.getByLabel('Intervalo de inform periódico (segundos)', { exact: true }).fill('300');
  await editor.getByLabel('Parâmetros TR-069', { exact: true }).fill('InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID = {{senha_root}}');
  const rejected = response('POST', /^\/api\/acs\/templates$/);
  await editor.getByRole('button', { name: 'Salvar', exact: true }).click();
  assert.equal((await rejected).status(), 400);
  await editor.getByRole('alert').getByText(/variável desconhecida/).waitFor();
  await editor.getByLabel('Parâmetros TR-069', { exact: true }).fill([
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID = {{wifi_ssid}}',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase = {{wifi_senha}}',
    'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable = true ; xsd:boolean',
    'InternetGatewayDevice.DeviceInfo.ProvisioningCode = NX-{{contrato_codigo}}',
  ].join('\n'));
  const created = response('POST', /^\/api\/acs\/templates$/);
  await editor.getByRole('button', { name: 'Salvar', exact: true }).click();
  const template = await (await created).json();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(template.name, name);
  assert.equal(template.data_model, 'tr098');
  assert.equal(template.inform_interval, 300);
  assert.deepEqual(template.variables, ['wifi_ssid', 'wifi_senha', 'contrato_codigo']);
  await page.getByLabel('Buscar templates', { exact: true }).fill(String(token));
  await row(name).waitFor();
  console.log('Templates ACS: cadastro recusa variável desconhecida e grava parâmetros TR-098, curingas e inform periódico');
  const refreshed = response('GET', /^\/api\/acs\/templates$/);
  await row(name).getByRole('button', { name: 'Consultar', exact: true }).click();
  await dialog('Consultar template ACS').getByText(/ProvisioningCode = NX-\{\{contrato_codigo\}\}/).waitFor();
  await dialog('Consultar template ACS').locator('[data-slot=dialog-close]').click();
  await row(name).getByRole('button', { name: 'Editar template', exact: true }).click();
  await dialog('Editar template ACS').getByLabel('Nome do template', { exact: true }).fill(edited);
  const patched = response('PATCH', /^\/api\/acs\/templates\/[^/]+$/);
  await dialog('Editar template ACS').getByRole('button', { name: 'Salvar', exact: true }).click();
  assert.equal((await (await patched).json()).revision, 2);
  await dialog('Editar template ACS').waitFor({ state: 'hidden' });
  await row(edited).getByRole('button', { name: 'Inativar', exact: true }).click();
  await confirm();
  await row(edited).getByText('Inativo', { exact: true }).waitFor();
  await row(edited).getByRole('button', { name: 'Reativar', exact: true }).click();
  await confirm();
  await row(edited).getByText('Ativo', { exact: true }).waitFor();
  assert.equal((await refreshed).status(), 200);
  console.log('Templates ACS: consulta, edição com nova revisão, inativação e reativação pela tela');
  const beta = await browser.newContext();
  await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } });
  assert.equal((await beta.request.get(`${base}/api/acs/templates/${template.id}`)).status(), 404);
  assert.equal((await beta.request.get(`${base}/api/acs/templates?q=${token}`).then(r => r.json())).total, 0);
  await beta.close();
  const finance = await browser.newContext();
  await finance.request.post(`${base}/api/auth/login`, { data: { email: 'financeiro@alfa.demo', password: 'demo1234' } });
  assert.equal((await finance.request.get(`${base}/api/acs/templates`)).status(), 403);
  await finance.close();
  const deleted = response('DELETE', /^\/api\/acs\/templates\/[^/]+$/);
  await page.getByRole('button', { name: `Excluir ${edited}`, exact: true }).click();
  await confirm();
  assert.equal((await deleted).status(), 200);
  await row(edited).waitFor({ state: 'detached' });
  const gone = await context.request.get(`${base}/api/acs/templates/${template.id}`, { headers: await csrf(context, base) });
  assert.equal(gone.status(), 404);
  assert.deepEqual(errors, []);
  console.log('Templates ACS: exclusão auditada, isolamento entre provedores e bloqueio sem permissão de rede');
} finally { await context.close(); await browser.close(); }
