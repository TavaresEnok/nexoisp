import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const token = Date.now();
const popName = `POP inventário ${token}`;
const siteName = `Poste sintético ${token}`;
const editedName = `Poste editado ${token}`;
const dialog = name => page.getByRole('dialog', { name, exact: true });
const row = name => page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
async function save(name) { await dialog(name).getByRole('button', { name: 'Salvar', exact: true }).click(); await dialog(name).waitFor({ state: 'hidden' }); }
async function confirm() { await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click(); await dialog('Confirme a ação').waitFor({ state: 'hidden' }); }
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill('admin@alfa.demo');
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  const response = await context.request.post(`${base}/api/pops`, { headers: await csrf(context, base), data: { name: popName, city: 'Cidade sintética', state: 'CE' } });
  assert.equal(response.ok(), true, await response.text());
  const pop = await response.json();
  await page.goto(`${base}/pops`);
  await page.getByRole('button', { name: 'Novo local', exact: true }).click();
  await dialog('Novo local').getByLabel('POP do local', { exact: true }).selectOption(pop.id);
  await dialog('Novo local').getByLabel('Nome do local', { exact: true }).fill(siteName);
  await dialog('Novo local').getByLabel('Cidade do local', { exact: true }).fill('Cidade sintética');
  await save('Novo local');
  await page.getByLabel('POP do filtro', { exact: true }).selectOption(pop.id);
  await page.getByLabel('Tipo de local', { exact: true }).selectOption('pole');
  await page.getByLabel('Buscar locais', { exact: true }).fill(siteName);
  await row(siteName).waitFor();
  const exportRequestPromise = page.waitForRequest(request =>
    request.method() === 'GET' &&
    new URL(request.url()).pathname === '/api/network/sites/export.csv'
  );
  const siteDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar página CSV', exact: true }).click();
  const exportRequest = await exportRequestPromise;
  const siteDownload = await siteDownloadPromise;
  const exportParams = new URL(exportRequest.url()).searchParams;
  assert.equal(exportParams.get('q'), siteName);
  assert.equal(exportParams.get('kind'), 'pole');
  assert.equal(exportParams.get('pop_id'), pop.id);
  assert.equal(exportParams.get('status'), 'active');
  assert.equal(exportParams.get('limit'), '20');
  assert.equal(exportParams.get('offset'), '0');
  assert.equal(siteDownload.suggestedFilename(), 'locais-infraestrutura-pagina.csv');
  const siteBuffer = await readFile(await siteDownload.path());
  assert.equal(siteBuffer[0] === 0xef && siteBuffer[1] === 0xbb && siteBuffer[2] === 0xbf, true);
  const siteText = siteBuffer.toString('utf8');
  assert.equal(
    siteText.includes(
      'local_id;tipo;local;pop_id;pop;cidade;endereco;latitude;longitude;ativo;observacoes'
    ),
    true
  );
  assert.equal(siteText.includes(`;pole;${siteName};${pop.id};${popName};`), true);
  assert.equal(siteText.includes(siteName), true);
  assert.equal(siteText.includes(pop.id), true);
  assert.equal(siteText.includes(popName), true);
  await row(siteName).getByRole('button', { name: 'Consultar', exact: true }).click();
  await dialog('Consultar local').getByText(siteName, { exact: false }).waitFor();
  await dialog('Consultar local').locator('[data-slot=dialog-close]').click();
  await row(siteName).getByRole('button', { name: 'Editar local', exact: true }).click();
  await dialog('Editar local').getByLabel('Nome do local', { exact: true }).fill(editedName);
  await save('Editar local');
  await page.getByLabel('Buscar locais', { exact: true }).fill(editedName);
  await row(editedName).getByRole('button', { name: 'Arquivar', exact: true }).click();
  await confirm();
  await page.getByLabel('Situação dos locais', { exact: true }).selectOption('archived');
  await row(editedName).getByRole('button', { name: 'Reativar', exact: true }).click();
  const reactivation = page.waitForResponse(response =>
    response.request().method() === 'PATCH' &&
    /\/api\/network\/sites\/[^/]+$/.test(new URL(response.url()).pathname) &&
    response.request().postDataJSON()?.active === true
  );
  await confirm();
  assert.equal((await reactivation).status(), 200);
  await page.getByLabel('Situação dos locais', { exact: true }).selectOption('active');
  await row(editedName).getByText('Ativo', { exact: true }).waitFor();
  console.log('Inventário passivo: criação, consulta, edição, filtro, arquivo, reativação e exportação CSV concluídos.');
} finally { await context.close(); await browser.close(); }
