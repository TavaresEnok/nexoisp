# Etapa 1 — navegação e alcance

Data: 18/10/2026. Execução sequencial autorizada pelo usuário, substituindo a exigência anterior de aprovação entre etapas.

## Análise e alterações

O resolvedor e o registro das views já existiam no consolidado recebido. Não foram substituídos. A inconsistência corrigida era o uso direto de `window` por hooks de filtros, fora do contrato de navegação.

- `platform/navigation/react.tsx`: contrato com `getSearch` e `replaceQuery`, sem acesso a navegador; leitura recente permite compor mudanças sucessivas antes do próximo render.
- `platform/navigation/next-provider.tsx`: histórico nativo fica exclusivamente no adaptador Next, preservando sincronização com os hooks do framework.
- `lib/use-query-state.ts` e `lib/use-network-filters.ts`: leitura e escrita pelo adaptador; preservam hash, parâmetros independentes, fallback de enums e updates funcionais.
- `components/contracts.tsx` e `components/workspace-provider.tsx`: ficha, abas e vínculos comerciais utilizam o mesmo contrato.
- `application/workspace-demand.ts`: centraliza demanda de workspace conforme resolvedor; catálogos técnicos não carregam dados de assinantes sem necessidade. Ficha explícita e solicitação de dados continuam atendidas.
- `tests/navigation-adapter.test.tsx` e `tests/workspace-demand.test.ts`: regressões sem globais de browser e cobertura de demanda por destino.

## Critérios e evidências

- Classificação e resolução dos **420 destinos** preservadas, incluindo barra final, aliases e entradas especiais. Evidências: `tests/navigation-route.test.ts`, `tests/navigation.test.ts`, `.v0/evolution/stage-1-navigation.log`.
- Nenhum destino duplicado. Permanecem 20 associações de consulta, 19 views distintas, 399 escopos pendentes e uma entrada especial; isto não significa 420 funcionalidades completas.
- Browser real: busca por Mariana, situação, reset composto, enum inválido, estado vazio, paginação, abertura de ficha, aba Histórico, reload de URL e fechamento por Escape.
- Foco dentro do diálogo e devolução ao botão de origem confirmados. Limpeza de busca por teclado confirmada; um `fill` vazio da ferramenta não disparou a mudança, portanto a evidência utilizada foi a digitação real e o controle de reset.
- Comparação desktop escuro 1342×805 da tabela no mesmo estado: **0 pixels diferentes de 1.080.310**, antes/depois. Não representa comparação de todas as telas.

## Limites

Nenhum escopo pendente foi promovido a funcionalidade. Nenhum componente foi apagado. O adaptador de Link continua Next, explicitamente documentado na avaliação de portabilidade. A existência de rotas ou imports não certifica todos os estados possíveis de uma tela.
