import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const output = new URL('../docs/integracao-v0/evidencias/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const checks = [];
try {
 for (const variant of [
  { name: 'assinantes-desktop-claro', path: '/assinantes', width: 1342, height: 805, theme: 'light' },
  { name: 'assinantes-desktop-escuro', path: '/assinantes', width: 1342, height: 805, theme: 'dark' },
  { name: 'assinantes-celular', path: '/assinantes', width: 390, height: 844, theme: 'light' },
  { name: 'ficha-desktop', path: '/assinantes?ficha=sub-1', width: 1342, height: 805, theme: 'dark' },
  { name: 'rede-inventario', path: '/rede/equipamentos', heading: 'Monitoramento de rede', width: 1342, height: 805, theme: 'dark' },
  { name: 'rede-ficha', path: '/rede/equipamentos', heading: 'Monitoramento de rede', action: 'Detalhes de ', width: 1342, height: 805, theme: 'light' },
  { name: 'ordens-quadro', path: '/ordens-de-servico', heading: 'Ordens de serviço', width: 1342, height: 805, theme: 'light' },
  { name: 'ordem-ficha', path: '/ordens-de-servico', heading: 'Ordens de serviço', action: 'Ver OS ', width: 1342, height: 805, theme: 'dark' },
  { name: 'atendimentos-desktop', path: '/atendimentos', heading: 'Atendimentos', width: 1342, height: 805, theme: 'light' },
  { name: 'atendimento-ficha', path: '/atendimentos', heading: 'Atendimentos', action: 'Ver chamado ', width: 1342, height: 805, theme: 'dark' },
  { name: 'faturas-desktop', path: '/financeiro/faturas', heading: 'Faturas', width: 1342, height: 805, theme: 'light' },
  { name: 'fatura-detalhes', path: '/financeiro/faturas', heading: 'Faturas', action: 'Ver fatura ', width: 1342, height: 805, theme: 'dark' },
  { name: 'planos-desktop', path: '/planos', heading: 'Planos & ofertas', width: 1342, height: 805, theme: 'light' },
  { name: 'plano-configuracao', path: '/planos', heading: 'Planos & ofertas', action: 'Abrir configuração de', width: 1342, height: 805, theme: 'dark' },
  { name: 'contratos-desktop', path: '/contratos', heading: 'Contratos dos assinantes', width: 1342, height: 805, theme: 'light' },
  { name: 'contrato-ficha', path: '/contratos', heading: 'Contratos dos assinantes', action: 'Detalhes do contrato', width: 1342, height: 805, theme: 'dark' },
 ]) {
  const screenshots = [];
  for (const [name, base] of [['referencia', process.env.V0_REFERENCE ?? 'http://127.0.0.1:3001'], ['oficial', `${process.env.BASE ?? 'http://127.0.0.1:3000'}/demonstracao`]]) {
   const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, colorScheme: variant.theme, reducedMotion: 'reduce', timezoneId: 'America/Fortaleza' });
   const errors = []; const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
   await page.goto(`${base}${variant.path}`);
   if (variant.path.includes('ficha=')) await page.getByRole('dialog').waitFor();
   else await page.getByRole('heading', { name: variant.heading ?? 'Assinantes', exact: true }).waitFor();
   if (variant.action) await page.getByRole('button', { name: new RegExp(variant.action) }).first().click();
   await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(800);
   assert.deepEqual(errors, [], `${variant.name}: erros de execução em ${name}`);
   const bytes = await page.screenshot({ path: new URL(`${variant.name}-${name}.png`, output).pathname, animations: 'disabled', fullPage: false });
   screenshots.push(createHash('sha256').update(bytes).digest('hex'));
   await context.close();
  }
  checks.push({ name: variant.name, identical: screenshots[0] === screenshots[1], reference: screenshots[0], official: screenshots[1] });
 }
 await writeFile(new URL('comparacao-visual.json', output), JSON.stringify(checks, null, 2) + '\n');
 console.log(JSON.stringify(checks));
 assert.ok(checks.every(check => check.identical), 'A aplicação oficial difere da referência visual; examine as capturas.');
} finally { await browser.close(); }
