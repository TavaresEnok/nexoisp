# Lote 26 — validação B13 e SBOM local na base cc542a1

A gerência executou os gates abaixo em 2026-10-29 na base `cc542a1b502b9b78bdd0673140bbba0f15a89716` (`cc542a1`). O lote 26 está registrado como DONE, 8/8, com revisão Sonnet. Esta nota não publica, não homologa e não fecha o NexoISP. Não há percentual.

O HEAD de desenvolvimento que contém as entregas do lote 27 é `e2f3b189176f118a292b418f29132b303a7ade5b` (`e2f3b18`): o fixture PSP em `b67d2f3` e o harness de restore em `56b2187`. Esses dois commits são posteriores a `cc542a1`. A execução descrita aqui não os cobre.

Evidência consolidada: `/home/enok/Documentos/projetos/implementacao-codex/lote26-validacao-b13-sbom-2026-10-29/evidencias/gate-summary-cc542a1.json`. Logs no mesmo diretório: `gate-go-integration-cc542a1.log`, `gate-go-integration-cc542a1-summary.json`, `gate-nativo-cc542a1.log`, `postgres-nativo-cc542a1.log`, `gate-e2e-import-cc542a1.log`, `gate-sbom-cc542a1.log`, `gate-sbom-cc542a1-summary.json`, `browser-output-preservation.json` e `sbom-cc542a1/`.

`docs/LOTE24-B13-DESENHO-COMPENSACAO.md` e `docs/LOTE24-B13-ACEITACAO.json` permanecem históricos, `planned/not_run`. O contrato MVP continua só `invoices`, no máximo 200 linhas `created`, sem PSP, sem franquia, com IDs e histórico preservados e `evidence.reverted` falso.

Go, browser dirigido e SBOM local descritos abaixo permanecem a prova da base `cc542a1`. A corrida posterior `0086558` não os repetiu. O resumo dessa corrida aponta `previous_unchanged_go_browser_sbom_evidence` para `cc542a1`. O CI hospedado do commit candidato continua sendo o gate real de publicação. O HEAD de desenvolvimento que contém a correção do campo opcional e o desenho B04 é `027e4615691452e35df11522ac373103ed346a1f` (`027e461`): `9c764d7` e `728f2ff`. Essa documentação não publica esse HEAD.

## Quatro estados

| Estado | Leitura desta base |
|---|---|
| Implementado | Compensação do lote 25 e geração de SBOM do lote 26 estão no código de `cc542a1`. O fixture HTTP corrigido e o harness B12 entram só em `e2f3b18`. |
| Executado | `go_integration.py` exit 0. Browser dirigido exit 0. SBOM local exit 0. `nativo.py` exit 1, comando não concluído. |
| CI e publicação | O workflow no arquivo inclui SBOM e, a partir de `56b2187`, o ensaio de restore. Nenhum run hospedado foi conferido para `cc542a1` nem para `e2f3b18`. |
| Homologação | Sem conta, host físico, cópia externa, cofre, RPO/RTO ou piloto. |

O CI relatado de `e193266` (runs 40717836379 e 40717831261) e a geração ou os gates da base `6f4bf38` não validam `cc542a1`.

## Go — 241 ações, das quais 58 são de compensação

Comando `python3 tests/contrato/go_integration.py`, exit 0. O resumo conta 241 ações pass, incluindo subtestes. Não lista falha nem skip de caso. Pacotes sem arquivo de teste aparecem com `state: skip` e `Action: skip` de elapsed 0 (`cmd/api`, `cmd/nexo-db`, `cmd/nexo-vpn`, vários `internal/*` e pacotes `gen`). Isso não é skip de `TestImportCompensate` e não aprova um caso ausente.

As 58 ações de compensação, todas `pass` em `gate-go-integration-cc542a1-summary.json`:

| Caso | Ações Go que passaram | O que essa prova não é |
|---|---|---|
| B13-01 | `TestImportCompensate_B13_01` | O HTTP de `nativo.py` não concluiu. |
| B13-02 | `TestImportCompensate_B13_02` | Idem. |
| B13-03 | pai, `marcador`, `auditoria` | O caso só tem teste Go. A execução é essa, com banco. Não é HTTP nem homologação. |
| B13-04 a B13-09 | um teste cada, todos pass | O HTTP correspondente não tem resultado por caso. |
| B13-10 | pai, `aviso_anterior`, `encargo`, `dependente` | Não inclui o fixture `gateway_charge_id` / `provider_issuance` que interrompeu o HTTP. |
| B13-11 | pai, `baixa_primeiro`, `compensação_primeiro`, `concorrente`, e `TestImportCompensate_B13_11_Barreira` com os dois subtestes | A ordem HTTP commitada do mesmo caso não foi alcançada. |
| B13-13, B13-14, B13-16, B13-17, B13-18 | um teste cada, ou os subtestes de B13-13 (`igual`, `anterior`) | HTTP não concluído. |
| B13-15 | pai e sete subtestes de ator | Núcleo sem banco e sem HTTP. CSRF, cookie e sessões continuam só no contrato Python. |
| B13-19 | onze subtestes de entrada, o pai, e `TestImportCompensate_IdempotencyConflictAndCap` | A validação de entrada é unitária. Conflito, `nothing_created` e `row_cap` passaram no Go com banco. O HTTP não concluiu. |
| B13-21 | pai, `emissão_espera_e_recusa_a_origem`, `compensação_commitada_antes_da_emissão` | Caso só Go, com banco, sem PSP real. |
| B13-22 | pai, `ordem_invertida_produz_deadlock`, `ordem_do_protocolo_conclui` | Caso só Go. Observou `40P01` e a ordem canônica. |
| Fora da numeração | `TestImportCompensateSourceGuards`, `TestImportCompensateHashOmitsKey` | Não fecham um dos 22 casos. |

B13-12 e B13-20 não têm teste Go nessa lista.

## Browser dirigido

`gate-e2e-import-cc542a1.log` percorre `frontend-v0-import.mjs` e termina nas jornadas sem falha registrada. O resumo marca exit 0, desktop e viewport 390, resposta perdida de um POST já commitado recuperada pela UI uma vez, sem segundo estorno, e a jornada adicional de `manual-payment` com perda de resposta.

O log nomeia, sem usar os IDs B13: motivo e confirmação, bloqueio real do POST, reenvio da mesma chave, compensação gravada sem outro estorno, lote committed sem nova ação, POST commitado com resposta perdida recuperada pela ficha, recusa de lote que não é de títulos, isolamento e permissões. As capturas ficam no arquivo externo `browser-real-cc542a1/`, listadas em `browser-output-preservation.json`. Não estão neste commit.

Essa corrida não é a matriz dos 22 HTTP. Não marca caso como passado só porque o tema se parece com o script.

## HTTP nativo — comando não concluído

`python3 tests/contrato/nativo.py` na base `cc542a1` terminou exit 1. A limpeza de elegibilidade anterior passou. A matriz de compensação avançou até `import_compensate_contract.py:335`, no setup do fixture `gateway_charge_id` sem `financial_connection_id`. O PostgreSQL recusou com `financial connection required` (`postgres-nativo-cc542a1.log`). Não há linha de resultado por caso. Os 22 HTTP não estão passados.

O traceback cai dentro de B13-10, no quarto `refuse_blocker` (`provider_issuance`), depois dos asserts anteriores do mesmo `verify()`. Casos que o fonte coloca depois desse ponto não chegaram a rodar. Casos anteriores também não ganham `executado: true`: o processo não concluiu e o log não registra cada um.

O lote 27 alterou esse setup em `b67d2f3`: insere uma `financial_connections` sintética EFI sandbox do mesmo tenant e empresa, grava `gateway` e `gateway_charge_id` juntos e mantém o POST 409 `provider_issuance`. `python3 -m py_compile` desse arquivo terminou 0. Uma tentativa anterior, com container `nexo-b13-psp-fixture` e porta 25478, morreu em `nativo.py:19` com `FileNotFoundError: docker`, exit 1, antes de PostgreSQL. Essa tentativa ficou para trás.

A corrida seguinte, base `0086558d9296054cfaf89071c9ae1bf0f2f56571`, passou do fixture PSP. O resumo `/home/enok/Documentos/projetos/implementacao-codex/lote27-b13-http-restore-2026-10-29/evidencias/gate-summary-0086558.json` marca `earlier_psp_fixture_passed` verdadeiro e `nativo.exit_code` 1. O log `gate-nativo-0086558.log` para em `tests/contrato/import_compensate_contract.py:369`, com `KeyError: 'entity_id'` na linha `error` do lote misto. `importResult` só serializa `entity_id` quando o id não é nil. A ausência é contrato válido. `http_22_cases_passed` é falso. O comando não concluiu, então os 22 HTTP continuam sem exit 0. Casos anteriores a essa linha não ganham `executado: true` por esta nota.

O commit `9c764d7` ajusta a expectativa: a linha `error` aceita `entity_id` ausente ou nulo e recusa id presente e não nulo. Esse commit está em `027e461`. A correção entregue e qualquer revisão dela não são uma nova execução aprovada. Compilação também não é o gate. A gerência repete `python3 tests/contrato/nativo.py` sem `-I` no HEAD que contém `9c764d7` e exige exit 0.

## SBOM local

`scripts/generate-sbom.sh` e `scripts/validate-sbom.py` terminaram exit 0 na mesma base. Run `local-l26-cc542a1`. Commit gravado nos dois artefatos: `cc542a1b502b9b78bdd0673140bbba0f15a89716`.

| Ecossistema | Componentes | Topo | SHA-256 |
|---|---|---|---|
| Go | 52 | 52 | `f8090a025b2555058213d0fc4684a5000d9795afb81cfa1d904b6a2c63cc84ac` |
| npm | 1075, incluindo aninhados | 754 | `003f12bca69988957ac9fb068d5f4ef41f890bced7f9a07501b788dc39d3e9bd` |

O log do npm repete o aviso de peers WASM opcionais (`@emnapi/*`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`). A lista aceita é a do lockfile, como `docs/SBOM.md` já descreve. Não houve `audit fix`. O passo existe em `.github/workflows/native.yml` e publica o artefato `sbom-cyclonedx` quando o job roda. `hosted_ci_verified` no resumo é falso. Geração local não é run hospedado nem imagem publicada.

## B12 nesta mesma leitura

O harness `tests/contrato/restore_clean_host.py`, os testes negativos `tests/operacao/test_restore_clean_host.py`, o passo em `native.yml` e `docs/RESTORE-LAB-HOST-LIMPO.md` estão em `56b2187`. O unittest estático da entrega rodou 13 testes, OK, em 0,024 s. Esse estático não aprova B12. No worker que escreveu a nota do lote 26, `docker` estava ausente e não houve JSON de corrida. Essa ausência descreve aquele worker. Não descreve a corrida posterior.

Na base `0086558` o mesmo comando terminou exit 0, com 17 fases e `ok` verdadeiro. A evidência rastreável é `restore-clean-host-0086558.json`, `gate-summary-0086558.json` e `gate-restore-clean-host-0086558.log`, no diretório do lote 27 citado acima. Os dois clusters são novos: `nexo-b12-src-30cf94629328` e `nexo-b12-dst-30cf94629328`, com volumes próprios. A corrida comprovou bytes de documento, hash pela verificação do restore, download HTTP, recusa de chave errada, recusa de manifesto e de dump manipulados, grants e isolamento, login, filas com jobs desligados e o replay B13 sem nova reversão. `resources_cleaned_by_harness` é verdadeiro. `static_approval` é falso.

O exit 0 deixa abertos host físico, cópia externa, cofre, RPO/RTO produtivo, piloto, exactly-once externo e os testes `tests/test_backup_integrity_isolated.py` e `tests/test_backup_executor_integrity_lab.py` do repositório Backup-center. Esses arquivos não estão neste clone. O passo do workflow também não teve run hospedado. Não se explica mais o ensaio sintético por falta de autorização ou de bancada: ele já foi executado. Não refazer o harness nem essa corrida só para repetir o registro.

## Pendências que a prova deixa abertas

1. Repetir `python3 tests/contrato/nativo.py`, sem `-I`, no HEAD que contém `9c764d7`, em PostgreSQL 16 descartável. A base `cc542a1` parou no fixture. A base `0086558` passou desse fixture e parou no `entity_id` opcional da linha `error`, antes de terminar os 22 HTTP. A correção `9c764d7` ainda não teve essa repetição. Exit diferente de 0 não passa os 22 HTTP.
2. O ensaio sintético `python3 tests/contrato/restore_clean_host.py` na base `0086558` está registrado, exit 0, 17 fases. B12 segue aberto no host físico, na cópia externa, no cofre, no RPO/RTO produtivo, no Backup-center, no piloto e no exactly-once externo. O run hospedado do passo também falta.
3. Conferir um run do `native.yml` no commit candidato, com o artefato `sbom-cyclonedx` e o passo de restore. Go, browser e SBOM local de `cc542a1` continuam válidos nas partes que `0086558` não reexecutou. Não reutilizar `e193266` nem `6f4bf38`.
4. O desenho B04 em `728f2ff` (`docs/B04-DESENHO-CORTE-LEITOR.md` e `docs/B04-ACEITE-CORTE-LEITOR.json`) é preparação. A comparação sintética de `0086558` leu 23 faturas e 23 sombras sem drift no tenant alfa, zero no beta e zero acordos. Essa leitura e o desenho não ativam o corte. A matriz do aceite permanece com `executado` falso.
5. Homologação, push e deploy continuam fora desta nota.

Não reimplementar os lotes 25 e 26, o fixture PSP `b67d2f3`, o harness `56b2187` nem a expectativa já corrigida em `9c764d7`. Não refazer a corrida de restore `0086558` como se ela faltasse. O próximo trabalho de B13 é a repetição do HTTP até exit 0, mais a revisão independente do que essa repetição mostrar. O corte B04 não entra como código neste registro.
