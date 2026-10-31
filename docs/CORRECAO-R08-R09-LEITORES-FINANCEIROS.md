# R08/R09 — leitores financeiros

Escopo: resumo financeiro e série mensal, na worktree `task-dcc1ff749864-r08-r09-finance-readers`, sem commit, integração, escrita operacional, migração ou backfill.

## Contrato implementado

- `received_month_cents` e `received_cents` usam `bigint`/`int64` nas fontes SQL e nos DTOs sqlc. A soma mantém pagamentos e estornos assinados.
- O mês é o mês civil de `tenant_settings.timezone`, com fallback existente `America/Sao_Paulo`. O resumo usa `app_tenant()` e a série recebe o mesmo ajuste lido pelo handler. As duas consultas usam `[início local convertido em timestamptz, início do próximo mês convertido em timestamptz)`. O fuso da conexão não determina esses limites.
- O resumo preserva o filtro opcional `company_id` e o join com faturas. A série continua abrangendo todas as empresas do provedor. A comparação usa resumo sem filtro e pagamentos de faturas existentes.
- A variante shadow do resumo recebe somente a correção da projeção de caixa mensal. Não existe variante shadow `group3a79e37d_0.sql`. Fórmulas de saldo, autorização, RLS, gates B04 e allowlists não são promovidos nem alterados.

## Representabilidade

O contrato HTTP destes dois leitores permanece numérico, com inteiros no intervalo inclusivo `[-9007199254740991, 9007199254740991]` centavos. Fora desse intervalo, ou se a soma exceder `bigint` no PostgreSQL, a resposta é erro 422, código `finance_aggregate_out_of_range`, mensagem `agregado financeiro fora do intervalo de representação exata`, sem SQL, valores ou detalhes internos.

`db.Objects` converte `int64` para `float64` por convenção global. Estes leitores usam um adaptador local: PostgreSQL serializa as linhas em JSON textual, `UseNumber` decodifica os inteiros em `int64`, verifica o domínio e só então permite a serialização HTTP. A seleção B04 do resumo e `Strip` são preservados. Não há alteração global em `jsonx`, escritores ou nos outros endpoints.

O frontend valida os agregados como inteiros seguros e mantém os centavos recebidos. Os cartões usam divisão e resto inteiros com `BigInt` para formatar reais e centavos, evitando perder o último centavo ao dividir um número grande por 100. O gráfico conserva os componentes e a escala visual original em R$ mil; essa escala gráfica não é um valor financeiro para reutilização em cálculos. Meses com saldo negativo também exibem o gráfico. Nenhum layout ou CSS foi alterado.

## Testes focados

- `TestR08ExactJSON`: positivo/negativo acima de int32, limites inclusivos JS, roundtrip JSON exato, rejeição de números não inteiros e dos limites excedidos; contrato int64 dos DTOs em compilação.
- `TestR08RejectsEntireSeriesOutsideSafeRange`: um mês inválido rejeita toda a série, mesmo após um mês válido; o mapeador HTTP preserva 422 e corpo público sanitizado, sem série parcial ou valor ofensivo.
- `TestR08PostgresAggregates`: consultas geradas e variante shadow com soma acima de int32, estornos negativos, limites JS positivo/negativo, rejeição fora do domínio e overflow de bigint.
- `TestR09PostgresProviderMonth`: conexão UTC e Asia/Tokyo versus America/Fortaleza; 01:30 UTC do dia 1, começo exato, instante anterior ao fim, fim exato e futuro fora do mês; consistência resumo/série, filtro de empresa, fallback e projeções públicas equivalentes na variante shadow.
- As fixtures PG usam exclusivamente tabelas temporárias em `nexo_test`, conexão `nexo_go`, transação com rollback. O campo sintético `signed_cents` é bigint para alcançar limites sem milhões de inserções ou comandos financeiros reais. Não são uma nova homologação de RLS ou dos escritores.
- `PG_REQUIRED=1` (também aceita `NEXO_BALANCE_READ_PG_REQUIRED=1`) exige `NEXO_GO_TEST_DATABASE_URL`; ausência nesse gate falha. Fora do gate, ausência registra SKIP explícito. URL presente com banco/usuário incorretos ou erro SQL/conexão falha, nunca SKIP.

## Recibos da tentativa anterior preservada

Go disponível em `/usr/local/go/bin/go`, versão `go1.27.3 linux/amd64`. Para os comandos seguintes, foi acrescentado `/usr/local/go/bin` ao PATH. Builds usaram `GOTMPDIR=$PWD/.paseo-r08-r09-tmp` (raiz desta worktree), pois `/tmp` é tmpfs de somente 128 MB. O diretório temporário fica vazio ao término e é removido.

| Comando / evidência | Exit | Resultado e limites |
| --- | --- | --- |
| `go -C apps/api-go mod download` | 0 | Dependências disponíveis. |
| Em `apps/api-go`: `go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f sqlc.yaml`, inicialmente sem GOTMPDIR | 1 | Compilação do gerador excedeu o espaço de `/tmp`. Não foi falha das consultas. |
| Mesmo gerador com GOTMPDIR nesta worktree | 0 | Dois bindings regenerados: agregados int64, argumento de fuso mensal text/string explícito. Outputs incidentais `cadastro/gen/models.go` e `leitura/gen/models.go` foram retirados por patch; somente os dois outputs autorizados permanecem. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]' -count=1 -v` | 0 | `TestR08ExactJSON` PASS; `TestR08PostgresAggregates` e `TestR09PostgresProviderMonth` SKIP por ausência de URL. Não valida execução SQL/PG. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR08SQLOverflowSanitized$' -count=1` | 0 | PASS: mapeamento do SQLSTATE 22003 para erro público sanitizado; não substitui execução PG. Teste adicionado após a execução anterior. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestBalanceRead(Sqlc\|Gate)' -count=1` | 0 | Checks afetados de fonte/variante, seleção e gates B04 PASS. Sem suíte completa. |
| `PG_REQUIRED=1 go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]Postgres' -count=1` | 1, esperado | Os dois testes falham explicitamente pela URL ausente, sem SKIP. Prova do gate, não PASS de PostgreSQL. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestBalanceReadHooksScope$' -count=1` | 1 | Asserção estática em `balance_read_hooks_test.go:119` exige literalmente a chamada anterior `s.balanceRows`, incompatível com o adaptador exato. Arquivo fora da lista autorizada; não alterado. |
| `npm --prefix apps/web run typecheck` | NOT RUN | `/usr/bin/env: node: No such file or directory`. Sem mudança de engines, asserções ou instalação de serviço. |
| `git diff --check` | 0 | Sem erros de whitespace. |

## Retomada de 31/10/2026 nesta mesma worktree

Conferidos os arquivos já implementados pela tentativa anterior, sem reabrir R01–R05. Comandos Go usaram `PATH=/usr/local/go/bin:$PATH` e, quando necessário, `GOTMPDIR` no diretório temporário desta worktree. Não havia `NEXO_GO_TEST_DATABASE_URL` disponível; nenhuma credencial foi procurada.

| Comando | Exit | Resultado e limites |
| --- | --- | --- |
| `go -C apps/api-go mod download` | 0 | Dependências disponíveis. |
| Em `apps/api-go`: `go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1 generate -f sqlc.yaml` | 0 | Bindings regenerados. Os dois outputs financeiros permanecem; alterações incidentais em `cadastro/gen/models.go` e `leitura/gen/models.go` removidas por apply_patch. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]' -count=1 -v` | 0 | Dois testes unitários PASS; dois testes PG SKIP por URL ausente. Não é PASS de PG real. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR08RejectsEntireSeriesOutsideSafeRange$' -count=1 -v` | 0 | Novo teste PASS; executado isoladamente após sua inclusão. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestBalanceRead(Sqlc\|Gate\|HooksScope)' -count=1` | 1 | A única falha reportada foi `TestBalanceReadHooksScope`, linha 119. Nenhuma falha nos checks Sqlc/Gate; os avisos mismatch são fixtures desses checks. |
| `PG_REQUIRED=1 go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]Postgres' -count=1 -v` | 1 | Ambos falham pela URL ausente, zero SKIP. Confirma o gate, sem validar SQL em PG. |
| `npm -w apps/web run typecheck` | 127 | NOT RUN: executável Node ausente. Build e navegador também NOT RUN. |
| `git diff --check` | 0 | Sem erros de whitespace. |

## Pendência de escopo para o controlador

Foi solicitado ajuste pontual de duas asserções fora da lista de arquivos autorizados, sem resposta até o registro, novamente na retomada. `balance_read_hooks_test.go:118–122` deve verificar o novo adaptador, inclusive Pick/Strip e escopo autenticado, em vez de fixar o nome do helper antigo. `balance_read_pg_variants_test.go:959–962` ainda exige `received_month_cents` int32 na comparação por `tx.Objects`; com SQL bigint esse helper global fornece float64 (os novos leitores HTTP preservam int64). Essa asserção antiga precisa ser atualizada para o domínio novo sem diminuir a equivalência dos valores ou liberar B04. Não foi executada a suíte PG antiga sem URL e não se atribui PASS a ela.

O código delimitado está implementado, mas a entrega fica **blocked** pelo conflito real entre a regressão conhecida e os arquivos autorizados. PG real e validação Node também permanecem NOT RUN neste worker. A revisão independente continua pertencendo à próxima fase do controlador e não é o motivo do bloqueio.

## Nova tentativa delimitada de 31/10/2026

Preservada a implementação e os recibos anteriores de geração e Sqlc/Gate; esses checks verdes não foram repetidos. Confirmados somente os trechos relevantes e os dois contratos de teste incompatíveis, sem alterar arquivos fora do escopo. Node e URL PG continuam ausentes; nenhuma credencial foi procurada.

| Comando | Exit | Resultado e limites |
| --- | --- | --- |
| `/usr/local/go/bin/go -C apps/api-go mod download` | 0 | PASS. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]' -count=1 -v` | 1 | Binário em `/tmp` não pôde executar: permission denied. Nenhum teste executado nessa chamada. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestBalanceReadHooksScope$' -count=1` | 1 | Mesma restrição de execução em `/tmp`; substituído pela chamada combinada abaixo. |
| `PG_REQUIRED=1 go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]Postgres' -count=1 -v`, sem GOTMPDIR | 1 | Mesma restrição de execução em `/tmp`; nenhum teste executado. |
| `GOTMPDIR="$PWD/.paseo-r08-r09-tmp" PATH=/usr/local/go/bin:$PATH go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]\|^TestBalanceReadHooksScope$' -count=1 -v` | 1 | Três testes unitários R08 PASS, dois PG SKIP explícito por URL ausente; única falha: HooksScope linha 119 exige helper anterior. |
| `PG_REQUIRED=1 GOTMPDIR="$PWD/.paseo-r08-r09-tmp" PATH=/usr/local/go/bin:$PATH go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]Postgres' -count=1 -v` | 1 | Dois FAIL pela URL ausente, zero SKIP; PG real NOT RUN. |
| `git diff --check` | 0 | PASS. |

A pendência de escopo acima permanece: alterar a implementação para satisfazer literalmente o helper antigo ou o cast int32 reintroduziria o defeito de representação. Não se contornaram essas asserções. Nenhum código adicional foi necessário nesta tentativa; o bloqueio técnico conhecido foi confirmado e registrado para o controlador.

## Recuperação 4 — escopo de regressão autorizado em 31/10/2026

O controlador autorizou os dois arquivos de regressão antes bloqueados. Os registros anteriores permanecem históricos; o bloqueio de escopo foi resolvido nesta recuperação.

- `TestBalanceReadHooksScope` agora exige o adaptador exclusivo de `/api/finance/summary`, Pick com `balanceReaderFinanceSummary`, execução do SQL selecionado, Strip após sucesso e uma única chamada WithScope com `auth.From(ctx).Scope` integral (tenant, actor e POP). Mantém os guards dos outros leitores, ausência de escopo aninhado e proibição de redeclarar a superfície B04.
- A comparação PG usa `financeReadRows` para ambas as projeções exclusivamente do resumo financeiro, dentro da transação autenticada existente. Exige `received_month_cents` int64. Mantém valores esperados inteiros, comparação dos corpos e tipos, Strip, métricas, EXPLAIN e fixtures de isolamento/RLS. Os demais leitores continuam usando `tx.Objects`.
- Nenhuma fonte SQL, binding ou teste Sqlc/Gate foi alterado nesta recuperação. Valem os recibos anteriores de geração e checks afetados, sem repetição de testes verdes ou suíte completa.

Comandos abaixo executados na raiz desta worktree. Testes usaram `GOTMPDIR="$PWD/.paseo-r08-r09-tmp" PATH=/usr/local/go/bin:$PATH` para evitar execução em `/tmp`.

| Comando | Exit | Resultado e limites |
| --- | --- | --- |
| `/usr/local/go/bin/go -C apps/api-go mod download` | 0 | PASS. |
| `go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]\|^TestBalanceReadHooksScope$\|^TestBalanceReadPGVariants(Empty\|RLS\|App)?$' -count=1 -v` | 0 | HooksScope e três unitários R08 PASS. Dois PG R08/R09 e quatro PGVariants afetados SKIP explícito por URL ausente. Execução SQL, equivalência PG e RLS real NOT RUN. |
| `PG_REQUIRED=1 go -C apps/api-go test -race ./internal/modules/leitura -run '^TestR0[89]Postgres' -count=1 -v` | 1 | Dois FAIL por URL ausente, zero SKIP; prova de recusa do gate, não PASS de PG. |
| `command -v node` | 1 | Node ausente; typecheck/build frontend NOT RUN. |
| `git diff --check` | 0 | PASS após os ajustes e recibos. |

Fase de implementação **completed**, com revisão independente pendente no controlador, inclusive dos guards alterados. O marco PG físico continua para o host após revisão/integração; a falta da URL e de Node não é aprovação desses checks e não bloqueia este encaminhamento autorizado. Sem commit, push, merge, deploy ou acesso a produção/credenciais.
