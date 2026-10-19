# Fidelidade ao frontend v0

Registro de 19/10/2026. Complementa o [plano](PLANO.md) depois da auditoria independente da integração.

## O que mudou

A auditoria mostrou que as telas de maior destaque tinham sido reescritas em `features/*` com as classes do v0, em vez de reaproveitar os componentes originais. Também mostrou que a evidência visual comparava a demonstração com ela mesma. Esta etapa corrige isso com o mesmo padrão já usado em contratos, faturas, atendimento, OS e planos: o componente original do v0 passa a receber dados por props, e a demonstração e a operação o alimentam com fontes diferentes.

| Tela | Componente original agora usado pela operação | Fonte real |
|---|---|---|
| Lista de assinantes | `components/subscribers.tsx` (`SubscriberDirectoryView`): resumo, abas com contagem, ordenação, colunas, paginação | `/subscribers` com plano e mensalidade base dos contratos vigentes e ordenação no servidor |
| Ficha do assinante | `subscriber-sheet-parts.tsx` (extraído literalmente de `subscriber-sheet.tsx`), `SubscriberContractList`, `FinancialTotals`, `HistoryTimeline` | Ficha, contratos, estados de acesso, faturas por contrato, linha do tempo, contagem de atendimentos e OS |
| Painel inicial | `components/overview.tsx`: abas por área, métricas, painel de receita, pulso da rede, prioridades, atividades e agenda | `/dashboard`, `/today`, `/finance/summary`, `/finance/monthly`, `/network/health`, `/dashboard/panels`, `/tickets`, `/agenda` |
| Rede | `network-center.tsx` (tabela de equipamentos), `network-online.tsx` (conexões online), `optical-network.tsx` (`OpticalPage`), `core-network.tsx` (`CoreNetworkFrame`), `network-explorer.tsx` (`MapExplorerFrame`), `technical-ui.tsx` (`CodePreview`) | Equipamentos, sessões, caixas FTTH, ONUs, blocos IP, CGNAT, POPs, mapa e instruções de concentradores |

As abas do painel inicial aparecem conforme permissões e módulos. Indicadores sem medição real não são estimados: o pulso da rede mostra agentes com contato recente, operações e divergências, e informa que a disponibilidade de enlace não é medida pelo ERP.

## Exceções demonstrativas

Continuam exclusivos da demonstração, com motivo registrado em `apps/web/tests/v0-fidelity.test.ts`: assistente, simulador de provisionamento, catálogo de modelos e templates de ONU (o Go não possui esse cadastro), análise de evidência manual da ficha, catálogo técnico do cenário, relatórios agregados da amostra e os provedores do contrato `WorkspaceData`. `subscriber-sheet.tsx` orquestra as abas demonstrativas; suas peças visuais vivem em `subscriber-sheet-parts.tsx`, usado pela operação.

## Travas automáticas

`apps/web/tests/v0-fidelity.test.ts` falha quando:

- um componente de página do v0 não é alcançável pela aplicação operacional e não tem exceção justificada;
- uma exceção já está em uso (a lista só encolhe);
- um componente em `components/` importa módulos operacionais (`components/` só depende de `features/workspace` e `features/technical`, que fazem parte do v0);
- a aplicação operacional passa a carregar seeds, `WorkspaceData` ou provedores demonstrativos.

O teste de paridade percorre os 420 nós do catálogo com perfis de administrador, assinante e operador do SaaS.

## Ajustes de comportamento

- O shell recebe sessão, permissões e catálogo por `ShellProvider` (`components/shell-context.tsx`); o sino mostra as pendências reais do perfil.
- Paginação do v0 em todas as listas conectadas, com 8, 25 ou 50 linhas (`?linhas=`).
- Alterações de CPE e Wi-Fi distinguem "aplicado agora" de "enfileirado"; antes ambos apareciam como sucesso.
- Depois do login, a aplicação volta à página solicitada quando a conta pode acessá-la.
- A ficha de OS não exibe mais UUIDs completos; o aviso de ambiente demonstrativo não é repetido nas páginas.
- Leitura adicional no Go: `/api/subscribers` devolve `active_plan_names` e `active_base_cents` e aceita `order=desc`. Não há regra de negócio nova.

## Verificação

Os resultados desta etapa estão em [VALIDACAO.md](VALIDACAO.md#fidelidade-v0).
