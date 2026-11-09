import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { csrf } from './csrf.mjs';

// Projeto físico FTTH: cabos com traçado, OTDR com arquivo privado, fusões na
// ficha da caixa, importação KML (prévia, aplicação e recusas) e camada de
// cabos no mapa. Dados sintéticos com marcador de execução.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const token = Date.now();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64') }));
const popName = `POP projeto ${token}`;
const boxName = `CTO projeto ${token}`;
const cableName = `Cabo tronco ${token}`;
const branchName = `Cabo derivação ${token}`;
const dialog = name => page.getByRole('dialog', { name, exact: true });
const row = name => page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
const responseOf = (method, pattern) => page.waitForResponse(response => response.request().method() === method && pattern.test(new URL(response.url()).pathname));
async function request(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.json();
}
async function save(name) { await dialog(name).getByRole('button', { name: 'Salvar', exact: true }).click(); await dialog(name).waitFor({ state: 'hidden' }); }
async function confirm() { await dialog('Confirme a ação').getByRole('button', { name: 'Confirmar', exact: true }).click(); await dialog('Confirme a ação').waitFor({ state: 'hidden' }); }
const kml = placemarks => Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>${placemarks}</Document></kml>`);
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill('admin@alfa.demo');
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  const pop = await request('/pops', { name: popName, city: 'Cidade sintética', state: 'PI' });
  const box = await request('/ftth/boxes', { name: boxName, kind: 'cto', ports: 8, latitude: -5.1, longitude: -42.8 });

  // Cadastro de cabo com traçado por coordenadas e ponta em caixa.
  await page.goto(`${base}/rede/ftth/fttx-cto`);
  await page.getByRole('tab', { name: 'Cabos', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('aba') === 'cabos');
  await page.getByRole('button', { name: 'Novo cabo', exact: true }).click();
  await dialog('Novo cabo').getByLabel('POP do cabo', { exact: true }).selectOption(pop.id);
  await dialog('Novo cabo').getByLabel('Nome do cabo', { exact: true }).fill(cableName);
  await dialog('Novo cabo').getByLabel('Número de fibras', { exact: true }).fill('12');
  await dialog('Novo cabo').getByLabel('Ponta A do cabo', { exact: true }).selectOption(`box:${box.id}`);
  await dialog('Novo cabo').getByLabel('Traçado do cabo', { exact: true }).fill('-5.1');
  await dialog('Novo cabo').getByRole('button', { name: 'Salvar', exact: true }).click();
  await dialog('Novo cabo').getByRole('alert').filter({ hasText: 'coordenadas' }).waitFor();
  await dialog('Novo cabo').getByLabel('Traçado do cabo', { exact: true }).fill('-5.1, -42.8\n-5.101, -42.8');
  const created = responseOf('POST', /^\/api\/ftth\/cables$/);
  await save('Novo cabo');
  const createdResponse = await created;
  assert.equal(createdResponse.status(), 200, await createdResponse.text());
  const cable = await createdResponse.json();
  assert.equal(cable.name, cableName);
  assert.equal(cable.a_box_id, box.id);
  assert.ok(Math.abs(cable.computed_length_m - 111.2) < 0.01, `comprimento ${cable.computed_length_m}`);
  await page.getByLabel('POP dos cabos', { exact: true }).selectOption(pop.id);
  await page.getByLabel('Buscar cabos', { exact: true }).fill(cableName);
  await row(cableName).getByText(`${boxName} → Sem ponta`, { exact: true }).waitFor();
  console.log('Cabo: cadastro com traçado, ponta em caixa, comprimento calculado pelo Go e filtros da lista.');

  // Ficha do cabo: desenho do traçado e medição OTDR com arquivo privado.
  await row(cableName).getByRole('button', { name: `Ficha do cabo ${cableName}`, exact: true }).click();
  await page.getByRole('heading', { name: `${cableName} · cabo`, exact: true }).waitFor();
  await page.getByRole('img', { name: `Traçado do cabo ${cableName}`, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Registrar medição OTDR', exact: true }).click();
  const otdrDialog = dialog('Registrar medição OTDR');
  await otdrDialog.getByLabel('Fibra medida', { exact: true }).fill('3');
  await otdrDialog.getByLabel('Comprimento de onda', { exact: true }).selectOption('1310');
  await otdrDialog.getByLabel('Distância total (m)', { exact: true }).fill('111');
  await otdrDialog.getByLabel('Perda total (dB)', { exact: true }).fill('0,4');
  await otdrDialog.getByLabel('Técnico responsável', { exact: true }).fill('Técnica sintética');
  await otdrDialog.getByLabel('Eventos da medição', { exact: true }).fill('50; 0,1; Fusão\n10; 0,3; Conector');
  await otdrDialog.getByLabel('Arquivo bruto da medição', { exact: true }).setInputFiles({ name: 'medicao.sor', mimeType: 'application/octet-stream', buffer: Buffer.from('SOR sintético') });
  const measured = responseOf('POST', /^\/api\/ftth\/cables\/[^/]+\/otdr$/);
  await save('Registrar medição OTDR');
  const measurement = await (await measured).json();
  assert.equal(measurement.fiber, 3);
  assert.equal(measurement.wavelength_nm, 1310);
  assert.deepEqual(measurement.events.map(event => event.type), ['connector', 'splice']);
  const fileDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar arquivo medicao.sor', exact: true }).click();
  const downloaded = await fileDownload;
  assert.equal(downloaded.suggestedFilename(), 'medicao.sor');
  assert.equal((await readFile(await downloaded.path())).toString('utf8'), 'SOR sintético');
  await page.keyboard.press('Escape');
  await page.waitForURL(url => !url.searchParams.has('cabo'));
  console.log('OTDR: medição por fibra com eventos ordenados e download autenticado do arquivo bruto.');

  // Fusões na ficha da caixa: registro, recusa de fibra repetida e remoção.
  const branch = await request('/ftth/cables', { pop_id: pop.id, name: branchName, kind: 'drop', fiber_count: 2, path: [{ lat: -5.1, lng: -42.8 }, { lat: -5.1, lng: -42.801 }] });
  await page.getByRole('tab', { name: 'Caixas', exact: true }).click();
  await page.getByRole('button', { name: `Portas de ${boxName}`, exact: true }).click();
  await page.getByRole('heading', { name: `${boxName} · portas`, exact: true }).waitFor();
  await page.getByText('Nenhuma fusão registrada nesta caixa.', { exact: true }).waitFor();
  for (const attempt of ['first', 'duplicate']) {
    await page.getByRole('button', { name: 'Registrar fusão', exact: true }).click();
    const fusion = dialog('Registrar fusão');
    await fusion.getByLabel('Buscar cabo de origem', { exact: true }).fill(cableName);
    await fusion.getByLabel('Cabo de origem', { exact: true }).selectOption(cable.id);
    await fusion.getByLabel('Fibra de origem', { exact: true }).fill('1');
    await fusion.getByLabel('Buscar cabo de destino', { exact: true }).fill(branchName);
    await fusion.getByLabel('Cabo de destino', { exact: true }).selectOption(branch.id);
    await fusion.getByLabel('Fibra de destino', { exact: true }).fill(attempt === 'first' ? '1' : '2');
    await fusion.getByLabel('Perda medida (dB)', { exact: true }).fill('0,05');
    if (attempt === 'first') {
      const fused = responseOf('POST', /^\/api\/ftth\/boxes\/[^/]+\/fusions$/);
      await save('Registrar fusão');
      assert.equal((await fused).status(), 200);
      await page.getByRole('cell', { name: `${cableName} · fibra 1`, exact: true }).waitFor();
      await page.getByRole('cell', { name: `${branchName} · fibra 1`, exact: true }).waitFor();
    } else {
      await fusion.getByRole('button', { name: 'Salvar', exact: true }).click();
      await fusion.getByRole('alert').filter({ hasText: 'já está fundida' }).waitFor();
      await fusion.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await fusion.waitFor({ state: 'hidden' });
    }
  }
  console.log('Fusões: fibra a fibra na ficha da caixa; o Go recusa a mesma fibra duas vezes na caixa.');
  await page.getByRole('button', { name: `Remover fusão ${cableName} fibra 1`, exact: true }).click();
  const removed = responseOf('DELETE', /^\/api\/ftth\/fusions\/[^/]+$/);
  await confirm();
  assert.equal((await removed).status(), 200);
  await page.getByText('Nenhuma fusão registrada nesta caixa.', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForURL(url => !url.searchParams.has('caixa'));
  console.log('Fusões: remoção confirmada libera a fibra na caixa.');

  // Importação KML: prévia sem gravação, aplicação explícita e recusas.
  const importedBoxes = [`CTO KML ${token}`, `CEO KML ${token}`];
  const project = kml(`<Placemark><name>${importedBoxes[0]}</name><Point><coordinates>-42.9,-5.2,0</coordinates></Point></Placemark><Placemark><name>${importedBoxes[1]}</name><ExtendedData><Data name="tipo"><value>ceo</value></Data></ExtendedData><Point><coordinates>-42.9,-5.201</coordinates></Point></Placemark><Placemark><name>Cabo KML ${token}</name><LineString><coordinates>-42.9,-5.2 -42.9,-5.201</coordinates></LineString></Placemark><Placemark><name>Área</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-42.9,-5.2 -42.8,-5.2 -42.8,-5.3 -42.9,-5.2</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`);
  await page.getByRole('tab', { name: 'Importar KML', exact: true }).click();
  await page.getByLabel('POP de destino da importação', { exact: true }).selectOption(pop.id);
  await page.getByLabel('Fibras padrão dos cabos', { exact: true }).fill('24');
  await page.getByLabel('Arquivo KML do projeto', { exact: true }).setInputFiles({ name: 'projeto.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: project });
  const previewed = responseOf('POST', /^\/api\/ftth\/gis\/kml\/preview$/);
  await page.getByRole('button', { name: 'Gerar prévia da importação', exact: true }).click();
  const preview = await (await previewed).json();
  assert.equal(preview.valid, true);
  assert.equal(preview.cables[0].a_box_name, importedBoxes[0]);
  assert.equal(preview.cables[0].fiber_count, 24);
  await page.getByRole('table', { name: 'Caixas candidatas', exact: true }).getByText(importedBoxes[1], { exact: true }).waitFor();
  await page.getByRole('table', { name: 'Cabos candidatos', exact: true }).getByText(`Cabo KML ${token}`, { exact: true }).waitFor();
  const before = await request('/ftth/boxes', null, 'GET');
  assert.equal(before.some(item => importedBoxes.includes(item.name)), false, 'a prévia não grava caixas');
  console.log('KML: prévia lista caixas e cabos candidatos com pontas e ignora polígonos sem gravar.');
  await page.getByRole('button', { name: 'Aplicar importação', exact: true }).click();
  const applied = responseOf('POST', /^\/api\/ftth\/gis\/kml\/apply$/);
  await confirm();
  assert.equal((await applied).status(), 200);
  await page.getByRole('status').filter({ hasText: 'Importação concluída: 2 caixa(s) e 1 cabo(s) gravados.' }).first().waitFor();
  const after = await request('/ftth/boxes', null, 'GET');
  assert.equal(importedBoxes.every(name => after.some(item => item.name === name)), true);
  console.log('KML: aplicação explícita grava caixas e cabos do POP numa única operação.');
  await page.getByLabel('Arquivo KML do projeto', { exact: true }).setInputFiles({ name: 'projeto.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: project });
  await page.getByRole('button', { name: 'Gerar prévia da importação', exact: true }).click();
  await page.getByText('já existe caixa com este nome', { exact: false }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Aplicar importação', exact: true }).isDisabled(), true);
  await page.getByLabel('Arquivo KML do projeto', { exact: true }).setInputFiles({ name: 'externo.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from('<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&xxe;</name></Placemark></kml>') });
  await page.getByRole('button', { name: 'Gerar prévia da importação', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'DTD' }).first().waitFor();
  console.log('KML: reimportação mostra erro por item e bloqueia a aplicação; DTD/entidades externas são recusados.');

  // Mapa: camada de cabos ativos na área consultada.
  const mapCables = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/ftth/cables/map');
  await page.goto(`${base}/rede/mapa`);
  await page.getByRole('heading', { name: 'Sua rede, no mapa.', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Cabos ópticos', exact: true }).getAttribute('aria-pressed'), 'true');
  const layer = await (await mapCables).json();
  assert.ok(layer.items.some(item => item.id === cable.id && item.path.length === 2), 'cabo ativo na camada do mapa');
  console.log('Mapa: camada de cabos ópticos desenha os traçados ativos da área consultada.');

  // Arquivamento e isolamento entre provedores.
  await page.goto(`${base}/rede/ftth/fttx-cto?aba=cabos`);
  await page.getByLabel('Buscar cabos', { exact: true }).fill(cableName);
  await row(cableName).getByRole('button', { name: `Arquivar cabo ${cableName}`, exact: true }).click();
  const archived = responseOf('PATCH', /^\/api\/ftth\/cables\/[^/]+$/);
  await confirm();
  assert.equal((await archived).status(), 200);
  await page.getByLabel('Situação dos cabos', { exact: true }).selectOption('archived');
  await row(cableName).getByText('Arquivado', { exact: true }).waitFor();
  for (const id of [branch.id, ...(await request(`/ftth/cables?pop_id=${pop.id}&status=active`, null, 'GET')).items.map(item => item.id)])
    await request(`/ftth/cables/${id}`, { active: false }, 'PATCH');
  const beta = await browser.newContext();
  await beta.request.post(`${base}/api/auth/login`, { data: { email: 'admin@beta.demo', password: 'demo1234' } });
  assert.equal((await beta.request.get(`${base}/api/ftth/cables/${cable.id}`)).status(), 404);
  assert.equal((await beta.request.get(`${base}/api/ftth/cables/${cable.id}/otdr/${measurement.id}/file`)).status(), 404);
  await beta.close();
  assert.deepEqual(errors, []);
  console.log('Cabos: arquivamento preserva o histórico; outro provedor não lê cabo nem arquivo OTDR.');
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(-3500));
  throw error;
} finally { await context.close(); await browser.close(); }
