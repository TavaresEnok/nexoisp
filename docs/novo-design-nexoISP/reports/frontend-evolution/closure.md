# Fechamento do pedido original — frontend demonstrativo independente

Data: 18/10/2026. Complemento aos relatórios das etapas 0–4, preservando as evidências históricas e as tentativas que falharam.

## 1. Escopo recuperado e decisão de conclusão

O pedido original é o anexo `[Pasted-31-lines]-AMtGH`, recuperado e relido nesta continuação. A aprovação posterior autorizou concluir as etapas sem novas paradas. O objetivo é evoluir a arquitetura e verificar a experiência **existente**, exclusivamente com dados demonstrativos, sem backend novo, integração externa, migração, redesign ou funcionalidades que simulem operações reais.

A resposta anterior misturou a conclusão da evolução arquitetural com a implementação dos 399 escopos e a validação funcional de Neon, autenticação e agente. Esses trabalhos **não são pré-requisitos desta entrega** e não foram executados. Os escopos devem permanecer identificados como incompletos; auditar sua navegação não equivale a implementar seu negócio.

## 2. Matriz de atendimento das nove prioridades

| Prioridade original | Entrega e critério verificável | Evidência principal |
| --- | --- | --- |
| Roteamento, navegação e componentes não renderizados | Resolução de 420 destinos, aliases e barra final; atualização de query pelo adaptador; alcance auditado sem excluir componentes | `stage-1.md`; testes `navigation-*.test.*` e `workspace-demand.test.ts` |
| Separação entre visual e acesso a dados | Catálogo síncrono por props, entrada assíncrona separada e leitor de workspace injetável | `stage-3.md`; `features/technical/catalog-view.tsx`; `evolution-boundaries.test.ts` |
| Dados demonstrativos centralizados | Duas sementes únicas preservadas; 82 registros públicos e 20 itens técnicos validados | `stage-2.md`; `demo-readers.test.ts`; `demo-seed.test.ts` |
| Contratos TypeScript consistentes | Modelos e schemas canônicos em `domain`, fachadas de compatibilidade em `lib`; tipos e invariantes testados | `stage-2.md`; `workspace-schema.test.ts`; `read-services.test.ts` |
| Serviços substituíveis | Contratos internos de leitura injetáveis, validação, propagação de falha e recuperação; sem inventar protocolo HTTP | `application/readers.ts`; `application/read-services.ts`; `read-services.test.ts` |
| Menor acoplamento ao Next | Hooks de query e contexto dependem do adaptador; histórico nativo isolado; limites de servidor e Link documentados | `stage-1.md`; `stage-3.md`; `navigation-adapter.test.tsx` |
| Avaliação React 18 + Vite 6, sem migração | Parecer entregue com bloqueio concreto de React Leaflet 5 / React 19 e adaptações futuras necessárias | `compatibility.md` |
| Integridade das páginas e interações existentes | Auditorias de rotas, testes locais e navegador; nesta continuação, 17 jornadas adicionais de formulários, mapa, agenda, impressão e relatórios | `stage-4.md`; `tests/e2e/demo-interactions.spec.ts`; seção 4 abaixo |
| Incompletos, duplicações e inconsistências | 399 escopos explicitamente pendentes; dois componentes sem alcance auditado preservados; sobreposição de famílias UI documentada, sem unificação destrutiva | `stage-3.md`; `report.md`; inventários `.v0/evolution/` |

Esta matriz registra entregáveis e evidências, não promete independência absoluta de framework nem cobertura combinatória de todos os estados possíveis.

## 3. Mudanças adicionais desta continuação

### Aplicação

- `components/onu-catalog.tsx`: corrigido o rodapé do catálogo que ainda dizia “no Neon” no modo demonstrativo local. O texto agora acompanha o modo selecionado; o texto do modo original permanece preservado.
- Nenhuma alteração em estilos, tokens, assets, fontes, sementes, dependências, lockfile, serviços originais, autenticação, agente ou configuração do modo de execução.

### Testes

Novo `tests/e2e/demo-interactions.spec.ts`, com **17 jornadas**:

1. Validação IPv4/CIDR, rascunho entre as cinco abas e cancelamento sem alterar URL.
2. Aplicação de POP, reload da URL e remoção do filtro.
3. Busca sem resultados, exportação desabilitada e limpeza na consulta online.
4. Falha de tiles, troca de camada, centralização e zoom do mapa sem depender do provedor externo.
5. Lista de instalações, busca vazia, fechamento e restauração.
6. Opções ANATEL/pontos de interesse desabilitadas e persistência de visibilidade offline.
7. Alternância quadro/agenda, todos os status, busca vazia, reset e reload.
8. Técnico selecionado em URL e abertura da ficha a partir da OS.
9. Documento real de impressão no iframe isolado, aviso demonstrativo, ausência da seção de observações internas, botão habilitado e mídia `print`.
10. Todas as categorias do histórico, dicionário de indicadores e download CSV.
11–15. Rejeição e recuperação de VLAN, Slot, PON, serial e login inválidos no CLI.
16. Template vazio por teclado, variável desconhecida, reload sem alterar o catálogo e regressão do rodapé local.
17. Identidade somente leitura e diálogo informativo de implantação.

As novas jornadas interceptam e abortam `/api` e `/eve/v1` caso sejam solicitados e falham se houver tentativa. Tiles Esri são abortados intencionalmente para testar degradação, não para certificar disponibilidade externa. Essa proteção pertence aos testes, não modifica a aplicação.

### Tentativas preservadas

- `closure-interactions-initial`: 16/17 aprovadas. O preenchimento vazio automatizado não produziu a edição esperada; o teste passou a exercitar seleção e Backspace, confirmando o valor vazio antes do envio.
- `closure-editor-recheck` e `closure-editor-current`: falhas do novo seletor, que procurava texto exato em um rodapé com outros textos no mesmo elemento. O seletor foi alinhado à estrutura real `.source-footer`, mantendo a exigência da legenda correta e da ausência da antiga.
- `closure-editor-final`: 1/1 aprovado, incluindo vazio, variável desconhecida, legenda e reload. Nenhuma asserção de negócio foi removida para ocultar falha.
- `agent-browser` confirmou a legenda corrigida no preview. A edição por teclado e a mensagem de template vazio também foram exercitadas no navegador.

## 4. Verificação consolidada desta continuação

- `pnpm verify`: **TypeScript e 134/134 testes locais aprovados**, inclusive após a alteração pontual. Evidências `closure-verify-final.{json,log}`.
- `git diff --check`: aprovado após a alteração da aplicação.
- Preservação: os 236 arquivos da referência anterior à evolução continuam presentes; 21 arquivos protegidos desta conferência (CSS, assets públicos, manifesto, lockfile, configuração de workspace e as duas sementes) mantêm os hashes originais. O SHA-256 de `before.zip` também confere. Evidência `closure-preservation.{json,log}`; o conjunto é o explicitamente selecionado nesse comando, distinto da auditoria histórica.
- Inventário `.v0/evolution/changes.json` atualizado, sem arquivos removidos.
- `closure-browser-final.{json,log}`: **56/56 casos das suítes demonstrativas aprovados** (39 existentes + 17 novos) e **20 grupos de escopos aprovados** antes do limite de 360 segundos. O comando global ficou **incompleto por timeout**, não foi reclassificado como sucesso.
- O timeout do wrapper deixou o executor filho ativo; a parada foi confirmada após `SIGINT`. A retomada `closure-scopes-remaining.{json,log}` selecionou somente os 30 grupos sem conclusão registrada no resultado inicial e terminou com **30/30 aprovados**, sem falhas, em 117,119 segundos.
- Resultado de cobertura final: **56 casos demo + 50 grupos de escopos aprovados em duas passagens**, cobrindo os 399 escopos. Não são 106 funcionalidades implementadas nem uma execução global única aprovada: o status do primeiro comando continua `timed-out`.
- Referências dos relatórios: **7 documentos e 8 links locais conferidos**, nenhum link ausente. Evidência `closure-report-links.{json,log}`.
- O build e a instalação congelada aprovados nas etapas anteriores permanecem como evidência histórica; **não foram repetidos nesta continuação**, que não altera build, dependências ou configuração.

## 5. Preservação e limites da conclusão

A referência original recuperável, o ZIP integral e os inventários continuam nos caminhos indicados em `report.md` e na Etapa 0. Não houve remoção de funcionalidades, conexão externa nova ou publicação.

A avaliação arquitetural e as melhorias incrementais estão entregues. O frontend continua Next.js; não foi migrado para React 18/Vite 6. Neon, autenticação e agente permanecem preservados, sem execução funcional nesta entrega. Os 399 escopos continuam pendentes de implementação, como já eram no consolidado.

A validação cobre os caminhos e as asserções enumerados, **não todas as combinações possíveis** de campos, tabelas, filtros e tamanhos de tela. A recuperação de fonte é testada nos serviços, não por injeção de falha de leitor na UI. O documento de impressão e a mídia de impressão foram verificados; o diálogo nativo do sistema e a gravação real de PDF não foram automatizados. A disponibilidade das camadas externas e todos os popups do mapa não são certificados. Não há afirmação de execução offline, backend de produção pronto, commit ou push confirmado.
