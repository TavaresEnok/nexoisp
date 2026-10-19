# Compatibilidade futura — React 18 + Vite 6

Data: 18/10/2026. **Avaliação, não migração nem certificação de execução.** Next 16.4.0, React/React DOM 19.2.4 e o lockfile foram mantidos. Não foi instalado Vite nem trocada qualquer dependência.

## O que já pode ser reaproveitado

- `domain/`: modelos de assinante/fatura/chamado/OS/nó/snapshot, contratos comerciais, schema de leitura, catálogo técnico e regras de rede sem React, Next, Node, banco ou navegador. `lib` reexporta as mesmas implementações para compatibilidade, sem duplicar schemas.
- `application/`: leitores internos, serviços de validação, seletores e política de demanda de dados. São contratos internos de leitura, não contratos de uma API externa.
- `data/demo/readers.ts`: usa exatamente as duas sementes preexistentes. Elas permanecem fisicamente em `lib/db/` para preservar scripts e consumidores originais, mas a seleção demonstrativa passa pelos leitores, sem conexão de banco.
- Hooks de URL dependem de `NavigationAdapter`, incluindo leitura atual e alteração composta de parâmetros. Podem ser exercitados por adaptador em memória sem globais de navegador ou Next.
- `WorkspaceDataProvider` recebe leitor e chave SWR; `WorkspaceProvider` também aceita injeção. `TechnicalCatalogView` recebe dados por props e é síncrono; sua entrada de servidor permanece separada.
- CSS Modules, JSON, imports dinâmicos, tokens CSS e Tailwind 4 são recursos suportados pelo ecossistema Vite; a ordem de importação e o pipeline PostCSS deverão ser preservados e testados.

## Bloqueios concretos e trabalho futuro

| Item | Evidência atual | Necessidade futura |
| --- | --- | --- |
| React Leaflet 5.0.0 | Peer dependencies exigem React e React DOM `^19.0.0` | Escolher versão comprovadamente compatível com React 18 e revalidar mapa, popup, camadas e foco. Não fazer downgrade isolado de React. |
| React DOM atual | 19.2.4 exige React `^19.2.4` | Trocar React, React DOM e seus tipos de forma coordenada, em outra etapa autorizada. |
| Entrada Next | `app`, layout, metadata, cookies, font loader, rotas/404 e `next/link` no adaptador | Implementar composição de entrada e roteador para Vite, com deep links, fallback de hospedagem, base path, navegação, scroll e query. Nenhuma entrada Vite foi criada aqui. |
| Catálogo técnico | `TechnicalWorkspace` continua sendo entrada assíncrona de servidor | Em SPA, utilizar a composição síncrona e leitor/SWR injetado; não importar a entrada de servidor. |
| Link | `platform/navigation/link.tsx` continua delegando ao Next | Adaptar renderização e semântica de anchors sem perder modificadores, target, download, foco ou comportamento de links externos. |
| Auth, APIs e agente | Serviços originais, Better Auth, banco e eve preservados no servidor | Não podem ser movidos para bundle estático. Definir separação de execução em uma migração futura, sem inventar integração agora. |
| Fontes e tema | Fontes Next/Google, cookie de aparência e inicialização no layout | Preservar métricas tipográficas, carregamento, tema sem flash e ausência de hydration mismatch na nova entrada. |
| APIs específicas de React | Nenhuma ocorrência de `useActionState`, `useOptimistic`, `useEffectEvent` ou `React.use(promise)` foi identificada nos módulos de produto auditados | Isso não certifica todas as dependências transitivas nem a semântica de refs; testar primitivas Base UI/Radix, foco e portais com React 18. |
| TypeScript | Configuração e tipos do Next continuam presentes | Criar configuração específica e `vite/client`, aliases `@/`, CSS Modules e JSON; manter `tsc --noEmit`, pois Vite transpila sem verificar tipos. |
| Ambientes e headers | Headers de segurança continuam em `next.config.mjs` | Reproduzir no host futuro; não converter em meta tags nem expor variáveis/credenciais de servidor no cliente. |

Os manifests instalados também declaram compatibilidade com React 18 para SWR 2.5.1, Recharts 3.10.1, Base UI 1.5.0, radix-ui 1.4.3, Motion 12.40.0 e Streamdown 2.5.0. Peer dependency permissiva não equivale a teste de funcionamento. O Next instalado aceita React `^18.2.0` em seu manifest, mas isso não resolve o bloqueio do React Leaflet nem prova compatibilidade integral do App Router atual.

## Critério para uma migração futura

Reutilizar o núcleo; criar adaptadores e entrada em mudança separada; alinhar dependências; repetir tipos, regras de negócio, navegação de todos os destinos, deep links/reload, ficha/foco, gráfico, mapa, exportação, clipboard e impressão. Comparar fontes/tokens/assets/CSS e capturas nos mesmos viewports. **Não há aprovação React 18/Vite 6 nesta execução.**

## Fontes consultadas

- Manifests efetivamente instalados: evidências em `.v0/evolution/compatibility-peers-corrected.log`.
- Vite 6: https://v6.vite.dev/guide/ e https://v6.vite.dev/guide/features.html#typescript . A documentação atual de vite.dev trata de Vite 8; não foi usada como se fosse Vite 6.
- React 19 e refs: https://react.dev/blog/2024/12/05/react-19 e https://react.dev/reference/react/forwardRef .
- React Leaflet: https://react-leaflet.js.org/docs/start-installation/ ; prevalece o peer dependency do pacote 5.0.0 instalado.
