# Lote 29 — base de leitura em sombra, gate documental

Este arquivo é o gate G do contrato `B04-corte-leitura-v1`. Ele consolida o código já integrado nesta worktree, o contrato I1 e o ajuste operacional do GET due. Não ativa allowlist, não troca centavo servido e não altera produto, schema, grant, escritor, SQL legado nem UI.

HEAD lido: `ab6166a93059169155c660376a2de8a93311770b`. A worktree é de desenvolvimento. Este texto não publica, não aponta `main` e não declara deploy.

O desenho revisado continua em `docs/B04-DESENHO-CORTE-LEITOR.md`, commit `728f2ff`. A gerência registra revisão independente Sonnet desse desenho. Essa revisão não preenche a matriz, não executa PostgreSQL e não abre allowlist. A matriz permanece `docs/B04-ACEITE-CORTE-LEITOR.json`. O contrato operacional I1 está em `docs/B04-CONTRATO-IMPLEMENTACAO.md`. O manifesto da corretiva de composição, anterior à entrada de t4 e t6, está em `docs/B04-RECUPERACAO-DEPENDENCIAS.json`. Migração 66, `docs/LOTE03-B04-MOVIMENTOS.md` e os históricos do lote 24 permanecem intocados. Os IDs da matriz permanecem os mesmos.

## O que este gate fez

Documentou o alcance real e rodou a compilação do módulo Go integrado e a suíte do pacote `leitura`. Não rodou `nativo.py`, `financial_movements_migration.py` nem `EXPLAIN ANALYZE`. `balanceReadDatabaseGate` continua `pending`. Teste escrito e teste local sem banco não fecham linha da matriz. Prova anterior em outro commit não vira execução fresca do lote 29.

| Prova deste gate | Comando | Resultado | O que fecha |
| --- | --- | --- | --- |
| Compilação do módulo | `go build ./...` em `apps/api-go` | exit 0 | o conjunto integrado compila |
| Suíte local de leitura | `go test -count=1 ./internal/modules/leitura/` | exit 0, 0,031 s | política, registro, Strip e fórmula em memória |
| PostgreSQL e EXPLAIN | não executados | pendente | nenhuma linha da matriz |
| CI hospedado depois de t0 | não executado | pendente | publicação |

## Contrato I1

I1 é o núcleo puro da frente L1, mais a composição já presente neste HEAD: ganchos, variantes e o GET due. A superfície canônica:

| Símbolo | Dono | Quem consome |
| --- | --- | --- |
| `BalanceReadSelection`, `Pick`, `Strip`, `registerBalanceVariant`, `RegisterBalanceReadMetrics`, allowlists compiladas | `balance_read.go` | variantes e `dueHTTPWith` |
| `DueHTTP`, `dueHTTPWith` | `due_http.go` | o GET em `auxiliares.go` |
| `dueBreakdownFromRow`, `dueBreakdownFromQuery` | `due_calculation.go` | `DueBreakdown` e o ramo sombra de `dueHTTPWith` |
| `DueBreakdown` | `auxiliares.go` | Agreement, Manual e o ramo legado de `DueHTTP` |

`balance_read.go` não declara `DueHTTP`, `dueHTTPWith`, `dueMapFromShadowRows` nem `dueBreakdownFromRow`. Cada `variants_*.go` registra só a própria chave, no `init`, com `registerBalanceVariant`. Não há cópia de `Pick` ou `Strip` nas variantes.

`NEXO_BALANCE_READ` aceita `off`, `shadow` e `cut`. Vazio, ausente ou outro texto equivalem a `off`. `productionShadowAllowlist` e `productionCutAllowlist` devolvem mapas vazios. Com allowlist vazia, os três modos devolvem a sentença legada. Variante registrada e allowlist vazia são fatos distintos: o mapa `balanceVariants` pode conter as nove chaves e `Pick` ainda devolve o SQL legado.

Ids fechados: `invoice-detail`, `contract-finance-list`, `contract-finance-totals`, `reconciliation-invoices`, `finance-summary`, `invoice-list`, `today-overdue`, `termination-quote-get`, `invoice-due`.

## C3a — extração mecânica e uma sentença no HTTP

C3a não depende de L1. C3b depende de L1 e de C3a e não os aprova.

A fórmula saiu de dentro de `DueBreakdown` para `dueBreakdownFromRow`. Essa função não consulta. `DueBreakdown` executa uma vez `tx.Objects(ctx, gen.Due, id)` e passa o resultado a `dueBreakdownFromQuery`. Agreement e Manual continuam em `DueBreakdown`, portanto em `gen.Due`.

O ramo `GET /api/invoices/{id}/due` chama `DueHTTP`. `DueHTTP` chama `dueHTTPWith` com `productionBalancePolicy()`. Allowlist vazia torna a seleção legada: o callback legado chama `DueBreakdown` uma vez. A consulta da variante, no corpo de `DueHTTP`, não roda. Há uma sentença, `gen.Due`.

No shadow de teste, com política local que já permite `invoice-due` e traz variante, `dueHTTPWith` executa uma consulta, `Strip` retira `cmp_` e `dueBreakdownFromQuery` reutiliza `dueBreakdownFromRow`. A prévia de multa e juros não entra na sombra e não é relida. Sem variante, ou com projeção `cmp_` inválida, o caminho falha e não cai na sentença legada.

`queries/due.sql` e `gen/due.sql.go` continuam a sentença legada, sem coluna `cmp_`. `finance/sql/c59c1801_0.sql` continua inerte. A variante mora em `shadow/due.sql` e o registro em `variants_due.go`.

`duePick`, `dueServe`, `stripDueCompare` e `dueCompiledPolicy` permanecem em `due_http.go` e são exercidos por `due_http_test.go`. `DueHTTP` não os chama. `dueCompiledPolicy` também nasce com allowlists vazias e com mapa de variantes vazio. O comentário desse tipo ainda diz que a produção usa `dueCompiledPolicy`. O GET servido segue `DueHTTP` → `productionBalancePolicy`. As duas políticas de produção estão vazias. Este gate documental não edita esse arquivo.

## Donos e commits

Não há ciclo de aceite. C1 não aprova L1. G não aprova L1 nem C3a. A corretiva t1a tem revisão própria e não reabre o aceite da t1. t4 e t6 entram depois da corretiva de composição `99259d8`; o manifesto de recuperação descreve o estado anterior, em que essas worktrees ainda estavam paradas.

| Frente | Commit | Dono dos arquivos novos | Depende de | Aprova o antecessor |
| --- | --- | --- | --- | --- |
| t0 depguard | `92535ed` | testes de importação e `db/labtest` | nenhuma frente B04 | não |
| t2 C3a | `3ba6ea4` | `due_http.go`, `due_calculation.go`, ramo GET | nenhuma | não |
| t1 L1 núcleo | `2e71c2c` | `balance_read.go`, consulta dedicada, sqlc da consulta | nenhuma | não |
| t1a composição due | `ddf7e49` | integração do caminho único | t1 e t2 já revisadas | não |
| t3 ganchos | `383ac20` | pontos de `grupos.go`, `consultas.go`, `dinamicas.go`, `today.go` | L1 | não |
| t5 lista | `981c646` | `shadow/4a483e96_1.sql`, `variants_dinamicas.go` | L1 | não |
| t7 agregados | `e025e46` | `shadow/8d9dae54_3.sql`, `shadow/4facfb98_0.sql`, `variants_c2.go` | L1 | não |
| t8 due | `4acbbe3` | `shadow/due.sql`, `variants_due.go`, evolução de `due_http.go` | L1 e C3a | não |
| t5a testes | `99259d8` | composição dos testes comuns | ganchos e variantes então presentes | não |
| t4 sqlc | `d94a268` | quatro SQL em `shadow/`, `variants_sqlc.go` | L1 | não |
| t6 totais | `ebb9d88` | `shadow/contract_finance_totals.sql`, `variants_inline.go` | L1 | não |
| t9 testes de gate | `dadfead` | `balance_read_gate_test.go` | frentes de produto | não |
| G este texto | worktree `ab6166a` | os cinco documentos autorizados | leitura das anteriores | não |

A suíte não usa `TestMain`. Nenhum teste apaga `balanceVariants` para simular mapa vazio. `TestBalanceReadRegisterVariant` exige que a cópia do mapa vivo continue igual. Cada frente exige a própria chave. Falha compartilhada fica no dono do mapa, no core.

## Alcance real

Nove arquivos em `apps/api-go/internal/modules/leitura/shadow/`. Todos com `cut_permitido` falso.

| Id | Variante | Registro | Corte |
| --- | --- | --- | --- |
| `invoice-detail` | `shadow/group91a4cc44_0.sql` | `variants_sqlc.go` | fechado: `::int` e allowlist vazia |
| `contract-finance-list` | `shadow/groupc47037ac_0.sql` | `variants_sqlc.go` | fechado: `::int` e allowlist vazia |
| `reconciliation-invoices` | `shadow/group152f5ccd_0.sql` | `variants_sqlc.go` | fechado: `::int`; o índice 1 fica de fora |
| `finance-summary` | `shadow/readf038858e.sql` | `variants_sqlc.go` | fechado: `received_month_cents` não é saldo de fatura |
| `invoice-list` | `shadow/4a483e96_1.sql` | `variants_dinamicas.go` | fechado: `::int` e allowlist vazia |
| `contract-finance-totals` | `shadow/contract_finance_totals.sql` | `variants_inline.go` | fechado: filtro `open` e cobrável de `reconciling` |
| `today-overdue` | `shadow/8d9dae54_3.sql` | `variants_c2.go` | fechado: `::int` |
| `termination-quote-get` | `shadow/4facfb98_0.sql` | `variants_c2.go` | fechado: `::int` e multa de fidelidade |
| `invoice-due` | `shadow/due.sql` | `variants_due.go` | fechado: função compartilhada com escritor e prévia de juros |

Fora da coorte, e sem promoção neste gate: baixa, estorno, acordo, importação de título, cotação no encerramento, mensal, painéis, recibos, aging, a cancelar, CSV, portal, avisos, reconciliação de importação e linhas de pagamento. Não há endpoint novo. Não há leitor `::int`, prévia, escritor ou CSV na allowlist.

## Matriz por critério

Colunas: código no clone, teste local deste gate, CI hospedado, homologado, publicado. A coluna da matriz JSON `executado` continua falsa. DB e EXPLAIN continuam pendentes em todo id cujo gate é banco.

| Id | Código | Teste local deste gate | CI | Homologado | Publicado |
| --- | --- | --- | --- | --- | --- |
| L1 | presente desde `2e71c2c` e ganchos `383ac20` | suíte `leitura` exit 0; o teste do gate exige `pending` | não reexecutado | não | não |
| C1-sqlc | `d94a268` | a mesma suíte | não | não | não |
| C1-dinamicas | `981c646` | a mesma suíte | não | não | não |
| C1-inline | `ebb9d88` | a mesma suíte | não | não | não |
| C2 | `e025e46` | a mesma suíte | não | não | não |
| C3a | `3ba6ea4` e integração `ddf7e49` | a mesma suíte cobre delegação e uma sentença em memória | não | não | não |
| C3b | `4acbbe3` | a mesma suíte cobre a variante local | não | não | não |
| G | este documento | `json.tool` e `git diff --check` do gate documental | não | não | não |
| `estado-open` | cenário segue no nativo histórico | não executado aqui | não | não | não |
| `estado-paid` | idem | não | não | não | não |
| `estado-reconciling` | idem | não | não | não | não |
| `estado-canceled` | idem | não | não | não | não |
| `acordo-comprovado` | idem | não | não | não | não |
| `acordo-nao-comprovado` | migração 66 histórica | não | não | não | não |
| `estorno` | idem | não | não | não | não |
| `excesso` | idem | não | não | não | não |
| `refund-psp` | testes de refund já existentes | não reexecutados aqui | não | não | não |
| `importacao` | nativo ou migração | não reexecutados aqui | não | não | não |
| `compensacao` | testes B13 já existentes | não reexecutados aqui | não | não | não |
| `rollback` | nativo | não reexecutado aqui | não | não | não |
| `rls-tenant-portal-pop` | nativo | não reexecutado aqui | não | não | não |
| `drift-injetado` | nativo e migração 66 | não reexecutados aqui | não | não | não |
| `matches-falso-bloqueia-corte` | regra do gate G | sem amostra de banco | não | não | não |
| `sem-fallback-silencioso` | `Strip` coberto em memória | sem banco | não | não | não |
| `explain-indices` | sentença dedicada presente | EXPLAIN não rodou | não | não | não |
| `variante-shadow-isolada` | arquivos `shadow/` presentes | seleção local, sem banco | não | não | não |
| `flag-fechada` | allowlists vazias no código | a suíte vê mapas vazios e sentença legada | não | não | não |

## Provas por commit

Estas provas são anteriores. Nenhuma foi repetida neste gate. Nenhuma preenche `prova` da matriz.

| Commit | Relato | Uso |
| --- | --- | --- |
| `55e0d29` | `nativo.py` exit 0, 24 checks, incluindo B13 e financeiro | contrato HTTP daquela base; não é a matriz B04 e não é banco fresco do lote 29 |
| `55e0d29` | CI `40840682617` falhou no depguard de `database/sql` e `pgx/stdlib` nos testes financeiros | o run hospedado dessa base está vermelho |
| `92535ed` | t0 tira esses imports do alcance do depguard, via `internal/db/labtest` | a corretiva está no clone; o CI hospedado depois dela não foi executado |
| migração 65→66 | `financial_movements_migration.py` exit 0, relato anterior | não reexecutada aqui |
| `cc542a1` | Go, browser e SBOM local exit 0 | continuam datados nessa base |
| `0086558` | restore sintético exit 0 em 17 fases; HTTP daquela corrida exit 1 no `entity_id` opcional | o restore fica registrado; o HTTP daquela corrida não é o exit 0 posterior |
| `0086558` | 23 faturas, 23 sombras, 0 drift, 0 acordos, papel `nexo_go` | não cobre acordo, `source_unproven`, estorno, excesso, refund, importação, compensação, rollback, RLS de portal e POP nem drift injetado |
| `9c764d7` | expectativa do campo opcional | o relato de exit 0 está em `55e0d29`, que já contém esse commit |
| `728f2ff` | desenho e matriz, revisão Sonnet | plano; não é teste |

## Próxima fase

Incluir um leitor numa allowlist exige, antes, a matriz não vazia no PostgreSQL com papel `nexo_app`, `EXPLAIN` da consulta dedicada nos índices `invoice_movements_invoice` e `payments_invoice`, o CI hospedado verde no commit candidato depois de `92535ed`, e revisão independente dessa inclusão. Enquanto um id tiver `::int`, fórmula diferente, texto ao assinante, CSV ou função compartilhada com escritor, ele permanece fora da allowlist de corte.

O projeto global continua aberto. Não há percentual. Lotes 25 a 28 e esta base de sombra não estão publicados.
