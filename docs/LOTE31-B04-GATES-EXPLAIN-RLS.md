# Lote 31 — correção da prova EXPLAIN e do papel efetivo das oito variantes

Este lote registra a decisão da gerência e as duas correções de prova já integradas. Corrige o falso negativo do `EXPLAIN` observado na corrida real `7cde1e6` e acrescenta a prova das oito variantes sob o papel efetivo `nexo_app`. Produção permanece intocada: SQL de produção, sombra, legado e `gen/`, schema, índices, grants, escritores, UI, allowlists, registro global, métricas globais, configuração de banco e controlador ficam como estavam. Não há runner novo, percentual, ativação, push, `main` nem deploy.

Programação: Grok 4.7 médio. Revisão independente: Sonnet alto, com Sol médio somente quando a cota do revisor principal estiver indisponível. Custo adicional zero.

## Três tempos

| Tempo | O que é | Estado |
| --- | --- | --- |
| Corrida histórica | `python3 tests/contrato/go_integration.py` com `NEXO_BALANCE_READ_PG_REQUIRED=1` na base `7cde1e623462ec49c9fe75ca588e25c75a62dd5b` | exit 1; 356 ações `pass`; `TestBalanceReadPGExplain` em falha e o pacote `leitura` em falha; novos testes PostgreSQL com zero `skip` |
| Revisão e compilação deste gate | código lido em `996d28f49d2c49753d8f3ca741d4232c5ef2b08a`, worktree sem `NEXO_GO_TEST_DATABASE_URL` e sem `NEXO_BALANCE_READ_PG_REQUIRED` | `go test` filtrado exit 0 em 1,169 s e, na repetição, em 1,161 s; sete provas SQL em skip; verificador em memória passou; `EXPLAIN` real não rodou |
| Execução futura | a gerência, no HEAD integrado, com o runner existente e `NEXO_BALANCE_READ_PG_REQUIRED=1` | pendente; é a única corrida que pode preencher o gate |

A corrida `7cde1e6` permanece reprovada. O verificador em memória, o skip e a compilação não a reclassificam e não encerram a matriz.

## O que a corrida 7cde1e6 mostrou

Resumo: `/home/enok/Documentos/projetos/implementacao-codex/lote30-b04-provas-postgres-2026-10-29/evidencias/gate-summary-7cde1e6.json`. Log e planos: `gate-go-integration-7cde1e6.log`, `explain-failure-7cde1e6.txt`, `explain-paid-7cde1e6.json`, `explain-pagina-7cde1e6.json`.

Passaram, sem skip: `TestBalanceReadPGDue`, `TestBalanceReadPGDedicatedSQLNotView`, `TestBalanceReadPGFixturesOracleAndRLS`, `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty`, `TestBalanceReadPGVariantsRLS`.

`TestBalanceReadPGExplain` falhou porque o verificador daquela base exigia o nome `payments_invoice`. O plano natural, com `enable_seqscan=on` e `plan_cache_mode=force_custom_plan`, varreu por índice:

- `invoice_movements` alias `mv`, índice `invoice_movements_invoice`, `Index Cond ((tenant_id = i.tenant_id) AND (invoice_id = i.id))`
- `payments` alias `py`, índice `payments_tenant_invoice_identity_uq`, a mesma `Index Cond`

Na fatura `paid` `278a1e56-338f-4263-bae9-8ee2cdea7b22` cada scan teve uma linha e um loop. Na página de sete ids, cada scan teve uma linha e sete loops. O volume sintético estava acima de 4096 linhas e de 16 páginas `ctid` nas duas relações. Nenhum `Seq Scan` foi forçado e nenhum índice novo foi criado.

`payments_tenant_invoice_identity_uq` é a unicidade já instalada por `db/migrations/00074_provider_operations.sql`: `unique(tenant_id, invoice_id, id)` em `payments`. `invoice_movements_invoice` é o índice da migração 66 em `(tenant_id, invoice_id, id)`. `payments_invoice`, da migração 39, continua em `(invoice_id) include (signed_cents)`. A corrida escolheu a unicidade da migração 74 para a lateral, que busca `tenant_id` e `invoice_id` por igualdade. Essa escolha estrutural é o fato observado. O exit 1 da corrida continua o resultado oficial.

O plano 30 `8b78eab07512` está DONE 4/4. O plano 29 está DONE 13/13 na base `5ca3036cfbadddd395068671f2ed9a6900850856`. Os dois ficam preservados.

`TestBalanceReadPGVariantsApp` não existia em `7cde1e6`. O `pass` das três variantes naquela base vale para a sessão `current_user=nexo_go`.

## Duas raízes, arquivos disjuntos

O contrato técnico está fechado nesta decisão. Cada raiz já tem dono e arquivo próprio. Esta composição não espera outra entrega para descrevê-las.

| Raiz | Commit | Arquivo | Prefixo | O que a prova passa a exigir |
| --- | --- | --- | --- | --- |
| Equivalência do EXPLAIN | `e62ce32466124b047491b87f1db75f667259415a` | `apps/api-go/internal/modules/leitura/balance_read_pg_query_test.go` | `pgQuery` | acesso indexado correlacionado no mesmo nó, com catálogo que confirma a estrutura |
| Papel efetivo das oito variantes | `be70bd29f06cad6f100411c627aedc7d74c3584b` | `apps/api-go/internal/modules/leitura/balance_read_pg_variants_test.go` | `pgVariants` | repetir as oito sentenças com `set local role nexo_app`, conservando a bateria `nexo_go` |

`balance_read_pg_due_test.go` permanece a frente do GET due, prefixo `pgDue`, sem função compartilhada com as outras duas. Não há nome de função repetido entre os três arquivos. Não há `TestMain`, `init` de teste, `t.Parallel` nem limpeza de registro. Conexão de execução: `db.Open` e `DB.WithScope`. Conexões administrativas permanecem em `internal/db`.

O mesmo commit da equivalência também ajustou o texto de `explain-indices` em `docs/B04-ACEITE-CORTE-LEITOR.json` e o parágrafo correspondente em `docs/B04-DESENHO-CORTE-LEITOR.md`. Esses dois arquivos pertencem àquela raiz. Este gate de composição não os edita. O critério `explain-indices` continua com `executado` falso. A frase nova da matriz descreve a prova; não é a execução.

## Equivalência estrutural, gate indexado conservado

`TestBalanceReadPGExplain` continua a ser o gate de banco. Ele ainda exige `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` da consulta `gen.BalanceShadowCompare`, para uma fatura `paid` e para uma página, com volume mínimo de 4096 linhas e 16 páginas em `invoice_movements` e em `payments`, e com `enable_seqscan=on`. Ausência desses scans, plano em varredura ou `enable_seqscan` diferente de `on` deixa o gate pendente. A prova não desliga `enable_seqscan`, `enable_indexscan` nem `enable_bitmapscan`, não usa hint e não cria índice.

Para cada relação o mesmo nó de `Index Scan` precisa correlacionar `invoice_id` a `i.id` no `Index Cond` e `tenant_id` a `i.tenant_id` nesse nó. Se `tenant_id` é chave anterior a `invoice_id`, a correlação de tenant fica no `Index Cond`. Filtro de RLS, subplan ou condição repartida em nós diferentes não substitui essa correlação.

O nome do índice entra só com inspeção de catálogo (`pg_index`, `pg_class`, `pg_attribute`, `pg_get_indexdef`): índice válido, pronto, na relação do scan, chaves capazes de buscar `invoice_id` com prefixo só de `tenant_id`, predicado vazio ou satisfeito pelas igualdades da lateral, e `pg_get_indexdef` concordante com essas chaves. Nome isolado é recusado.

Os dois caminhos de pagamento continuam aceitáveis quando o catálogo fecha:

- `payments_invoice`, chave `invoice_id` e `signed_cents` em `INCLUDE`, com `tenant_id` no mesmo scan
- `payments_tenant_invoice_identity_uq`, chaves `tenant_id, invoice_id, id`, com as duas igualdades no `Index Cond`

`invoice_movements_invoice` permanece o índice exigido na relação de movimentos quando o catálogo o confirma. Predicado parcial insuficiente, índice inválido, índice sem prontidão, índice de outra relação e catálogo só com o nome continuam reprovando o plano.

`TestBalanceReadPGExplainVerifier` reaplica essa regra, em memória, aos JSON capturados da corrida `7cde1e6` e a planos sintéticos reprováveis. O `PASS` desse verificador, neste gate, mostra que a regra reconhece a estrutura observada e recusa os casos fracos. É revisão de código. É distinta de `TestBalanceReadPGExplain`, que neste gate ficou em skip e na corrida `7cde1e6` ficou em falha.

## Dois papéis nas oito variantes

Os ids continuam fechados: `invoice-detail`, `contract-finance-list`, `contract-finance-totals`, `reconciliation-invoices`, `finance-summary`, `invoice-list`, `today-overdue`, `termination-quote-get`. `invoice-due` continua só na frente `pgDue`.

`TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty` e `TestBalanceReadPGVariantsRLS` seguem em `pgVariantsRoleGo`. Antes de qualquer comparação, a sessão precisa ser `current_database=nexo_test`, `current_user=nexo_go`, `session_user=nexo_go`, membro de `nexo_app` e `app_tenant` igual ao escopo. Essa bateria não executa `set local role`. O controle `nexo_go` permanece.

`TestBalanceReadPGVariantsApp` usa `pgVariantsRoleApp`, conjunto fechado no código, sem nome vindo do ambiente. A mesma identidade `nexo_go` é conferida primeiro. Depois a transação executa `set local role nexo_app`. O papel efetivo precisa ser `current_user=nexo_app`, `session_user=nexo_go`, sem `rolsuper`, sem `rolbypassrls`, sem ser dono de `public.invoices`, e com `app_tenant` igual ao tenant da fixture. Sob esse papel o teste compara as oito sentenças, vê o provedor, o assinante titular e o POP da casa, recusa outro provedor, outro assinante e outro POP, restaura o escopo e confirma de novo o papel `nexo_app`. Allowlists e `balanceReadDatabaseGate` precisam continuar vazias e `pending`. A fixture faz rollback. O fuso da sessão não muda.

A URL de teste continua restrita ao usuário `nexo_go` e ao banco `nexo_test` antes de `db.Open`. URL ausente com `NEXO_BALANCE_READ_PG_REQUIRED=1` falha. URL presente e inválida falha. Skip só existe quando a URL está ausente e a variável é diferente de `1`. Esse skip é pendência.

## O que este gate compilou

Ambiente: `NEXO_GO_TEST_DATABASE_URL` ausente e `NEXO_BALANCE_READ_PG_REQUIRED` ausente. Worktree `/home/enok/srv_projetos/worktrees/08mu8zaz/task-1c9516f806d0-t3-b04-consolidar-gates`. Código das duas raízes no merge `996d28f49d2c49753d8f3ca741d4232c5ef2b08a`.

| Comando | Resultado neste gate | Leitura |
| --- | --- | --- |
| `go -C apps/api-go mod download` | exit 0 | dependências disponíveis |
| `go -C apps/api-go test -count=1 -race -run '^TestBalanceRead\|^TestDue' ./internal/modules/leitura` | exit 0, 1,169 s; repetição exit 0, 1,161 s | compilação e testes em memória; sete skips de SQL |
| `go -C apps/api-go build ./...` | exit 0 | o módulo compila; não abre PostgreSQL |

Skips, cada um em 0,00 s, todos pendência:

| Teste | Pendência |
| --- | --- |
| `TestBalanceReadPGFixturesOracleAndRLS` | oráculo, RLS e papel `nexo_app` da consulta dedicada |
| `TestBalanceReadPGExplain` | `EXPLAIN` real dos dois scans correlacionados |
| `TestBalanceReadPGVariants` | oito variantes em `nexo_go` |
| `TestBalanceReadPGVariantsEmpty` | vazio em `nexo_go` |
| `TestBalanceReadPGVariantsRLS` | RLS em `nexo_go` |
| `TestBalanceReadPGVariantsApp` | oito variantes, vazio visível e RLS sob `current_user=nexo_app` |
| `TestBalanceReadPGDue` | GET due sob `nexo_app` |

`TestBalanceReadPGDedicatedSQLNotView` passou em memória. `TestBalanceReadPGExplainVerifier` passou em memória, inclusive o plano capturado de `7cde1e6` e os casos que a regra recusa. `productionShadowAllowlist` e `productionCutAllowlist` continuam mapas vazios. `balanceReadDatabaseGate` continua `pending`.

## Comando da prova nova

Na raiz do repositório, sem `-I`, no HEAD integrado, a gerência executa:

```sh
NEXO_BALANCE_READ_PG_REQUIRED=1 python3 tests/contrato/go_integration.py
```

O script existente sobe o container descartável, cria `nexo_test`, roda `nexo-db prepare` e `nexo-db seed-demo`, e chama `go test -count=1 -race -p 1 -json ./...` em `apps/api-go` com `NEXO_GO_TEST_DATABASE_URL` do usuário `nexo_go`. `go_env` copia o ambiente do processo, então a variável chega a esse `go test` quando o binário `go` do host executa. Este lote não edita `tests/contrato/go_integration.py`.

Nessa corrida, a ação destes testes precisa ser `pass`, com zero `skip`: `TestBalanceReadPGFixturesOracleAndRLS`, `TestBalanceReadPGExplain`, `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty`, `TestBalanceReadPGVariantsRLS`, `TestBalanceReadPGVariantsApp` e `TestBalanceReadPGDue`. O exit do runner precisa ser 0. `TestBalanceReadPGExplainVerifier` pode passar em memória na mesma suíte; ele não substitui `TestBalanceReadPGExplain`. Falha de SQL permanece registrada. URL ausente com a variável em `1`, e URL inválida, falham. Skip de qualquer um dos sete não preenche o gate.

Allowlists continuam vazias mesmo com esse exit 0. `docs/B04-ACEITE-CORTE-LEITOR.json` só muda de `executado` quando a gerência tiver o log dessa corrida nova e a revisão independente da inclusão. Nenhum id entra em allowlist de `shadow` ou de `cut` por este lote. Os nove ids do desenho continuam fora: `invoice-detail`, `contract-finance-list`, `reconciliation-invoices`, `finance-summary`, `invoice-list`, `contract-finance-totals`, `today-overdue`, `termination-quote-get` e `invoice-due`.

## Matriz

| Id | Código da prova | Corrida `7cde1e6` | Compilação deste gate | Próxima corrida | Allowlist |
| --- | --- | --- | --- | --- | --- |
| Consulta dedicada, oráculo e RLS | `27e22e8`, reforço de papel já naquela base | `pass` | skip | a repetir no HEAD integrado | vazia |
| `EXPLAIN` indexado | regra nova em `e62ce32` | `fail` no verificador por nome | skip do teste real; verificador em memória `pass` | `TestBalanceReadPGExplain` sem skip | vazia |
| Oito variantes em `nexo_go` | `7e24aa8` | `pass` | skip | a repetir | vazia |
| Oito variantes em `nexo_app` | `be70bd2` | ausente nessa base | skip | `TestBalanceReadPGVariantsApp` sem skip | vazia |
| GET due | `c9e5d6a` | `pass` | skip | a repetir | vazia |
| `explain-indices` na matriz de aceite | texto ajustado em `e62ce32`; `executado` falso | falha histórica | texto, sem execução | pendente até o log novo | vazia |
| Corte | inalterado | fechado | fechado | fechado | vazia |

O projeto permanece aberto. Lotes 25 a 31 não estão publicados.
