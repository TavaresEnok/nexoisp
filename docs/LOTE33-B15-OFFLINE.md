# Lote 33 — MVP interno B15, offline e desligado

Este lote implementa o MVP interno do adapter Cloud API de avisos. O desenho lido é o do lote 32, commit `6ca6d21`, com o adendo de refinamentos no final de `docs/B15-DESENHO-CLOUD-API.md`. A matriz está em `docs/B15-ACEITE-CLOUD-API.json`. Não há conta, token, ativação, envio externo, UI nova, chamada à Meta nem chamada a PSP. Não há publicador automático e não há exactly-once fora do processo.

A auditoria de snapshots do lote 32 permanece em `docs/evidencias/B04-GATES-6963214-AUDIT.json`. Este arquivo não a edita. Ela não fecha critério funcional de B04 nem de B15.

## Camadas

| Camada | Fato |
| --- | --- |
| Implementado no clone | Cliente puro, migração 79, tipos, consentimento, journal, status, webhook que recusa por padrão e worker. Flags de produção continuam fechadas: `NEXO_CLOUD_API` só com `on`, `provenGraphVersions` vazio, `cloud_accounts.active` default falso. A migração não insere conta. |
| Testes com sender falso | `go -C apps/api-go test -count=1 -v ./internal/outbound/cloudapi/` terminou exit 0 em 2026-10-29, 0,163 s, sem rede e sem PostgreSQL. PASS: `TestCloudAPI_B15_C10`, `C11`, `C12`, `C13`, `C14`, `C15`, `C16`, `C17`, `C18`, `C22`, `C23` e `C25`. Essa corrida é a fonte de R1 na matriz. Presença do nome do teste no arquivo não é a fonte. |
| PostgreSQL | R2 e G não foram executados. `NEXO_CLOUD_PG_REQUIRED=1` ainda não rodou. O comando da gerência é `python3 tests/contrato/go_integration.py`, sem `-I` e sem runner novo. Skip por falta de URL não aprova. O contrato `tests/contrato/cloud_notices_contract.py` entra em `nativo.py` e prova preparação da migração 79, webhook recusado e ausência de efeito financeiro quando esse laboratório rodar. Esta entrega não executou o `nativo.py`. |
| CI | O verde conhecido continua o run `40877414874`, SHA `6963214927aa45ae1963c58d4c14ba540d78c2f0`, `success` em `2026-10-29T13:11:42Z`, na candidata `dev/lote31-b04-pg-validado-6963214`. Não cobre o código deste lote. O lote 33 está com CI pendente. |
| Publicação | `main` e deploy não receberam este lote. A base documental ancestral conferida aqui é `f42256b558288590f8e804b558982f15651981fb`. O objeto git `33f42256b` não está neste clone. O desenho do lote 32 permanece histórico. |

## O que o MVP fecha por dentro, e o que deixa aberto

Fechado no código, ainda sem prova de banco para R2 e G: reserva em A, linearização só no commit de `MarkWire`, consentimento com `FOR SHARE`, três estouros em `cloud_lock_timeouts` sem confundir com `attempts`, retenção de `skipped_settled` sem apagar dado financeiro, e status que recusa sem decoder provado na instância. `UnprovedAuthenticator.Proven` permanece falso. `BodyParams` não vazio continua recusado. A versão de fixture `v0.0` não é versão homologada.

Aberto: H01, protocolo Meta, WABA, template aprovado, versão Graph de fonte primária atual, API real, conta e qualquer mensagem real. O exit 0 de R1 não preenche esses itens. O projeto não está em 100% e este lote não é produção.

## Composição desta entrega

`apps/api-go/internal/outbound/cloud_notice_contract_test.go` compõe as travas locais sob `TestCloudNoticeContract`. Não duplica identificador de raiz. `tests/contrato/cloud_notices_contract.py` exporta `verify(api, call, sql)` e só é chamado por `tests/contrato/nativo.py`. Não envia HTTP para fora do laboratório.
