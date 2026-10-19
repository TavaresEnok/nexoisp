# Etapa 2 — contratos internos, cenário e serviços

Data: 18/10/2026.

## Análise e alterações

A base já continha leitores demo, duas sementes e seletores. O barrel de domínio ainda apontava para implementações em `lib`, invertendo a direção pretendida. Esta etapa tornou canônicas as implementações, sem alterar os consumidores legados à força.

- `domain/workspace.ts`: entidades e dados agregados de leitura.
- `domain/commercial.ts`: contratos e regras comerciais existentes.
- `domain/technical-catalog.ts`: tipos, schemas e regras técnicas existentes.
- `domain/network-query.ts`: regras puras de consulta de rede existentes.
- `domain/workspace-schema.ts`: validação de leitura e envelopes.
- `domain/read-models.ts` e `domain/network-filters.ts`: passam a depender do domínio canônico.
- `lib/types.ts`, `lib/commercial.ts`, `lib/technical-catalog.ts`, `lib/network-query.ts` e `lib/workspace-schema.ts`: fachadas de compatibilidade reexportam os mesmos objetos, sem cópias de schema. Rótulos de seção permanecem em `lib/types.ts`.
- `application/readers.ts`: contratos internos referenciam o domínio.
- `application/read-services.ts`: fábrica de serviços de leitura injetáveis, valida retorno e propaga falha, sem endpoint hipotético ou fallback remoto.
- `data/demo/readers.ts`: composição dos serviços validados com as fontes demonstrativas existentes.

## Consistência e padronização

Preservados os **82 registros públicos** e **20 itens técnicos**. As duas sementes continuam com uma única origem física nos caminhos legados `lib/db`, para não romper scripts, serviços originais ou histórico. Não foi criado seed alternativo, banco, persistência local ou contrato HTTP futuro.

A validação agora rejeita tipo de registro desconhecido, identificador ausente/duplicado e divergência entre ID do envelope e payload. Permanecem os testes de vínculos, valores em reais, contratos de um titular, itens adicionais e integridade do cenário.

## Critérios e evidências

- TypeScript e suíte completa aprovados após a etapa: `.v0/evolution/stage-2-read-services.log`.
- `tests/read-services.test.ts`: injeção, validação, independência das leituras, falha de fonte, corrupção sem fallback, recuperação com fonte corrigida, envelopes inconsistentes e identidade dos exports legados.
- `tests/demo-readers.test.ts`, `tests/workspace-schema.test.ts` e `tests/demo-seed.test.ts`: cenário e compatibilidade preservados.
- Comparação de hashes com a referência: nenhuma alteração nas sementes, folhas CSS, assets, manifesto ou lockfile.

## Limites

Os serviços são contratos internos de leitura; não implementam integração, autenticação, autorização de backend nem operações reais. A simulação pura de regras já existente continua sendo demonstrativa e não foi convertida em operação remota.
