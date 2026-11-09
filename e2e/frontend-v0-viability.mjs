import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { csrf } from './csrf.mjs';

// Consulta pública de viabilidade: configuração no painel e página sem login.
// Caixa, coordenadas, nome e telefone são sintéticos; nenhuma caixa real é usada.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext();
const visitor = await browser.newContext();
const page = await context.newPage();
const publicPage = await visitor.newPage();
page.setDefaultTimeout(15000);
publicPage.setDefaultTimeout(15000);
const token = Date.now();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
publicPage.on('pageerror', error => errors.push(error.message));
const dialog = name => page.getByRole('dialog', { name, exact: true });
async function request(path, data, method = 'POST') {
  const response = await context.request.fetch(`${base}/api${path}`, { method, headers: await csrf(context, base), ...(data ? { data } : {}) });
  assert.equal(response.ok(), true, `${method} ${path}: ${await response.text()}`);
  return response.status() === 204 ? null : response.json();
}
// Ponto sintético no oceano, longe de caixas do cenário de demonstração.
const lat = -60 - (token % 1000) / 100000;
const lng = -20.5;
const near = { latitude: (lat + 0.0009).toFixed(6), longitude: lng.toFixed(6) };
const far = { latitude: (lat + 0.01).toFixed(6), longitude: lng.toFixed(6) };
const leadName = `Interessado viabilidade ${token}`;
let original = null;
let box = null;
async function consult(point) {
  await publicPage.getByLabel('Latitude', { exact: true }).fill(point.latitude);
  await publicPage.getByLabel('Longitude', { exact: true }).fill(point.longitude);
  await publicPage.getByRole('button', { name: 'Consultar viabilidade', exact: true }).click();
}
try {
  await page.goto(`${base}/login`);
  await page.getByLabel('E-mail', { exact: true }).fill('admin@alfa.demo');
  await page.getByLabel('Senha', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(url => url.pathname !== '/login');
  const me = await request('/me', null, 'GET');
  assert.ok(me.modules.includes('ftth') && me.modules.includes('crm'), 'cenário exige FTTH e CRM liberados para alfa');
  original = await request('/settings/viability', null, 'GET');
  box = await request('/ftth/boxes', { name: `CTO viabilidade ${token}`, kind: 'cto', ports: 8, latitude: Number(lat.toFixed(6)), longitude: lng });

  await page.goto(`${base}/configuracoes`);
  await page.getByRole('button', { name: 'Editar consulta de viabilidade', exact: true }).click();
  await dialog('Consulta de viabilidade').getByLabel('Publicar consulta de viabilidade', { exact: true }).selectOption('true');
  await dialog('Consulta de viabilidade').getByLabel('Raio de atendimento (metros)', { exact: true }).fill('250');
  await dialog('Consulta de viabilidade').getByLabel('Mensagem da página', { exact: true }).fill(`Consulta sintética ${token}`);
  await dialog('Consulta de viabilidade').getByLabel('Telefone de contato', { exact: true }).fill('(85) 4000-0000');
  await dialog('Consulta de viabilidade').getByLabel('WhatsApp com país e DDD', { exact: true }).fill('+55 85 99999-0000');
  await dialog('Consulta de viabilidade').getByLabel('Criar prospecto no CRM com resultado positivo', { exact: true }).selectOption('true');
  const saving = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/settings/viability');
  await dialog('Consulta de viabilidade').getByRole('button', { name: 'Salvar', exact: true }).click();
  assert.equal((await saving).status(), 200);
  await dialog('Consulta de viabilidade').waitFor({ state: 'hidden' });
  const saved = await request('/settings/viability', null, 'GET');
  assert.equal(saved.enabled, true);
  assert.equal(saved.radius_m, 250);
  assert.equal(saved.whatsapp, '5585999990000');
  assert.equal(saved.create_lead, true);
  const invalid = await context.request.put(`${base}/api/settings/viability`, { headers: await csrf(context, base), data: { enabled: true, radius_m: 20, message: null, phone: null, whatsapp: null, create_lead: true } });
  assert.equal(invalid.status(), 400);
  assert.equal((await request('/settings/viability', null, 'GET')).radius_m, 250);
  await page.getByText(`${base}${saved.public_path}`, { exact: true }).waitFor();
  console.log('Painel publica a consulta com raio de 250 m, mensagem, contatos e criação de prospecto; o Go recusa raio fora da faixa.');

  await publicPage.goto(`${base}${saved.public_path}`);
  await publicPage.getByRole('heading', { name: 'Verifique se atendemos o seu endereço.', exact: true }).waitFor();
  await publicPage.getByText(`Consulta sintética ${token}`, { exact: true }).waitFor();
  assert.equal((await visitor.cookies()).some(cookie => cookie.name === 'nexo_session'), false);
  const html = await publicPage.content();
  assert.equal(html.includes(box.id), false);
  await consult(far);
  await publicPage.getByText('Ainda não atendemos este local.', { exact: true }).waitFor();
  assert.equal(await publicPage.getByRole('button', { name: 'Enviar meus dados', exact: true }).count(), 0);
  await consult(near);
  await publicPage.getByText('Atendemos este local.', { exact: true }).waitFor();
  await publicPage.getByRole('link', { name: 'Falar no WhatsApp', exact: true }).waitFor();
  assert.equal(await publicPage.getByRole('link', { name: 'Falar no WhatsApp', exact: true }).getAttribute('href'), 'https://wa.me/5585999990000');
  await publicPage.getByLabel('Seu nome', { exact: true }).fill(leadName);
  await publicPage.getByLabel('Telefone com DDD', { exact: true }).fill('(85) 98888-7777');
  await publicPage.getByRole('button', { name: 'Enviar meus dados', exact: true }).click();
  await publicPage.getByText('Autorize o contato para enviar seus dados.', { exact: true }).waitFor();
  await publicPage.getByRole('checkbox').check();
  await publicPage.getByRole('button', { name: 'Enviar meus dados', exact: true }).click();
  await publicPage.getByText('Recebemos seu contato.', { exact: true }).waitFor();
  const found = await request(`/leads?q=${encodeURIComponent(leadName)}`, null, 'GET');
  const leads = Array.isArray(found) ? found : found.items;
  assert.equal(leads.length, 1);
  assert.equal(leads[0].source, 'viabilidade');
  assert.equal(leads[0].phone, '85988887777');
  assert.equal(leads[0].created_by, null);
  const unknown = await visitor.request.get(`${base}/public/viabilidade/inexistente-${token}`);
  const sameShape = await visitor.request.post(`${base}/public/viabilidade/inexistente-${token}/consulta`, { data: { latitude: Number(near.latitude), longitude: lng } });
  assert.equal(unknown.status(), 404);
  assert.equal(sameShape.status(), 404);
  assert.deepEqual(await sameShape.json(), await unknown.json());
  console.log('Página pública sem login responde fora/dentro do raio sem expor caixas e cria prospecto com origem viabilidade após consentimento.');

  await page.reload();
  await page.getByRole('button', { name: 'Editar consulta de viabilidade', exact: true }).click();
  await dialog('Consulta de viabilidade').getByLabel('Publicar consulta de viabilidade', { exact: true }).selectOption('false');
  await dialog('Consulta de viabilidade').getByRole('button', { name: 'Salvar', exact: true }).click();
  await dialog('Consulta de viabilidade').waitFor({ state: 'hidden' });
  await page.getByText('Página indisponível', { exact: true }).waitFor();
  await publicPage.goto(`${base}${saved.public_path}`);
  await publicPage.getByRole('heading', { name: 'Consulta indisponível', exact: true }).waitFor();
  const disabled = await visitor.request.get(`${base}/public/viabilidade/${saved.slug}`);
  assert.equal(disabled.status(), 404);
  assert.deepEqual(await disabled.json(), await (await visitor.request.get(`${base}/public/viabilidade/inexistente-${token}`)).json());
  await publicPage.setViewportSize({ width: 390, height: 844 });
  assert.ok(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log('Desativação no painel deixa a página pública indisponível com a mesma resposta de provedor inexistente.');
} finally {
  if (original) {
    await context.request.put(`${base}/api/settings/viability`, { headers: await csrf(context, base), data: { enabled: original.enabled, radius_m: original.radius_m, message: original.message, phone: original.phone, whatsapp: original.whatsapp, create_lead: original.create_lead } }).catch(() => {});
  }
  if (box) await context.request.delete(`${base}/api/ftth/boxes/${box.id}`, { headers: await csrf(context, base) }).catch(() => {});
  await visitor.close();
  await context.close();
  await browser.close();
}
