# Lote 32 — aceite B04 por critério e desenho B15 offline

Este lote só atualiza o mapa. A base de código lida pelas duas raízes é `6963214927aa45ae1963c58d4c14ba540d78c2f0`. A raiz do aceite B04 está no commit `d37603f9d0d3fd91e0e96248bd61847f9cc7fe43`. A raiz do desenho B15 está no commit `6ca6d21731d5706b72cbccdc6939de213dbb9070`. O merge documental desta worktree é `2b80d7ee12e63dea869e00f144219bc401c24ff0`. Este arquivo não altera produto, schema, SQL, teste, allowlist, configuração de execução nem controlador. Não envia mensagem, não chama Meta nem PSP e não publica.

Programação e documentação: Grok 4.7 médio. Revisão independente: Sonnet alto, com Sol médio somente quando a cota do revisor principal estiver indisponível. Até 10 workers deste chat, dentro do controlador. Este executor não cria plano, agente nem submissão.

Planos preservados: 29 DONE na base `5ca3036cfbadddd395068671f2ed9a6900850856`, 13/13; 30 DONE `8b78eab07512`, 4/4; 31 DONE `6963214927aa45ae1963c58d4c14ba540d78c2f0`. A corrida `7cde1e623462ec49c9fe75ca588e25c75a62dd5b` continua exit 1, com `TestBalanceReadPGExplain` em falha. O run `40840682617` continua falha de depguard em `55e0d29`. Nenhum dos dois é reclassificado.

## Cinco camadas

| Camada | Fato deste lote |
| --- | --- |
| Código | Commit `6963214` no clone de desenvolvimento. Os commits `d37603f` e `6ca6d21` são documentação posterior. |
| Execução local | Go e nativo nomeados abaixo, com exit 0, na base `6963214`. |
| CI hospedado | Run `40877414874` na branch candidata. Conclusão registrada só pela leitura confirmada. |
| Publicação de candidata | Branch `dev/lote31-b04-pg-validado-6963214`. É branch de desenvolvimento. |
| Homologação | Aberta. Conta, equipamento, host físico, cópia externa, fiscal, extrato, WABA e produção seguem sem prova. |

`main`, deploy e homologação são outras camadas. O projeto permanece aberto. Não há percentual.

## Prova local 6963214

Fonte imutável: `/home/enok/Documentos/projetos/implementacao-codex/lote31-b04-gates-explain-rls-2026-10-29/evidencias`. Espelho sanitizado no clone: `docs/evidencias/B04-GATES-6963214.json`. O aceite por critério está em `docs/B04-ACEITE-CORTE-LEITOR.json`, objeto `registro_6963214`.

| Comando | Resultado | Fonte |
| --- | --- | --- |
| `NEXO_BALANCE_READ_PG_REQUIRED=1 python3 tests/contrato/go_integration.py` | exit 0, `required` 1, 370 ações `pass`, 0 falha. Carimbo do comando no espelho: `2026-10-29T12:55:58.487575+00:00`. `gate-go-summary-6963214.json` traz `recorded_at` `2026-10-29T12:52:51.344675+00:00` com os mesmos 370 e 0. | `docs/evidencias/B04-GATES-6963214.json` e `gate-go-summary-6963214.json` |
| `python3 tests/contrato/nativo.py` | exit 0, 25 grupos, `ok` verdadeiro, 22 casos B13 dentro do grupo de compensação | `nativo-6963214.json` e `gate-nativo-6963214.log` |

Novos PostgreSQL da leitura: 19 ações `pass` e `new_pg_skips` 0. As 19 incluem os testes SQL, o teste estático `TestBalanceReadPGDedicatedSQLNotView` e os subtestes de memória de `TestBalanceReadPGExplainVerifier`. SQL em `pass`, sem skip: `TestBalanceReadPGDue`, `TestBalanceReadPGFixturesOracleAndRLS`, `TestBalanceReadPGExplain`, `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty`, `TestBalanceReadPGVariantsRLS`, `TestBalanceReadPGVariantsApp`. A lista `all_skips` do resumo Go aponta pacotes sem caso (`test` nulo). Isso é outro fato. O zero que conta para esta prova é `new_pg_skips`.

O verificador em memória passa e não substitui `TestBalanceReadPGExplain`. Esse teste SQL passou na corrida, com `enable_seqscan=on`, volume acima de 4096 linhas e 16 páginas, índices `invoice_movements_invoice` e `payments_tenant_invoice_identity_uq`, e catálogo conferido. A falha antiga do nome `payments_invoice` em `7cde1e6` permanece falha histórica.

## Aceite B04 por critério

Treze critérios ficam `executado` verdadeiro, cada um com commit, comando e fonte no aceite: `estado-open`, `estado-paid`, `estado-reconciling`, `estado-canceled`, `acordo-comprovado`, `refund-psp`, `compensacao`, `rollback`, `rls-tenant-portal-pop`, `drift-injetado`, `explain-indices`, `variante-shadow-isolada`, `flag-fechada`.

Seis critérios ficam abertos: `acordo-nao-comprovado`, `estorno`, `excesso`, `importacao`, `matches-falso-bloqueia-corte`, `sem-fallback-silencioso`. Trecho numérico visto no log não fecha prova mínima. O PASS antigo do plano 29 não é a corrida `6963214`. `financial_movements_migration.py` não faz parte dessa corrida local.

Flags compiladas: `allowlist_shadow` vazia, `allowlist_cut` vazia. A constante `balanceReadDatabaseGate` permanece `pending`. `corte_autorizado` permanece falso. `flag-fechada` mostra que `off`, `shadow` e `cut` devolvem a sentença legada. O gate de inclusão é outro critério: `matches-falso-bloqueia-corte`, gate G. Nenhuma linha `not matches` impediu, nesta prova, a entrada de um leitor na allowlist de corte. A lista dos treze não promove allowlist.

A comparação de 23 faturas em `0086558` continua amostra limitada e fora desta promoção. O exit 1 de `0086558` no `nativo.py` e o relato de 24 checks em `55e0d29` permanecem históricos. A corrida de 25 grupos é a prova nomeada de `6963214`.

## CI da candidata

O espelho `ci-run-6963214.json`, lido do diretório imutável, guarda o snapshot `status=in_progress`, `conclusion=null`, `updated_at=2026-10-29T12:56:16Z`. Nesse instante o job `agente` (`123459688220`) já estava `completed` / `success` às `2026-10-29T12:56:29Z`, e o job `verificar` (`123459687659`) estava `in_progress`, com a migração 65 para 66 ainda `pending` no registro do lote 31. Esse arquivo não foi reescrito.

Leitura posterior, sem token, em `2026-10-29T13:21:13Z`:

- `GET https://api.github.com/repos/TavaresEnok/nexoisp/actions/runs/40877414874`
- `status=completed`, `conclusion=success`, `updated_at=2026-10-29T13:11:42Z`
- `head_sha=6963214927aa45ae1963c58d4c14ba540d78c2f0`
- `head_branch=dev/lote31-b04-pg-validado-6963214`
- evento `push`, run número 64, workflow `backend Go e painel`
- `GET .../jobs`: `verificar` `completed` / `success`, `completed_at=2026-10-29T13:11:42Z`; `agente` `completed` / `success`, `completed_at=2026-10-29T12:56:29Z`
- o passo `Migração 65 para 66 e movimentos financeiros históricos` aparece `success` nessa leitura de jobs

Essa conclusão cobre o SHA `6963214` na branch candidata. Não cobre `d37603f`, `6ca6d21` nem `2b80d7e`. Não é `main`, não é deploy e não é homologação. Não promove os seis critérios abertos. Não apaga o run `40840682617`. O mapa não inventariou artefatos do run, então o SBOM hospedado de B01 continua sem conferência de artefato.

## B15 — desenho revisado, implementação ainda futura

Fontes: `docs/B15-DESENHO-CLOUD-API.md` e `docs/B15-ACEITE-CLOUD-API.json`, commit `6ca6d21`. Casos `B15-C01` a `B15-C27` e `B15-H01` estão `planned/not_run`, `executado` falso. Nenhum pacote `cloudapi` ou `cloudjournal` existe no código deste HEAD. Nenhuma migração 79 foi gravada. Nenhuma conta, token ou chamada à Meta entrou no lote.

O canal HTTP genérico já entregue permanece o caminho de `generic_http`. O adapter `cloud_api` é desenho. Duas travas precisam estar verdadeiras juntas para qualquer byte à Meta, e as duas nascem fechadas: `NEXO_CLOUD_API` igual a `on`, e versão presente em `provenGraphVersions`. A lista de versões nasce vazia. Conta nasce com `active` falso, e a migração futura não insere conta. `NEXO_DEMO_MODE` não abre esse cliente.

| Frente | Arquivos donos, ainda não gravados | Contrato | Dependência |
| --- | --- | --- | --- |
| R1 cliente HTTP puro | `apps/api-go/internal/outbound/cloudapi/client.go`, `redact.go`, `client_test.go` | `go test -count=1 ./internal/outbound/cloudapi/` com `RoundTripper` falso, sem rede | nenhuma |
| R2 journal | `db/migrations/00079_cloud_notice_journal.sql`, `apps/api-go/internal/outbound/cloudjournal/journal.go`, `journal_test.go` | `go test -count=1 ./internal/outbound/cloudjournal/` em PostgreSQL de teste. Skip por ausência de URL não aprova | nenhuma de R1. O sender do teste é falso e o pacote não importa `cloudapi` |
| G gate | `apps/api-go/internal/outbound/notices_cloud.go`, `apps/api-go/internal/outbound/sql/69b06ce3_3.sql`, `apps/api-go/internal/radius/sql/b2808f33_1.sql`, registro da rota `POST /api/webhooks/cloud-api/{account}`, `notices_cloud_test.go` | `go test -count=1 -run TestCloudNoticeGate ./internal/outbound/` em PostgreSQL de teste | R1 e R2 já aprovados. G não é critério para R1 passar nem para R2 passar |

R1 aprova sem journal, sem PostgreSQL e sem R2. R2 aprova sem o cliente real. O inteiro `00079` é o próximo livre depois de `00078_import_batch_compensations.sql`. Se outro lote ocupar esse número antes, o dono renomeia antes de gravar. R2 edita o check de `notice_log` para aceitar `skipped_settled`. Os literais de `69b06ce3_3.sql` e `b2808f33_1.sql` ficam com G. `notices.go`, `message.go`, `http.go`, `delivery.go`, `integracoes.go`, `avisos.go` e a tela de canais ficam fora de R1 e de R2.

Homologação H continua aberta: conta WABA, template aprovado, versão Graph citada em fonte primária atual e envio real deliberado. O exit futuro de R1, R2 ou G não preenche H. Webhook de produção permanece com autenticador `Proven() == false` até lote de operador. Extrato, fiscal, host físico, cópia externa e produção não entram neste recorte.

O lote seguinte, quando a gerência o abrir, é a implementação offline dessas frentes, com R1 e R2 independentes e G depois das duas. Este mapa não abre essa implementação e não delega worker fora do controlador.
