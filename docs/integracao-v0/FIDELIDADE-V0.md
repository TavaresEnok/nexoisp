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

## Revisão de detalhes (20/10/2026)

Comparação tela a tela, lado a lado, entre o v0 original e o ambiente conectado (28 telas) apontou diferenças de acabamento. Corrigido:

- Selo "Conectado ao ERP" removido de todas as páginas; o v0 não tem esse elemento e o banner do shell já identifica o ambiente demonstrativo.
- Textos visíveis sem jargão técnico ("Go", "backend" passam a "servidor").
- Telefone, CPF/CNPJ e códigos curtos formatados (`(85) 98888-7777`, `100.007.919-89`, `74E4E75E`); iniciais de avatar em maiúsculas.
- Ficha do assinante: cadastro com o bloco de endereço e os botões de copiar do v0, sem campos vazios; financeiro com a tabela "Títulos do contrato" do v0, sem cartões aninhados; atendimento com o cabeçalho, o resumo e as subabas de `subscriber-service`; conexão com o banner e o cabeçalho técnico do v0.
- Indicadores sem texto no lugar de número (planos e contratos usam valores reais).
- Faturas: empresa e exportação contábil no cabeçalho, como ações do v0.
- Atendimentos e OS com contagem em cada aba e menos abas; filtros "somente meus/minhas" como botões.
- Usuários com avatar, situação em selo e ações curtas.
- Rede com "De ponta a ponta" e "Sessões por concentrador" alimentados pelas sessões online reais; mapa com camadas e situação na barra do v0; endereçamento com indicadores antes das abas.
- Gráficos sem dados mostram estado vazio; painel inicial ganhou "Exportar resumo".

Validação: 163 testes locais, os 26 cenários da fumaça (dois segmentos; o primeiro revelou dois seletores antigos de teste, atualizados), referências operacionais regeneradas e conferidas sem atualização, e demonstração idêntica ao v0 original em 22 de 22 telas.


## Tela de entrada (20/10/2026)

A tela de login foi refeita com os tokens, fontes e temas do v0 (`features/session/login*.tsx`): palco à esquerda com cinco destaques de funcionalidades reais (acessos online, mapa, consulta legal de IP, ordens de serviço e cobrança), apresentados como exemplos ilustrativos com dados fictícios, com troca automática, pausa, abas com progresso e respeito a `prefers-reduced-motion`; formulário à direita com saudação pelo horário, campos com ícone, mostrar senha, etapa de código TOTP e erros no `Alert` do v0; troca de tema persistida pelo mesmo cookie do shell; contas de demonstração do servidor como atalhos apenas quando o servidor está em modo demo. No celular o palco é omitido. Não há "esqueci a senha" nem "manter conectado": o servidor não oferece essas operações, e a tela orienta procurar o administrador.

## Achados D2 a D11 da auditoria independente (20/10/2026)

| Achado | Situação | Onde |
|---|---|---|
| D2 · prova visual só da demonstração | Fechado. `e2e/frontend-v0-operational-visual.mjs` mede, em 21 telas com par no v0, a fração das classes da página original presentes na tela conectada (55% a 94%, piso em `e2e/visual-baselines/operacional/estrutura.json`), e compara pixel a pixel 44 capturas conectadas: 29 telas claras, tema escuro e celular de seis áreas e o portal. Relógio do navegador fixo, datas da API normalizadas e códigos de UUID mascarados; tolerância de 0,05% de pixels para antisserrilhamento. Conferido em dois ambientes recriados do zero. A captura no celular revelou rolagem horizontal em Faturas (ações do cabeçalho sem quebra), corrigida em `src/erp.css`. | [visual-operacional.json](evidencias/visual-operacional.json) |
| D3 · quatro listas manuais de rotas e permissões | Fechado. `features/operations/pages.ts` é a fonte única: `<Routes>`, permissões, módulos, títulos, aliases e situação de integração derivam dele, e um teste impede `<Route>` escrito à mão. A comparação com a lógica anterior em 291.840 combinações de perfil e caminho só diferiu em `/conta/*`, agora corretamente conectado. | `tests/legacy-route-parity.test.ts` |
| D4 · PATCH do NAS integrado e `/acs/status` | Fechado. "Editar concentrador" altera fabricante, IP de origem e CoA; o contrato sem roteador mostra o endereço público do ACS. RE-05 e RE-12 atualizados na matriz. | `features/network/radius.tsx`, `cpe.tsx` |
| D5 · evidência por cenário | Fechado. A fumaça grava, por verificação, as chamadas à API feitas pela interface (`evidencias/rastreio/`); `e2e/unit-evidence.mjs` cruza com os endpoints de cada unidade. As 149 unidades validadas têm verificação de interface própria, travado por teste. | [por-unidade.json](evidencias/por-unidade.json) |
| D6 · CSRF com cabeçalho fixo | Fechado. O Go exige em `X-Nexo-CSRF` um valor derivado do hash da sessão, entregue em `/api/me` e no login, comparado em tempo constante; o valor `1` é recusado. | `internal/auth/auth.go` |
| D7 · CSV cortado em 5.000 linhas sem aviso | Fechado. As cinco exportações avisam quando `X-Total-Count` passa do limite. | `features/shared/export.ts` |
| D8 · `z.coerce.number` em dinheiro | Fechado. Campos monetários usam `cents()`/`money()`: nulo ou ausente é erro, nunca R$ 0,00. | `features/shared/schema.ts` |
| D9 · `tests/` fora do `tsc` | Fechado. | `tsconfig.json` |
| D10 · `<a href>` interno | Fechado. Links internos usam o roteador; teste impede regressão. `/assistente` e `/acompanhamento` têm destino (página de recurso planejado). | `tests/audit-hardening.test.ts` |
| D11 · portal em um componente | Fechado. Seções em `features/portal/sections.tsx`; cada destino `/portal/<seção>` abre só a sua seção, com e2e por endereço. | `features/portal/home.tsx` |

O que a prova visual não cobre: igualdade pixel a pixel entre tela conectada e v0 (os dados diferem) e telas fora da lista. A igualdade com o v0 original continua comprovada para a demonstração.
