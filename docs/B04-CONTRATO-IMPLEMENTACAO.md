# B04 — contrato de implementação do núcleo de leitura

Este documento registra o contrato operacional B04-I1 da frente L1 e a composição já integrada nesta árvore: ganchos t3, variante da lista t5, agregados t7 e due t8. Ele complementa `docs/B04-DESENHO-CORTE-LEITOR.md` e não substitui a matriz em `docs/B04-ACEITE-CORTE-LEITOR.json`. A entrega L1 implementa o núcleo puro: consulta por ids, seleção, `Strip` e métrica. As allowlists compiladas de shadow e de cut continuam vazias. O gancho do GET due e a prévia pura estão em C3a (`due_http.go`, `due_calculation.go` e o ramo de `auxiliares.go`). As frentes t4 (sqlc) e t6 (totais) não estão neste HEAD; o ajuste de teste delas está no manifesto de recuperação e não foi aplicado nas worktrees paradas.

O produto continua na sentença legada. Corte, centavos oficiais, escritores, schema, grants, SQLs legados e UI permanecem como estão. O histórico dos lotes 25 a 28 e o desenho aprovado não são reescritos.

## Superfície

O pacote `leitura` expõe:

- `BalanceReadSelection`, com `SQL string`, `Reader string` e `Shadow bool`.
- `Pick(reader, legacy string) (BalanceReadSelection, error)`.
- `Strip(selection BalanceReadSelection, rows []jsonx.Object) error`, que retira colunas `cmp_` das linhas quando a seleção é de variante.
- `RegisterBalanceReadMetrics(prometheus.Registerer) error`.
- `DueHTTP(ctx, tx, id) (map[string]any, error)`, declarado uma vez em `due_http.go`. O GET `/api/invoices/{id}/due` em `auxiliares.go` chama essa função. Com as allowlists compiladas vazias, `DueHTTP` delega a `DueBreakdown`.

Funções internas:

- `registerBalanceVariant(reader, sql string)`, usada pelo `init` de `variants_dinamicas.go`, `variants_c2.go` e `variants_due.go` já integrados. Cada um grava só a própria chave e a própria sentença. O mapa global conserva esses registros durante a suíte. Allowlist vazia faz `Pick` devolver a sentença legada.
- `dueBreakdownFromRow(jsonx.Object) map[string]any`, declarado uma vez em `due_calculation.go`. É a expressão de multa, juros e residual que `DueBreakdown` aplica depois de `gen.Due`, por `dueBreakdownFromQuery`. O shadow de `dueServe` usa essa função sobre a linha já lida. `balance_read.go` não declara `DueHTTP`, `dueHTTPWith`, `dueMapFromShadowRows` nem `dueBreakdownFromRow`.
- `balanceRowsInTx(ctx, tx, reader, legacy, args...)` executa `Pick`, uma `tx.Objects` e `Strip` na mesma transação.
- `Service.balanceRows` abre o `WithScope` já usado por `Service.rows` e delega a `balanceRowsInTx`. `Service.rows` não muda.

A política de teste é um valor local com modo, allowlists e registro. Ela não lê ambiente, não lê HTTP e não grava nos mapas globais. `Pick` é o único caminho de produção: lê `NEXO_BALANCE_READ` e as allowlists compiladas.

## Modo e allowlists

`NEXO_BALANCE_READ` aceita `off`, `shadow` e `cut`. Vazio, ausente ou qualquer outro texto, inclusive maiúsculas e espaços, equivalem a `off`.

As allowlists compiladas de `shadow` e de `cut` são mapas vazios. Com allowlist vazia, os três modos devolvem a sentença legada. O ambiente não coloca um leitor na allowlist. `shadow` ou `cut` com o leitor já permitido e sem variante registrada devolve erro e não cai na sentença legada.

Ids fechados, os únicos que podem ser registrados ou rotulados:

- `invoice-detail`
- `contract-finance-list`
- `contract-finance-totals`
- `reconciliation-invoices`
- `finance-summary`
- `invoice-list`
- `today-overdue`
- `termination-quote-get`
- `invoice-due`

## Comparação

Cada variante futura devolve as colunas legadas intactas e, em linha não vazia, `cmp_matches` booleano. Os outros metadados usam o prefixo `cmp_` e `Strip` os remove. `cmp_matches` verdadeiro incrementa `match`. Falso incrementa `mismatch`, apaga só as chaves `cmp_` e conserva o corpo legado inteiro, sem recompor centavos. Projeção inválida, `cmp_matches` ausente ou de outro tipo, falha antes de alterar a linha. Seleção desligada que encontre qualquer chave `cmp_` falha e também não altera a linha.

## Consulta dedicada

`apps/api-go/internal/modules/leitura/queries/balance_shadow_compare.sql` parte de `invoices` com `id = any($1::uuid[])` e só então agrega, em duas laterais correlacionadas:

- `invoice_movements` filtrado por `tenant_id` e `invoice_id`, para nominal, encargos, desconto e último `status_after`.
- `payments` filtrado por `invoice_id` e `tenant_id`, somando `signed_cents`.

`financial_payment_allocations.allocated_cents` é `payments.signed_cents` da fatura visível. A soma filtrada alimenta `received_cents` e `legacy_received_cents`. Residual, excesso, cobrável e `matches` copiam a expressão da view da migração 66, inclusive o `is true`. Nominal, encargos, desconto e status ausentes continuam nulos: não há `coalesce` para zero nesses campos. A sentença não lê `financial_balance_shadow`.

Conjunto vazio de ids não produz linha e não exige uso de índice. O plano real não foi medido nesta entrega.

## sqlc

Versão: sqlc 1.31.1.

Binário usado, já pinado e fora do módulo, porque o `GOBIN` em `/tmp` não tinha espaço para um link novo:

```text
/home/enok/Documentos/projetos/implementacao-codex/lote-01-2026-10-25/lab/bin/sqlc
sqlc version
# v1.31.1
```

A geração usou a mesma engine, o mesmo `sql_package: pgx/v5`, `emit_exported_queries`, `emit_json_tags`, `emit_empty_slices` e os mesmos overrides de `apps/api-go/sqlc.yaml`. O arquivo de configuração ficou fora do repositório, com `queries` apontando só para `balance_shadow_compare.sql` e `out` num diretório de cache. O schema foi `db/migrations`. Comando:

```text
sqlc generate -f /home/enok/srv_projetos/runtime/isolated/grok/home/.cache/b04-sqlc-l1/sqlc.yaml
```

Desse diretório de saída entrou no repositório apenas `apps/api-go/internal/modules/leitura/gen/balance_shadow_compare.sql.go`. `db.go` e `models.go` regenerados no cache foram descartados. `go.mod` e `go.sum` não foram editados. O arquivo gerado não foi alterado à mão. O cabeçalho declara `sqlc v1.31.1` e `source: balance_shadow_compare.sql`.

O scanner gerado segue a inferência de nulidade do sqlc 1.31.1: as somas saem como `int64` mesmo quando o SQL devolve NULL. A fórmula executável é o texto SQL. O caminho desta frente, quando uma variante um dia chamar a sentença, materializa colunas por `tx.Objects`, que preserva NULL. Não se corrige o tipo gerado à mão.

## Métrica

`RegisterBalanceReadMetrics` registra `balance_read_compare_total` no `prometheus.NewRegistry` criado em `apps/api-go/cmd/api/main.go`, o mesmo registry servido em `/metrics`. Os únicos rótulos são `reader` e `result`, e `result` só recebe `match` ou `mismatch`. `reader` só recebe um id fechado. Não há rótulo de tenant, fatura, empresa, assinante ou centavos. Nenhuma outra rota de `main.go` muda.

## GET due

O caminho integrado, depois de C3a, fica assim:

- `registerAuxiliares` atende `GET /api/invoices/{id}/due` com permissão `finance:read` e chama `DueHTTP(ctx, tx, id)`.
- `DueHTTP` em `due_http.go` usa a política compilada `off` e allowlists vazias. Nesse modo executa `DueBreakdown` e a sentença é `gen.Due`. O corpo de `DueHTTP` tem uma chamada `tx.Objects` e uma chamada `DueBreakdown`.
- `DueBreakdown` em `auxiliares.go` executa uma `tx.Objects(ctx, gen.Due, id)` e devolve `dueBreakdownFromQuery`. A assinatura permanece `(ctx, tx, id) (map[string]any, error)`.
- `dueBreakdownFromRow` em `due_calculation.go` calcula multa com `math.Floor(amount*num(r.Get("fine_pct"))/100 + 0.5)`, juros com `math.Floor(amount*num(r.Get("int_pct"))/100*days/30 + 0.5)`, residual e `fee_if_applied_cents`. `finance.Manual` e `finance.Agreement` continuam chamando `DueBreakdown`, portanto `gen.Due`.
- `queries/due.sql` e `gen/due.sql.go` permanecem a sentença legada, sem coluna `cmp_`. C3a editou o ramo GET de `auxiliares.go`; esta correção de integração não edita esse arquivo.

`balance_read.go` conserva `Pick`, `Strip`, o registro de variantes, a seleção pura, `balanceRows`, a métrica e a consulta dedicada. As allowlists compiladas de shadow e de cut continuam vazias. Uma leitura due em `off` executa uma sentença. A resposta servida não contém `cmp_`.

Em `shadow` de teste, com política local que permite `invoice-due` e traz uma variante, o caminho due faz uma única consulta, retira `cmp_` e usa o mesmo `dueBreakdownFromRow`. A prévia de multa e juros não entra na sombra e não é relida em outra sentença. A frente t8 registrou `shadow/due.sql` em `variants_due.go`. As allowlists compiladas continuam vazias, então a produção segue em `gen.Due`.

## Gates pendentes

Não houve execução real de PostgreSQL nem de `EXPLAIN ANALYZE` nesta entrega. Isso não é aceite.

Pendente, com papel não privilegiado `nexo_app` e fixtures não vazias:

- igualdade de nominal, encargos, desconto, recebido, status, residual, excesso e cobrável com `financial_balance_shadow` para faturas já visíveis e ids selecionados;
- `EXPLAIN ANALYZE` de uma fatura e de uma página mostrando filtragem anterior aos agregados e uso de `invoice_movements_invoice` e `payments_invoice`, sem forçar o planner e sem exigir índice num conjunto vazio.

O teste `TestBalanceReadQueryDatabaseGatePending` exige a constante `pending`. Um `t.Skip` não aprova esses dois itens. O resultado da amostra e os limites do plano serão anexados quando o gate rodar.

## Composição dos testes

Nesta correção nenhum arquivo de produção, SQL, allowlist, escritor, grant ou migração muda. A lista de faturas continua passando `dynamicSQL("/api/invoices", 1, …)` para `balanceRowsInTx`. Com allowlists vazias, `Pick` devolve essa sentença legada, sem coluna `cmp_`. O gancho não é proibido e a chamada direta antiga `tx.Objects` não é exigida no teste da lista.

O registro de produto fica intacto. Não há `TestMain` por frente nem `init` de teste que apague, restaure ou troque `balanceVariants`. `TestBalanceReadRegisterVariant` copia o mapa antes das ações locais e da recusa de leitor inválido e exige que a cópia continue igual. Não exige mapa vazio, comprimento um nem ausência de chave de outra frente. Cada variante integrada exige a própria chave e o próprio SQL no mapa vivo.

PostgreSQL e `EXPLAIN ANALYZE` não foram executados nesta correção. Teste estático não aprova esses gates. O patch de t4 e o no-op de t6 estão em `docs/B04-T4-TEST-COMPAT.patch`, `docs/B04-T6-TEST-COMPAT.patch` e `docs/B04-RECUPERACAO-DEPENDENCIAS.json`. A gerência aplica o patch de t4 só depois da revisão, sobre o snapshot preservado, junto com o refresh da base comum deste commit.

## Atualização factual identificada em 2026-10-29

Os parágrafos anteriores ficam como registro da entrega L1. O que segue descreve este HEAD e a corrida `6963214927aa45ae1963c58d4c14ba540d78c2f0`, sem substituir esse registro.

Neste HEAD estão `variants_sqlc.go` e os SQL de `shadow/` da coorte C1-sqlc, além de `contract_finance_totals.go`, `variants_inline.go` e `shadow/contract_finance_totals.sql`. O primeiro parágrafo, que descrevia t4 e t6 ausentes, registra o texto daquela entrega. Os patches e `docs/B04-RECUPERACAO-DEPENDENCIAS.json` continuam no repositório.

`dueCompiledPolicy` em `due_http.go` continua devolvendo modo `off`, allowlists vazias e mapa de variantes vazio. `DueHTTP` chama `productionBalancePolicy()` de `balance_read.go`. Com `NEXO_BALANCE_READ` ausente, essa política fica em `off` e nas allowlists compiladas vazias, e a leitura due delega a `DueBreakdown`, que executa `gen.Due`. `Agreement` e `Manual` continuam em `DueBreakdown`. O dono de `Pick`, `Strip`, registro, métrica e allowlist continua `balance_read.go`. O dono de `dueBreakdownFromRow` continua `due_calculation.go`.

A constante `balanceReadDatabaseGate` permanece `pending`. Os testes que passaram em `6963214` recusam outro valor. A corrida `NEXO_BALANCE_READ_PG_REQUIRED=1 python3 tests/contrato/go_integration.py` terminou exit 0, com 370 ações `pass`, nenhuma falha e zero `skip` nos testes PostgreSQL novos. Sete testes SQL passaram: `TestBalanceReadPGDue`, `TestBalanceReadPGFixturesOracleAndRLS`, `TestBalanceReadPGExplain`, `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty`, `TestBalanceReadPGVariantsRLS` e `TestBalanceReadPGVariantsApp`. As 19 ações PostgreSQL `pass` incluem a checagem estática `TestBalanceReadPGDedicatedSQLNotView` e os subtestes em memória de `TestBalanceReadPGExplainVerifier`. O nativo terminou exit 0, com 25 grupos, entre eles os 22 casos B13. O pacote sanitizado está em `docs/evidencias/B04-GATES-6963214.json`. A matriz por critério está em `docs/B04-ACEITE-CORTE-LEITOR.json`.

Allowlists de shadow e de cut continuam vazias. Corte, homologação, `main` e deploy continuam fechados. A candidata `dev/lote31-b04-pg-validado-6963214` tem o CI `40877414874` ainda `in_progress` e com `conclusion` nula no snapshot da evidência. O job `agente` aparece `success` nesse snapshot. O job `verificar` segue em andamento, com a migração 65 para 66 ainda `pending`. Esse snapshot não conclui o CI.

### Recorte documental do gate G, lote 38

A decisão de candidatura no contrato executável exige amostra não vazia de booleanos verdadeiros no escopo observado; qualquer falso ou amostra inválida recusa a candidatura. Não é admissão final nem altera allowlists. Na redação do lote 38, a prova PostgreSQL nova e a revisão independente estavam pendentes. A execução posterior e seus limites constam em `docs/LOTE39-B04-PROVAS-CONSOLIDADAS.md`.
