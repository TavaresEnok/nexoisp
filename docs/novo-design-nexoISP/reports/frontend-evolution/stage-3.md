# Etapa 3 — plataforma, composição e compatibilidade

Data: 18/10/2026.

## Alterações

- `features/technical/catalog-view.tsx`: apresentação síncrona que recebe catálogo por props e escolhe os componentes visuais existentes.
- `components/technical-workspace.tsx`: mantém entrada assíncrona, seleção de fonte e tratamento de falha; delega apresentação à nova composição. Não houve redesign de catálogo.
- `components/workspace-provider.tsx`: aceita leitor e chave de cache injetáveis, preservando a composição padrão demonstrativa/original e SWR.
- `components/app-shell.tsx`, `components/network-center.tsx` e `components/management.tsx`: textos condicionais deixam de anunciar Neon conectado no modo demo. A redação original permanece no modo original.
- Complemento de fechamento: `components/onu-catalog.tsx` corrige a legenda residual do rodapé do catálogo para informar origem local no modo demo. O texto do modo original é preservado; regressão de navegador em `tests/e2e/demo-interactions.spec.ts`.
- `tests/evolution-boundaries.test.ts`: impede dependência de plataforma/fachadas no domínio, globais de navegador nos hooks, acesso a fonte na composição visual e duplicação física das sementes.

## Preservação

Neon, autenticação, rotas de API, assistente, eve e seus serviços originais continuam presentes. Nenhuma integração foi solicitada ou configurada; banco, login e agente não foram exercitados. O modo demo permanece explícito e reversível. Manifesto e lockfile não foram modificados.

## Compatibilidade futura

A avaliação completa está em [compatibility.md](./compatibility.md), baseada em código, manifests instalados e documentação oficial. **Não foi feita migração.**

Bloqueio concreto: React Leaflet 5 exige React/React DOM 19. A migração futura para React 18 precisa resolver essa dependência, alinhar tipos e runtime, e verificar primitivas, refs, portais e foco. Vite 6 exigirá entrada, roteador, Link, fontes, tema, configurações TypeScript/PostCSS e headers do host próprios. Componentes de servidor, autenticação e agente não podem ser importados indiscriminadamente numa SPA estática.

## Alcance, duplicação e pendências

O inventário estático conservador encontrou dois componentes sem caminho a partir das entradas auditadas: `components/agent-ui/badge.tsx` e `components/ai-elements/chain-of-thought.tsx`. Ambos foram preservados. Não foram encontrados grupos de arquivos-fonte idênticos por hash no inventário.

As famílias `ui` e `agent-ui` têm sobreposição de finalidade, mas consumidores e implementações diferentes; não foram consolidadas automaticamente. `NetworkOnline`, painéis do overview e playground possuem consumidores reais e não foram classificados como órfãos por ausência de rota direta.

## Validação

`.v0/evolution/stage-3-boundaries.log`: TypeScript e **134 testes aprovados**, sem falhas. A inspeção de alcance não prova renderização de cada estado; a validação de browser e as limitações estão no relatório final de integridade.
