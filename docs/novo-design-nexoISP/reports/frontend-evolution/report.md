# Relatório consolidado — evolução do frontend independente

Data: 18/10/2026. As etapas autorizadas foram executadas sequencialmente, sem solicitar novas aprovações. Este relatório complementa, não substitui, a Etapa 0 preservada.

## Documentos entregues

1. **Referência original e inventário inicial:** `.v0/stage-0-current/report.md` e arquivos dessa pasta.
2. **Análise crítica, plano incremental e critérios:** `.v0/evolution/plan.md`.
3. **Etapa 1 — navegação e alcance:** [stage-1.md](./stage-1.md).
4. **Etapa 2 — entidades, dados e serviços:** [stage-2.md](./stage-2.md).
5. **Etapa 3 — plataforma e composição:** [stage-3.md](./stage-3.md).
6. **Compatibilidade React 18 + Vite 6:** [compatibility.md](./compatibility.md).
7. **Etapa 4 — integridade, cobertura e limitações:** [stage-4.md](./stage-4.md).
8. **Logs, inventários, matriz e diferenças verificáveis:** `.v0/evolution/`.
9. **Novo relatório de fechamento do pedido original:** [closure.md](./closure.md), com matriz das nove prioridades, 17 jornadas adicionais, correção da legenda do catálogo e resultados desta continuação.

## 1. Origem e preservação

O projeto utilizado é o consolidado anexado pelo usuário, não um template novo. A Etapa 0 preservou o ZIP integral e verificou os 318 arquivos fornecidos; o histórico dessa importação permanece intacto. A referência adicional imediatamente anterior à evolução está em `.v0/evolution/before.zip`, com manifesto de 236 fontes em `before-manifest.json` e SHA-256 `5f680036e7e3083276a3f558281dc86d287047b05dbb185b74af3d19d30230f8`.

Nenhum arquivo-fonte da referência foi removido. CSS, tokens, assets, fontes, manifesto, lockfile, sementes e serviços originais foram preservados. `next-env.d.ts` foi regenerado pelo Next e é identificado separadamente das mudanças autorais. `changes.json` registra arquivos adicionados, modificados e ausentes; hashes e integridade estão em `integrity.json`.

Neon, autenticação, APIs, assistente e eve não foram removidos nem substituídos. O modo demo continua explícito/reversível. Não houve backend novo, integração externa, contrato de API futura, migração de framework, persistência em localStorage ou operações remotas fictícias.

## 2. Análise crítica e resultado por prioridade original

| Prioridade | Diagnóstico e resultado |
| --- | --- |
| 1. Roteamento e componentes não renderizados | Preservados resolvedor, registro de views, aliases e 420 destinos. Corrigida escrita de query fora do adaptador e centralizada demanda de dados. Análise de alcance identifica dois componentes sem consumidor nas entradas auditadas, mantidos sem exclusão. |
| 2. Visual separado de dados | Catálogo ganhou composição síncrona por props; entrada assíncrona permanece separada. Workspace aceita leitor/chave injetáveis; componentes visuais não selecionam nova API. |
| 3. Dados demo centralizados | Mantidas as duas fontes únicas recebidas: 82 registros públicos e 20 itens técnicos. Leitura e validação padronizadas, sem cópia divergente nem novo seed. |
| 4. Contratos TypeScript | Entidades e schemas canônicos em `domain`; fachadas de compatibilidade em `lib`. Dependência deixou de apontar do domínio para implementações legadas. |
| 5. Serviços substituíveis | Fábrica interna de leitura injetável, com validação, propagação de erro e testes de recuperação. Nenhum endpoint, autenticação ou formato HTTP futuro foi inventado. |
| 6. Menos acoplamento Next | Hooks de query dependem do contrato injetado e podem ser testados sem browser/Next. Histórico nativo permanece no adaptador. Link, entradas de rota e composição de servidor continuam específicos de Next, documentados. |
| 7. React 18 + Vite 6 | Avaliação entregue, sem migração. React Leaflet 5 exige React 19 e é bloqueio concreto. Novos adaptadores/entrada, fontes, tema, tipos e headers ainda seriam necessários. |
| 8. Integridade de telas e interações | Tipos, 134 testes, build, auditoria de 431 caminhos e smoke de 31 entradas, com interações detalhadas no relatório da etapa 4. Não há certificação de todas as combinações de estado de todas as telas. |
| 9. Incompletos, duplicações e arquitetura | 399 escopos continuam pendentes, não promovidos a operações reais. Nenhum grupo de fontes idênticas por hash no inventário. Famílias de UI sobrepostas têm consumidores distintos e não foram unificadas destrutivamente. |

## 3. Validação concluída

| Verificação | Resultado |
| --- | --- |
| Base inicial | TypeScript e 123 testes aprovados |
| Verificação final `pnpm verify` | **134/134 testes aprovados**, zero falhas, ignorados ou cancelados; TypeScript aprovado |
| `pnpm build` | **Aprovado**: compilação, tipos e geração concluídos |
| Instalação congelada | **Aprovada**, sem alterar manifesto ou lockfile |
| Auditoria de navegação pura | **420 destinos**, sem duplicação; aliases, barra final e classificação preservados |
| HTTP/SSR | **431 caminhos validados após rechecagem dos quatro casos pendentes**; resultados inicial e rechecagem preservados separadamente |
| Browser real | **31 entradas renderizadas**, sem requisições operacionais observadas nos caminhos monitorados; não equivale a 31 jornadas completas |
| Comparação visual desktop | Tabela de assinantes no mesmo estado: **0% de diferença** |
| Mobile | Painel e ficha inspecionados em 390×844 escuro; painel sem overflow horizontal global |
| Interações | Filtros/reset/vazio/paginação, ficha e abas/reload/foco, clipboard, tooltip, CSV e validação de CLI demonstrativa exercitados |
| Playwright local — nova tentativa | **Bloqueio resolvido**. 39 casos demo validados (37 na passagem inicial + 2 de clipboard na rechecagem após instalar fontes), 4 regressões compatíveis com demo aprovadas e 50 grupos cobrindo os **399 escopos** aprovados em Chromium local sobre o build de produção existente. Não equivale à execução integral da suíte do modo original. |
| Integração de banco | Não executada, por restrição de escopo |

O HTTP 500 inicial do catch-all era processo Next antigo referenciando outra instalação. Foi resolvido reiniciando o dev server com a instalação atual, sem alteração de versões. A primeira varredura HTTP também registrou compilação inicial lenta nas entradas do assistente; apenas esses casos foram rechecados. Not-found em streaming mantém HTTP 200 com sinal 404 e noindex conforme o Next, além do fallback visual validado.

## 4. Incompletos e limites remanescentes

- **399 escopos de navegação não são funcionalidades implementadas.** Na nova tentativa, todos passaram pela auditoria de navegador em 50 grupos: resposta HTTP bem-sucedida, título esperado, aviso explícito de pendência, link de evidências, ausência de formulários e de requisições operacionais monitoradas e erros de runtime. Isso certifica somente o comportamento das páginas de escopo; não entrega os recursos de negócio previstos. 420 destinos não significam produto completo.
- `components/agent-ui/badge.tsx` e `components/ai-elements/chain-of-thought.tsx` não têm alcance pelo grafo auditado. Foram mantidos para preservar a base e evitar perda indevida.
- `ui`/`agent-ui` possuem sobreposição semântica, não duplicação integral por hash; sua unificação requer trabalho específico de API, foco, estilo e consumidores.
- React 18/Vite 6 não foram instalados ou certificados. O frontend está mais preparado para substituição de plataforma, não independente de todos os adaptadores de framework.
- **Ressalva técnica superada na nova tentativa:** o ambiente é Amazon Linux 2023; bibliotecas nativas foram instaladas com `dnf`, não `apt-get`. Também foram instalados `fontconfig` e fontes de sistema: sem elas, o texto dos toasts tinha altura zero no Chromium local. Os testes não foram enfraquecidos nem a aplicação alterada para ocultar as falhas. O dev server terminou durante a primeira passagem; a validação concluída usou `pnpm start` com o build anteriormente aprovado. Logs `retry-*` em `.v0/evolution/` preservam as tentativas e a rechecagem.
- Autenticação, Neon e agente não foram testados funcionalmente nesta execução. Seus arquivos e dependências foram preservados.
- Falha/recuperação dos leitores foi testada em serviço, não como falha injetada de UI. Impressão nativa, todos os estados do mapa, todas as opções/ordenações de tabelas e todas as combinações de formulário não têm certificação integral.
- Tiles do mapa e fontes são dependências visuais externas preexistentes. Não se afirma execução offline; tiles foram bloqueados no smoke para não depender da rede de mapas.
- As capturas detalhadas ficam no browser remoto em `/tmp/agent-browser/`; não foram copiadas como se fossem arquivos locais do projeto. Logs dos comandos contêm os resultados observados.
- Este relatório não confirma publicação, commit ou push. Nenhuma implantação foi solicitada ou executada.

## 5. Recuperação e próximos limites de mudança

A base original integral permanece no ZIP e manifesto da Etapa 0. Para inspecionar ou recuperar o estado imediatamente anterior a esta evolução, conferir o SHA-256 de `before.zip`, extrair em diretório limpo e comparar com `before-manifest.json`; preservar primeiro qualquer mudança posterior. Não restaurar automaticamente sobre o workspace atual nem misturar o template anterior com o consolidado.

A evolução arquitetural autorizada foi concluída e validada nos limites declarados. Integração com backend, migração React/Vite, execução de serviços originais e implementação dos escopos pendentes continuam fora desta entrega.

## 6. Fechamento adicional do pedido original

Foi criado um **novo relatório separado**: [closure.md](./closure.md), com a matriz das nove prioridades, os arquivos adicionais e as ressalvas atualizadas. Nesta continuação, foi corrigida a legenda residual do catálogo que mencionava Neon no modo local e acrescentadas 17 jornadas E2E, sem alterar o visual, dados, dependências ou serviços originais.

Verificações atuais: **TypeScript + 134 testes locais aprovados; 56 casos demo aprovados (39 existentes + 17 novos); 50 grupos de escopos aprovados cobrindo os 399 escopos; nenhum arquivo da referência removido.** A bateria de navegador foi concluída por cobertura em **duas passagens**: o primeiro comando atingiu o limite após 56 casos e 20 grupos aprovados; os 30 grupos restantes passaram na retomada seletiva. O comando inicial mantém status `timed-out`, sem ser reclassificado como aprovado. Evidências `closure-*` em `.v0/evolution/`.

Esse fechamento atende à evolução arquitetural demonstrativa aprovada; não implementa os 399 recursos de negócio previstos nem certifica todas as combinações de estado. O documento de impressão e a mídia `print` agora têm validação de navegador; o diálogo nativo e a gravação real de PDF continuam sem automação. As limitações de backend, compatibilidade futura, mapa e falha injetada de fonte na UI estão explicitadas no novo relatório.
