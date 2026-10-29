# B04 — contrato de implementação do núcleo de leitura

Este documento registra o contrato operacional B04-I1 da frente L1. Ele complementa `docs/B04-DESENHO-CORTE-LEITOR.md` e não substitui a matriz em `docs/B04-ACEITE-CORTE-LEITOR.json`. A entrega implementa o núcleo puro: consulta por ids, seleção, `Strip`, métrica e a prévia pura do GET due. Não instala ganchos nos leitores, não registra variante de produto e não abre allowlist.

O produto continua na sentença legada. Corte, centavos oficiais, escritores, schema, grants, SQLs legados e UI permanecem como estão. O histórico dos lotes 25 a 28 e o desenho aprovado não são reescritos.

## Superfície

O pacote `leitura` expõe:

- `BalanceReadSelection`, com `SQL string`, `Reader string` e `Shadow bool`.
- `Pick(reader, legacy string) (BalanceReadSelection, error)`.
- `Strip(selection BalanceReadSelection, rows []jsonx.Object) error`, que retira colunas `cmp_` das linhas quando a seleção é de variante.
- `RegisterBalanceReadMetrics(prometheus.Registerer) error`.
- `DueHTTP(ctx, tx, id) (map[string]any, error)`, exclusivo do GET. Nenhum handler chama esta função nesta entrega.

Funções internas:

- `registerBalanceVariant(reader, sql string)`, usada só pelo `init` dos futuros `variants_*.go`. Nesta entrega ninguém a chama no produto, e o mapa global permanece vazio.
- `dueBreakdownFromRow(jsonx.Object) map[string]any`, extração mecânica da mesma expressão que `DueBreakdown` já calcula depois de `gen.Due`. O HTTP em shadow usa essa função sobre a linha já lida. `DueBreakdown` em `auxiliares.go` permanece com a expressão original: esta frente não edita esse arquivo e não troca o ramo GET.
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

`DueBreakdown` continua executando `gen.Due` e a expressão original de multa, juros e residual. `finance.Manual` e `finance.Agreement` continuam chamando `DueBreakdown`. `queries/due.sql`, `gen/due.sql.go` e `auxiliares.go` não foram editados. O ramo GET continua em `DueBreakdown`; esta frente não o troca por `DueHTTP`. `dueBreakdownFromRow` repete essa expressão para o shadow calcular a prévia na linha da variante, sem segunda sentença e sem passar por `auxiliares.go`.

Em `off`, `DueHTTP` delega a `DueBreakdown`. Em `shadow` de teste, com política local que permite `invoice-due` e traz uma variante, há uma única `tx.Objects`, depois `Strip` e o mesmo cálculo puro. A prévia de multa e juros não entra na sombra e não é relida em outra sentença.

## Gates pendentes

Não houve execução real de PostgreSQL nem de `EXPLAIN ANALYZE` nesta entrega. Isso não é aceite.

Pendente, com papel não privilegiado `nexo_app` e fixtures não vazias:

- igualdade de nominal, encargos, desconto, recebido, status, residual, excesso e cobrável com `financial_balance_shadow` para faturas já visíveis e ids selecionados;
- `EXPLAIN ANALYZE` de uma fatura e de uma página mostrando filtragem anterior aos agregados e uso de `invoice_movements_invoice` e `payments_invoice`, sem forçar o planner e sem exigir índice num conjunto vazio.

O teste `TestBalanceReadQueryDatabaseGatePending` exige a constante `pending`. Um `t.Skip` não aprova esses dois itens. O resultado da amostra e os limites do plano serão anexados quando o gate rodar.
