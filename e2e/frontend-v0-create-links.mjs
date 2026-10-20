import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { csrf } from './csrf.mjs';

// Destinos "Novo …" do menu do v0 abrem o diálogo da página e respeitam a permissão de escrita.
const base = process.env.BASE ?? 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const contexts = [];
async function session(email) {
  const context = await browser.newContext({ viewport: { width: 1342, height: 805 } });
  contexts.push(context);
  const response = await context.request.post(`${base}/api/auth/login`, { data: { email, password: 'demo1234' }, headers: await csrf(context, base) });
  assert.equal(response.ok(), true, email);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return page;
}
const links = [
  '/assinantes/novo-assinante',
  '/planos/novo-plano',
  '/produtos-adicionais/cadastrar-produto',
  '/atendimentos/novo-atendimento',
  '/prospectos/novo-prospecto',
  '/ordens-de-servico/nova-os',
  '/estoque/novo-item',
  '/financeiro/faturas/gerar-mensalidades-por-competencia',
  '/rede/equipamentos/concentradores/novo-concentrador',
  '/rede/equipamentos/agentes-locais/novo-agente',
  '/rede/equipamentos/equipamentos-e-olts/novo-equipamento',
  '/rede/enderecos-ip/blocos-de-enderecos/novo-bloco',
  '/rede/enderecos-ip/planos-de-cgnat/novo-plano',
  '/rede/manutencoes/novo-aviso',
  '/administracao/usuarios/novo-usuario',
  '/administracao/empresas/nova-empresa',
];
try {
  const admin = await session('admin@alfa.demo');
  for (const link of links) {
    await admin.goto(`${base}${link}`);
    await admin.getByRole('dialog').first().waitFor();
    const url = new URL(admin.url());
    assert.equal(url.searchParams.has('novo'), false, link);
    assert.notEqual(url.pathname, link, link);
    await admin.keyboard.press('Escape');
    await admin.getByRole('dialog').first().waitFor({ state: 'hidden' });
    console.log(`Diálogo aberto por ${link} em ${url.pathname}`);
  }
  console.log('Ações "Novo …" do menu abrem o diálogo da página e removem o pedido da URL');
  const finance = await session('financeiro@alfa.demo');
  await finance.goto(`${base}/planos/novo-plano`);
  await finance.getByRole('heading', { name: 'Acesso não disponível', exact: true }).waitFor();
  await finance.goto(`${base}/planos?novo=plano`);
  await finance.getByRole('heading', { name: 'Planos & ofertas', exact: true }).first().waitFor();
  await finance.waitForTimeout(500);
  assert.equal(await finance.getByRole('dialog').count(), 0);
  assert.equal(new URL(finance.url()).searchParams.has('novo'), false);
  console.log('Conta sem escrita não acessa a ação pelo menu nem abre o diálogo pela URL');
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
