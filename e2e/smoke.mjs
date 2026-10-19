// Fumaça da aplicação oficial do v0. A cobertura da migração é explícita em
// docs/integracao-v0/MATRIZ_FUNCIONAL.md. Os cenários da interface anterior
// foram preservados em legacy-smoke.mjs como referência para as próximas etapas.
await import('./frontend-v0.mjs');
await import('./frontend-v0-session.mjs');
