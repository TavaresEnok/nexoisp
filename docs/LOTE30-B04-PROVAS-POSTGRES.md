# Lote 30 — provas PostgreSQL da leitura B04, gate de composição

Este arquivo consolida os três artefatos de teste já integrados sobre a base do lote 29. Não ativa corte, não abre allowlist e não altera produto, schema, grant, escritor, SQL legado, SQL de sombra, `gen/`, UI, runner ou mapas anteriores.

HEAD lido: `9bb9e8d28d347781e4531d24883d88044b944758`. A base aprovada do lote 29 é `5ca3036cfbadddd395068671f2ed9a6900850856`, com as 13 tarefas DONE daquela base. Este gate não as refaz. O diff `5ca3036..HEAD` contém só três arquivos de teste, 2393 linhas acrescentadas:

- `apps/api-go/internal/modules/leitura/balance_read_pg_query_test.go`, frente da consulta dedicada, commit `27e22e8`
- `apps/api-go/internal/modules/leitura/balance_read_pg_variants_test.go`, oito variantes, commit `7e24aa8`
- `apps/api-go/internal/modules/leitura/balance_read_pg_due_test.go`, GET due, commit `c9e5d6a`

Não há `TestMain`, `init` de teste, `t.Parallel` nem limpeza de registros nesses arquivos. Os helpers usam os prefixos `pgQuery`, `pgVariants` e `pgDue`. Não há função repetida entre os três arquivos nem com o restante dos testes do pacote `leitura`. A conexão de execução é `db.Open` e `DB.WithScope`. Não há `pgxpool`, `database/sql` nem `pgx/stdlib`. A frente das variantes importa `github.com/jackc/pgx/v5/pgconn` só para recusar, antes de `db.Open`, uma URL cujo usuário não seja `nexo_go` ou cujo banco não seja `nexo_test`.

`productionShadowAllowlist` e `productionCutAllowlist` continuam mapas vazios. `balanceReadDatabaseGate` continua `pending`. Os testes `*DatabaseGatePending` e `TestBalanceReadGateDatabasePending` permanecem históricos: exigem a constante `pending` e não executam PostgreSQL. Um skip não os transforma em aprovação.

A prova nomeada `nativo25grupos` no commit `5ca3036` é histórica. Este HEAD muda a árvore com os três arquivos acima. Essa prova não cobre o lote 30. Este gate não rodou `python3 tests/contrato/nativo.py` nem `python3 tests/contrato/go_integration.py`.

## O que este gate executou

Ambiente desta worktree: `NEXO_GO_TEST_DATABASE_URL` ausente e `NEXO_BALANCE_READ_PG_REQUIRED` diferente de `1`. Compilação e teste local não são execução de banco nem de `EXPLAIN`.

| Prova deste gate | Comando | Resultado | O que fecha |
| --- | --- | --- | --- |
| Módulos Go | `go -C apps/api-go mod download` | exit 0 | dependências do módulo disponíveis |
| Suíte filtrada com race | `go -C apps/api-go test -count=1 -race -run '^TestBalanceRead\|^TestDue' ./internal/modules/leitura` | exit 0, 1,105 s | o pacote integrado compila e os testes em memória passam; seis provas SQL foram skip |
| Mesma suíte com `-v` | o comando acima mais `-v` | exit 0, 1,525 s | identifica cada skip; não executa SQL |
| Guarda sem banco | `NEXO_BALANCE_READ_PG_REQUIRED=1` no filtro `^TestBalanceReadPG(FixturesOracleAndRLS\|Explain\|Variants\|VariantsEmpty\|VariantsRLS\|Due)$` | exit 1, seis `FAIL` | URL ausente com a variável em `1` não vira skip e não aprova PostgreSQL |
| Build | `go -C apps/api-go build ./...` | exit 0 | o módulo integrado compila |
| PostgreSQL, RLS no banco e EXPLAIN | não executados | pendente | nenhuma linha de banco da matriz |
| CI hospedado e `nativo.py` | não executados | pendente | publicação |

O exit 0 da suíte filtrada convive com estes skips, cada um em 0,00 s:

| Teste | Efeito neste gate |
| --- | --- |
| `TestBalanceReadPGFixturesOracleAndRLS` | skip: URL ausente; não aprova SQL, RLS nem EXPLAIN |
| `TestBalanceReadPGExplain` | skip: a mesma mensagem |
| `TestBalanceReadPGVariants` | skip: não aprova PostgreSQL, EXPLAIN nem o corte |
| `TestBalanceReadPGVariantsEmpty` | skip: a mesma mensagem |
| `TestBalanceReadPGVariantsRLS` | skip: a mesma mensagem |
| `TestBalanceReadPGDue` | skip: não aprova PostgreSQL, RLS nem EXPLAIN do GET due |

`TestBalanceReadPGDedicatedSQLNotView` passou em memória. O próprio teste registra que a checagem de `gen.BalanceShadowCompare` não executa PostgreSQL nem EXPLAIN e não aprova o gate.

Com `NEXO_BALANCE_READ_PG_REQUIRED=1` e a URL ausente, os seis testes de SQL terminam em `FAIL`. A mensagem da consulta dedicada é `NEXO_GO_TEST_DATABASE_URL ausente com NEXO_BALANCE_READ_PG_REQUIRED=1; PostgreSQL, RLS e EXPLAIN não foram executados`. A das oito variantes é `NEXO_GO_TEST_DATABASE_URL ausente com NEXO_BALANCE_READ_PG_REQUIRED=1; a ausência não aprova PostgreSQL`. A do GET due reutiliza o texto longo de pendência e falha em vez de pular. Esse exit 1 é a guarda. Não é falha de SQL executado.

## Quem executa SQL

No pacote `leitura`, sob o filtro `^TestBalanceRead|^TestDue`, só os seis testes acima chamam `db.Open`. Todos os outros `TestBalanceRead*` e `TestDue*` deste pacote comparam política, registro, `Strip`, fórmula ou texto em memória. `TestBalanceReadGateExistingEvidence` só confirma que arquivos de contrato já existentes ainda contêm trechos nomeados. Não os executa.

| Superfície | Teste que envia SQL quando a URL existe | O que permanece em memória |
| --- | --- | --- |
| Consulta dedicada `gen.BalanceShadowCompare` | `TestBalanceReadPGFixturesOracleAndRLS`, `TestBalanceReadPGExplain` | `TestBalanceReadPGDedicatedSQLNotView` e `TestBalanceReadQueryDatabaseGatePending` |
| `invoice-detail` | `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty`, `TestBalanceReadPGVariantsRLS` | registro e gate histórico de sqlc |
| `contract-finance-list` | `TestBalanceReadPGVariants` | o mesmo gate histórico |
| `contract-finance-totals` | `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty` | gate histórico de inline |
| `reconciliation-invoices` | `TestBalanceReadPGVariants` | gate histórico de sqlc |
| `finance-summary` | `TestBalanceReadPGVariants` | gate histórico de sqlc |
| `invoice-list` | `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty` | gate histórico da lista |
| `today-overdue` | `TestBalanceReadPGVariants` | gate histórico de C2 |
| `termination-quote-get` | `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty` | gate histórico de C2 |
| `invoice-due` | `TestBalanceReadPGDue` | `TestDue*` e `TestBalanceReadDueVariant*` |

A frente das oito variantes exclui `invoice-due`. O GET due não compara as outras oito. A consulta dedicada não substitui nenhuma das nove sentenças de leitor. Allowlist vazia continua devolvendo a sentença legada em produção. Estes testes usam política local só dentro da transação da fixture.

## Comando de operação

Não há runner novo. O preparo do banco continua em `tests/contrato/go_integration.py`. Na raiz do repositório, sem `-I`:

```sh
python3 tests/contrato/go_integration.py
```

O script sobe um container descartável, cria o banco `nexo_test`, roda `nexo-db prepare` e `nexo-db seed-demo`, e exporta `NEXO_GO_TEST_DATABASE_URL` a partir de `DATABASE_URL_GO` do `go_env('nexo_test')`, usuário `nexo_go` e banco `nexo_test`. Também exporta `NEXO_GO_TEST_DATABASE_OWNER_URL`. Em seguida executa, em `apps/api-go`:

```sh
go test -count=1 -race -p 1 -json ./...
```

O runner não define `NEXO_BALANCE_READ_PG_REQUIRED`. Com a URL presente, os seis testes não entram no skip. URL presente e inválida também não entra no skip: `db.Open` ou a conferência de `current_database` / `current_user` falha. O erro dos testes redacta a URL e não deve ser copiado com senha para o registro.

Para uma corrida que precise falhar quando a URL não existir, a gerência acrescenta `NEXO_BALANCE_READ_PG_REQUIRED=1` ao ambiente desse `go test`. Este gate não edita `go_integration.py` para injetar a variável. Um `go test` filtrado fora do runner só conta como prova de banco se a URL for a do `nexo_test` com usuário `nexo_go` preparada por esse script, e se a saída mostrar `PASS` desses seis testes, sem `SKIP`.

`python3 -I tests/contrato/go_integration.py` não é o comando. O script importa `lib` ao lado dele. Este gate não repetiu essa invocação.

## Critério para a gerência registrar prova real

A prova vale só no commit candidato, com log identificável desse commit. Exit 0 sem URL, skip, revisão de código ou build não preenchem a linha. `balanceReadDatabaseGate` permanece `pending` mesmo depois de os testes passarem. Allowlists continuam vazias. Não há percentual.

Consulta dedicada, `TestBalanceReadPGFixturesOracleAndRLS` em `PASS` sem skip, na mesma transação e com rollback da fixture:

- antes de `set local role nexo_app`, `current_database` é `nexo_test`, `session_user` é `nexo_go` e `current_user` é `nexo_go`
- depois, `current_user` é `nexo_app` e `session_user` continua `nexo_go`
- `enable_seqscan` permanece `on`; o teste não muda o planner
- `gen.BalanceShadowCompare` não lê `financial_balance_shadow`; o oráculo é a view, na mesma transação, para os mesmos ids
- casos não vazios: `open`, `paid`, `reconciling`, `canceled`, `partial`, `excess` e `reversal`
- RLS: o titular e o POP da casa veem as faturas da fixture; tenant alheio, assinante alheio e POP alheio veem zero; o escopo próprio volta a vê-las
- drift injetado não faz parte deste arquivo; continua no contrato financeiro existente

EXPLAIN da consulta dedicada, `TestBalanceReadPGExplain` em `PASS` sem skip:

- volume sintético de 4096 faturas, pagamentos e movimentos, com pelo menos 16 páginas em `invoice_movements` e em `payments`
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` de uma fatura `paid` e de uma página, com `enable_seqscan=on`
- o plano precisa mostrar `invoice_movements_invoice` e `payments_invoice`, cada um com filtro correlacionado de `invoice_id` e `tenant_id`
- plano sem esses índices falha e o gate de EXPLAIN permanece pendente; o teste não desliga `enable_seqscan` para forçar índice

Oito variantes, `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty` e `TestBalanceReadPGVariantsRLS` em `PASS` sem skip:

- ids: `invoice-detail`, `contract-finance-list`, `contract-finance-totals`, `reconciliation-invoices`, `finance-summary`, `invoice-list`, `today-overdue`, `termination-quote-get`
- identidade conferida: `current_database=nexo_test`, `current_user=nexo_go`, `session_user=nexo_go`, `pg_has_role` membro de `nexo_app`, `app_tenant` igual ao escopo
- esta frente não executa `set local role nexo_app`; um `PASS` dela não é a mesma sessão `current_user=nexo_app` da consulta dedicada e do GET due
- cada leitor compara, na mesma transação, a sentença legada e a variante; a produção, com allowlist vazia, continua na sentença legada
- `Strip` tira `cmp_`; fixture com `requireMatch` exige `cmp_matches` verdadeiro
- estados da fixture: parcial, excesso, em dia, `reconciling`, `paid` e `canceled`; contrato vazio devolve zero nos totais e nenhuma linha no detalhe, na lista filtrada e na cotação
- RLS por `set_config`: outro POP, outro assinante e outro provedor não devolvem a fatura; o POP da fixture devolve uma linha; o escopo é desfeito
- `EXPLAIN (FORMAT TEXT)` de cada sentença precisa ser não vazio; esse EXPLAIN não prova `invoice_movements_invoice` nem `payments_invoice`
- o fuso da sessão não muda; a fixture faz rollback; registro global, allowlists e `balanceReadDatabaseGate` permanecem como estavam

GET due, `TestBalanceReadPGDue` em `PASS` sem skip:

- `current_database=nexo_test`, `session_user=nexo_go`; depois de `set local role nexo_app`, `current_user=nexo_app`, sem `rolsuper` e sem `rolbypassrls`
- uma sentença, `shadow/due.sql`, sem cair em `gen.Due`; o mapa servido é igual a `DueBreakdown` e não contém `cmp_`
- casos: `open`, arredondamento, parcial, `paid`, `reconciling` e `canceled`, com literais de multa, juros, desconto, saldo, encargos e prévia
- escopo de outro tenant não vê a fatura, responde 404, não serve `cmp_` e não incrementa a métrica de comparação
- `EXPLAIN (FORMAT TEXT)` com `enable_seqscan`, `enable_indexscan` e `enable_bitmapscan` em `on`, e texto contendo `invoices`; esse EXPLAIN não exige os dois índices da consulta dedicada
- a marca sintética some no rollback; allowlists e o gate histórico continuam vazios e `pending`

No JSON de `go_integration.py`, a ação desses seis testes precisa ser `pass`. `skip` de pacote sem teste não conta. `skip` de qualquer um desses seis não conta. Falha de SQL fica registrada com o erro do teste, sem ajuste de produto, de allowlist ou de teste antigo para mascará-la.

## Matriz

Colunas deste gate: código integrado, execução local sem banco, execução PostgreSQL neste HEAD, CI, publicado. A coluna `executado` de `docs/B04-ACEITE-CORTE-LEITOR.json` não foi editada.

| Id | Código | Local sem banco | PostgreSQL neste HEAD | CI | Publicado |
| --- | --- | --- | --- | --- | --- |
| Consulta dedicada | `gen.BalanceShadowCompare` desde a L1; teste em `27e22e8` | forma estática passou; oráculo e RLS em skip | não | não | não |
| EXPLAIN dos dois índices | teste em `27e22e8` | skip | não | não | não |
| Oito variantes | teste em `7e24aa8` | skip | não | não | não |
| GET due | teste em `c9e5d6a` | skip | não | não | não |
| `flag-fechada` | allowlists vazias, fora do diff deste lote | a suíte vê mapas vazios | não reabre | não | não |
| `explain-indices` | sentença dedicada presente | EXPLAIN não rodou | pendente no critério acima | não | não |
| `rls-tenant-portal-pop` | testes escritos nas três frentes | skip | pendente; `nativo25grupos` de `5ca3036` não transfere | não | não |
| `estado-open`, `estado-paid`, `estado-reconciling`, `estado-canceled`, parcial, excesso, estorno | cobertos na fixture da consulta dedicada e, em parte, nas variantes e no due | skip | pendente | não | não |
| acordo, refund, importação, compensação, drift injetado | continuam nos contratos já existentes | `TestBalanceReadGateExistingEvidence` só lê o texto | não reexecutados | não | não |
| Gates `*DatabaseGatePending` | constantes históricas | passaram exigindo `pending` | não os promovem | não | não |

Ids que continuam fora da allowlist de corte, pelo desenho já integrado no lote 29: `invoice-detail`, `contract-finance-list`, `reconciliation-invoices`, `finance-summary`, `invoice-list`, `contract-finance-totals`, `today-overdue`, `termination-quote-get` e `invoice-due`. Motivos já registrados: `::int`, fórmula diferente, texto ao assinante, CSV ou função compartilhada com escritor. Este lote não promove nenhum deles.

## Fora deste gate

Não houve alteração de `docs/B04-ACEITE-CORTE-LEITOR.json`, `docs/CONCLUSAO-INTEGRAL.md`, `docs/LOTE29-B04-BASE-SHADOW.md`, `main`, workflow ou publicação. O projeto permanece aberto. Lotes 25 a 29 e estas provas de PostgreSQL não estão publicados.
