// Fumaça da aplicação oficial do v0. A cobertura da migração é explícita em
// docs/integracao-v0/MATRIZ_FUNCIONAL.md. Os cenários da interface anterior
// foram preservados em legacy-smoke.mjs como referência para as próximas etapas.
if (!process.env.BASE) throw new Error('Informe BASE explicitamente para o laboratório descartável antes de executar a fumaça operacional.');
import { begin, end } from './request-trace.mjs';
// Cada cenário grava em docs/integracao-v0/evidencias/rastreio/ as chamadas à API
// feitas pela interface em cada verificação (evidência por unidade da matriz).
// FROM retoma a fumaça a partir de um cenário; ONLY roda cenários avulsos, como
// os que exigem o ACS sintético (frontend-v0-cpe.mjs, frontend-v0-portal-wifi.mjs).
const scenarios = [
  'frontend-v0.mjs',
  'frontend-v0-session.mjs',
  'frontend-v0-commercial.mjs',
  'frontend-v0-finance.mjs',
  'frontend-v0-provider-refunds.mjs',
  'frontend-v0-crm.mjs',
  'frontend-v0-field.mjs',
  'frontend-v0-stock.mjs',
  'frontend-v0-network.mjs',
  'frontend-v0-network-sites.mjs',
  'frontend-v0-access.mjs',
  'frontend-v0-optical.mjs',
  'frontend-v0-maintenance.mjs',
  'frontend-v0-workspace.mjs',
  'frontend-v0-workspace-preferences.mjs',
  'frontend-v0-ftth.mjs',
  'frontend-v0-ipam.mjs',
  'frontend-v0-cgnat-legal.mjs',
  'frontend-v0-map.mjs',
  'frontend-v0-admin-team.mjs',
  'frontend-v0-quality.mjs',
  'frontend-v0-admin-reports.mjs',
  'frontend-v0-saas.mjs',
  'frontend-v0-portal.mjs',
  'frontend-v0-portal-branding.mjs',
  'frontend-v0-os-quotations.mjs',
  'frontend-v0-messages.mjs',
  'frontend-v0-integrations.mjs',
  'frontend-v0-financial-connections.mjs',
  'frontend-v0-import.mjs',
  'frontend-v0-finance-access.mjs',
  'frontend-v0-remediation.mjs',
  'frontend-v0-create-links.mjs',
  'frontend-v0-evolution.mjs'
];
const from = process.env.FROM ? scenarios.indexOf(process.env.FROM) : 0;
if (from < 0) throw new Error(`cenário desconhecido: ${process.env.FROM}`);
const selected = process.env.ONLY ? process.env.ONLY.split(',') : scenarios.slice(from);
for (const scenario of selected) {
  console.log(`>>> ${scenario}`);
  begin(scenario);
  try {
    await import(`./${scenario}`);
  } catch (error) {
    // Hosted logs need a source location, not response bodies, cookies or tokens.
    // Keep the failing scenario/exit code intact and never loosen assertions.
    for (const line of String(error?.stack ?? '').split('\n')) {
      const frame = line.match(/(?:file:\/\/)?\/e2e\/([a-zA-Z0-9_./-]+\.mjs):(\d+):\d+/);
      if (frame) console.error(`::error file=e2e/${frame[1]},line=${frame[2]},title=Fumaça operacional::${error?.constructor?.name ?? 'Error'} in ${scenario}`);
    }
    throw error;
  } finally {
    await end();
  }
}
