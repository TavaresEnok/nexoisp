# Conclusão integral do NexoISP — reconciliação de 29/10/2026

Este mapa reconcilia o backlog B01–B18 e a matriz funcional oficial com o clone em `82c42517afe1628b0a7d06865e8da5a6618643f0` (`82c4251`), branch `task/556b3d63d7fc/t0-mapa-conclusao`. A fonte estruturada é [CONCLUSAO-INTEGRAL.json](CONCLUSAO-INTEGRAL.json).

Este lote não encerra o projeto. A autorização de 29/10/2026 é continuar por eventos até os critérios do mapa integral estarem fechados, sem reabrir plano ou tarefa já concluídos. Quantidade de endpoints, de telas ou de linhas da matriz não é conclusão.

## Como ler os estados

Cada critério separa quatro estados:

| Estado | Significado neste mapa |
|---|---|
| Implementado | O comportamento existe no clone, no desenho aprovado ou está ausente. Análise de código não substitui teste. |
| Testado | Há evidência de execução nomeada. Relato histórico não foi reexecutado nesta reconciliação. |
| Homologado | Há prova no serviço, banco, equipamento ou ambiente do responsável. Sandbox sintético e laboratório local não contam. |
| Publicado | Distingue commit no clone, relato de publicação no GitHub e deploy de produção. |

Não há percentual. Critério sem prova fica aberto, com causa, dependência, evidência faltante e comando de validação. Skip de `tests/contrato/nativo.py` ou `tests/contrato/go_integration.py` por falta de PostgreSQL não é teste de banco aprovado. A invocação executável é `python3 tests/contrato/nativo.py` e `python3 tests/contrato/go_integration.py`, na raiz do repositório, sem `-I`, como em `.github/workflows/native.yml`. Esta reconciliação não executou esses dois comandos. `python3 -I` nos mesmos scripts falha com `ModuleNotFoundError: No module named 'lib'` antes do laboratório; essa falha de bootstrap não é skip de banco e não aprova o gate. A gerência precisa rodar a invocação sem `-I` em laboratório PostgreSQL descartável antes de publicar qualquer lote que toque banco, isolamento ou dinheiro.

## Autorização, custo e franquia

- Continuar de forma autônoma depois de cada lote até o mapa integral fechar. Não parar no fim do lote como se o projeto tivesse terminado.
- Executor exclusivo: Grok 4.7 médio. Revisão independente: Sonnet 5.5 alto, ou Sol médio somente quando a cota do revisor principal estiver comprovadamente indisponível. Custo adicional zero, pela assinatura já em uso.
- Sem franquia. A decisão comercial já foi tomada: não implementar cota ou franquia de consumo. Telemetria RADIUS entregue no lote 20 permanece observação, sem política comercial de bloqueio por franquia.
- Sem PSP real e sem produção neste ciclo de reconciliação. Históricos de lote, inclusive `docs/LOTE24-B13-DESENHO-COMPENSACAO.md` e `docs/LOTE24-B13-ACEITACAO.json`, permanecem intactos.
- Interbancário só entra com demanda explícita. Fiscal só entra com escopo real (UF, documento, emissor, CNPJ). Nenhum dos dois está habilitado neste clone.

## Base e o que esta reconciliação não refez

HEAD do clone: `82c4251`, merge de `9fe63f0` (lote 24, só documentação do B13) sobre `e193266` (lote 23, elegibilidade de reversão somente leitura). O relatório histórico `00_STATUS.md` de 29/10/2026 registra o lote 24 como documental, sem push nem deploy, e o último código funcional publicado como lote 23 / `e193266`, com CI hospedado citado nas duas branches. Esta reconciliação não consultou de novo o GitHub Actions. Os identificadores de run abaixo são relato daquele arquivo, não observação nova.

A reconciliação de 29/10 que gravou estes dois arquivos, na base `82c4251`, executou somente os três testes documentais daquele pedido. Não abriu conta, certificado, equipamento, backup de produção nem banco de laboratório. A branch de desenvolvimento avançou depois disso até `8c10c1a`, com o código do lote 25. Esse avanço está registrado em B13 e na continuação. Os demais itens B01–B18 abaixo continuam a leitura da base, salvo o ponteiro que ainda mandava implementar B13 de novo.

Documentos de lote no clone: `docs/LOTE01` a `LOTE16`, `LOTE18`, `LOTE19` e `LOTE24`. Os recortes 17 e 20–23 estão nos relatórios externos 30–36 e nos commits do clone; a ausência de `docs/LOTE17.md` não apaga a entrega. Relatórios lidos em `/home/enok/Documentos/projetos/resultados-analise-nexoisp`: `00_STATUS.md`, `08_BACKLOG_EXECUTAVEL.md`, `11_COMPLEMENTO_REVISAO.md`, `31` a `37`. O complemento de 25/10 descreve o mundo anterior a B02–B13; onde o código posterior existe, o complemento fica histórico.

## Matriz funcional oficial

`docs/integracao-v0/matriz-funcional.json` tem 174 unidades. Contagem lida neste clone:

| `backendState` | Unidades |
|---|---|
| Implementada | 132 |
| Somente backend | 26 |
| Parcial | 11 |
| Demonstrativa | 4 |
| Não confirmado | 1 |

| `integrationState` | Unidades |
|---|---|
| validated | 154 |
| backend-preserved | 20 |

`validated` aqui é a integração da interface oficial às capacidades então disponíveis no Go, com evidência em `docs/integracao-v0/evidencias/fechamento-sete-etapas.json` (`verified_at` 2026-10-19, cobertura da época em 169 unidades). O plano em `docs/integracao-v0/PLANO.md` declara as sete etapas concluídas para essa integração e, no mesmo texto, recusa publicação externa e homologação física. O JSON de fechamento está defasado em relação às 174 linhas atuais; a lista vigente é a matriz JSON.

Unidades que a própria matriz não classifica como backend implementado e integração validada sem ressalva:

| ID | Backend | Integração | Leitura atual |
|---|---|---|---|
| AC-02, FI-15, FI-16, RE-13 | Demonstrativa | validada | UI oficial ligada a dados fictícios ou gateway demo. Não é PSP nem equipamento real. |
| FI-17 | Não confirmado | limitação de backend | Cobrança bancária pagável segue sem homologação. O pipeline Efí sandbox posterior não altera esta classificação na matriz. |
| IN-03, IN-06, IN-11, IN-13, IN-15 | Parcial | validada | OLT, projeto óptico, prefixo, responsável num instante e titular IPv6 anterior continuam parciais na matriz. |
| AD-02, AD-17, AD-18 | Parcial | validada | Senha de terceiro, comissão sem liquidação, DICI sem transmissão à ANATEL. |
| AD-20 | Parcial | limitação | Importação CSV existe. Migração universal SGP/MK-Auth não. |
| PO-09 | Parcial | limitação | Portal não quita em instituição real. |
| BE-23 | Parcial | limitação | Distribuição multi-célula além de `c1` sem prova. |
| BE-01, BE-02, BE-10 a BE-22, BE-25 | Somente backend | preservado | Contrato externo ou serviço interno. Presença de rota não é homologação. |

A matriz SGP em `docs/SGP_COMPARATIVO_NEXOISP/matriz_capacidades.csv` (45 fluxos) e `matriz_superficies.csv` (1246 linhas) é inventário comparativo anterior aos lotes 07–24. Situações como C11 “apenas interface, mock ou simulação” foram superadas no código pelo pipeline Efí sandbox; o CSV não foi reescrito e não deve ser lido como status de 29/10. C12 (fiscal), C19 (compras — o backend de depósitos/compras entrou na integração de 20/10 e a linha do CSV pode estar velha), C24 (VLAN/switch) e C44 (mapas externos/push) permanecem, no CSV, como ausentes; só C12 e a ausência de adapter fiscal foram reconfirmadas no clone. Não se recalculou as 1246 superfícies.

## Interface oficial, isolamento, segurança, acessibilidade e operação

- UI oficial é `apps/web`, referência em `docs/novo-design-nexoISP`, legado só em `apps/web-legacy`. `AGENTS.md` proíbe trocar a interface v0 pela antiga. Páginas em `/demonstracao/` usam dados fictícios. Falha de API operacional não pode cair em seed.
- Isolamento tenant, POP, portal e suporte está desenhado nas rotas financeiras, de importação e de RADIUS dos lotes 10, 16, 18, 19 e 23. A compensação do lote 25 usa o mesmo recorte no POST e no GET, no código da branch `8c10c1a`. A prova automatizada mora em `tests/contrato/nativo.py` e `tests/contrato/go_integration.py`, mais `go test -race` no workflow `.github/workflows/native.yml`. Sem execução neste laboratório, essa prova não existe para `8c10c1a`. O CI relatado de `e193266` não cobre este HEAD. Skip sem PostgreSQL não aprova.
- Segurança de sessão: cookie HttpOnly, CSRF e MFA existem no código e na matriz AC-01/AC-08/BE-20. Revisão independente de segurança e sessão com leitor de tela continuam na lista de `docs/pendencias.md`, sem prova nova.
- Acessibilidade: `apps/web/tests/audit-remediation.json` registra `completion: partial` no checkpoint de 18/10/2026. Não há suíte axe como gate do workflow. T-UI-01 do backlog (teclado até erro e ação, 503 sem amostra) não tem corrida registrada nesta reconciliação.
- Operação: `infra/monitoring/alerts.yml` e `prometheus.yml` definem alertas de API, fila e jobs. `docs/PILOTO.md` e `docs/pendencias.md` ainda exigem monitor externo no host do provedor, preflight `./nexo prod db preflight` e canal do responsável. Artefato no repositório não é monitoramento publicado.
- Runtime pinado no clone: Node `>=22.23.4 <23` (`.nvmrc` `22.23.4`), npm `>=10.9.9 <11`, Go `1.27.3` em `apps/api-go/go.mod`. Não há arquivo SBOM no clone.

## B01–B18

Prioridade herdada do backlog executável. “Entregue” significa implementação presente e teste local ou de CI relatado no escopo daquele lote. Homologação externa e produção permanecem abertas em todos os itens que dependem de banco, PSP, fisco, equipamento ou piloto.

### B01 — build, dependências e SBOM — P0 — parcial

Implementado no clone: engines em `package.json`, Go 1.27.3, workflow `native.yml` com build, vet, `go test -race`, golangci-lint 2.14.0, npm ci, typecheck, testes web e build. Commit de Backup-center `e5c39eb` trava dependências Python à parte.

Aberto: não há SBOM (CycloneDX ou equivalente) versionado nem passo de SBOM no workflow. Triagem de advisories npm/Go não foi refeita em 29/10. O complemento de 25/10 ainda registra divergência antiga de toolchain; o `go.mod` atual diz 1.27.3, alinhado ao relato do lote 21, sem SBOM que prove a imagem publicada.

Causa: identidade de build reproduzível no CI relatado não inclui lista de componentes assinada. Dependência: nenhuma conta externa. Próximo passo: gerar SBOM de `apps/api-go` e do workspace npm no mesmo runner do `native.yml`, guardar o artefato e não aplicar `audit fix` cego. Validação: checkout limpo, `go version` igual a `go 1.27.3`, `node -v` igual a `v22.23.4`, presença do artefato SBOM no run. Gate de publicação: o mesmo workflow com PostgreSQL descartável; skip de banco não aprova o job.

### B02 — idempotência da baixa manual — P0 — entregue no código

`POST /api/invoices/:id/manual-payment` exige `intent_id`. Migração `db/migrations/00064_manual_payment_intents.sql`, commit `dc21fd1`. UI em `apps/web/features/finance/actions.tsx`. Evidência histórica: `docs/LOTE01-CONSOLIDADO.md` (100 replays, perda de resposta após commit) e o passo de `nativo.py` no workflow. Homologação bancária não se aplica a este mecanismo. Produção não publicada. Não reabrir o lote 01.

Antes de publicar lote futuro que mexa em baixa: repetir `python3 tests/contrato/nativo.py`, sem `-I`, em laboratório descartável. Esta reconciliação não o fez. A forma com `-I` falha no import de `lib` e não alcança o banco.

### B03 — contas financeiras — P0 — entregue no código, sem conta real

Migração `00065_financial_connections.sql`, commit `f3a5b8e`, `apps/api-go/internal/finance/connections.go`, UI `apps/web/features/admin/financial-connections.tsx`. Lote 02. Contratos de migração no `native.yml` (`financial_connections_migration.py`). Nenhuma conta Efí, Asaas ou Inter real foi cadastrada. Backfill ambíguo continua bloqueante se aparecer em instalação; não há evidência de backfill produtivo.

Aberto só a homologação: conta sandbox por tenant, ambiente e credencial, fora deste lote. Validação interna já nomeada: `python3 tests/contrato/financial_connections_migration.py` com `NEXO_PAYMENT_LAB=1` no lab da gerência.

### B04 — ledger e shadow-read — P0 — shadow entregue, corte não feito

Migração `00066_financial_movements.sql`, commit `5327528`. Sombra `financial_balance_shadow` é lida em testes de devolução. `docs/LOTE03-B04-MOVIMENTOS.md` define a comparação nominal, pago, residual, excesso e cobrável. Não há flag de corte do leitor antigo no código pesquisado (`shadow_read` / `UseShadow` ausentes). O corte permanece propositalmente fechado: discrepância impede a troca.

Aberto: decidir o corte somente depois de a consulta de comparação ficar consistente no lab. Causa: sombra sem promoção a fonte única. Validação: repetir o contrato `financial_movements_migration.py` e a leitura comparativa descrita no lote 03, em PostgreSQL descartável. Não apagar movimentos.

### B05 — efeitos técnicos separados do recebimento — P0 — entregue e desligado por padrão

Migração `00067_payment_effects.sql`, commit `48ce2f0`, `payment_effects.go`, lote 04. Falha de rede não desfaz recebimento no desenho testado localmente. Consumidor de produção não está implantado; jobs dependem de habilitação explícita na instalação.

Aberto: ativar o consumidor só no piloto, com fila observável. Homologação de suspensão em NAS real continua em B11/B18. Validação: `python3 tests/contrato/payment_effects.py` e `payment_effects_migration.py` com `NEXO_PAYMENT_LAB=1`.

### B06 — contrato PSP e simulador — P0 — entregue no laboratório

`apps/api-go/internal/finance/providers/contract.go`, `demo_event.go`, `lab_test.go`, lote 05. Nenhum fornecedor real ativado. O demo não é homologação. Produção não seleciona esse simulador como banco; a prova vigente é de código e testes locais relatados, não uma conta.

Aberto: corpus adverso completo (timeout antes e depois do efeito, callback fora de ordem) permanece coberto pelo que o lote 05 declara ter testado. Não foi reexecutado aqui. Próximo uso desse contrato é gate dos adapters, não um lote repetido.

### B07 — Efí sandbox — P0 — implementação interna entregue, homologação sem prova

O pacote `apps/api-go/internal/finance/providers/efi` cobre Pix imediato, Pix com vencimento e Bolix, só com `Environment=sandbox` (`transport.go`). Lotes 06–11, 16 e 18 e os relatórios 20–25, 30 e 31 entregam, em sequência já feita e que não deve ser reaberta:

- journal de emissão, reserva e vínculo (migrações 68–72);
- cofre, consumidores e recebimento com gates em 0;
- cancelamento e devolução parcial no ledger, sem virar devolução bancária Bolix por existir reversão local;
- interface oficial de preparação;
- artefatos e callbacks com persistência antes do HTTP 200;
- triagem de avisos sem liberar reserva;
- resolução por consulta autenticada, reemissão na mesma fatura e retenção (migração `00077_provider_resolution.sql`, commits `4006f55` e `b5bad2b`).

Gates continuam desligados salvo `=1`: `NEXO_GO_EFI_SANDBOX_ENABLED`, `NEXO_GO_EFI_DISPATCH`, `NEXO_GO_EFI_OPERATIONS_WRITE`, `NEXO_GO_EFI_CHARGES_CALLBACK_ENABLED`, `NEXO_GO_EFI_CALLBACK_REGISTRATION`. Não houve chamada autenticada à Efí nos relatos desses lotes.

Aberto, e é o que falta para fechar B07: conta sandbox, certificado, escopos e origem TLS autorizados pela Efí; semântica de produto confirmada com o fornecedor; política de retenção escolhida pelo operador. Causa: recurso externo ausente. Tarefa interna restante não inclui reimplementar resolução. Validação de regressão, quando a gerência abrir lab: contratos `provider_issuance_migration.py`, `provider_pipeline_migration.py`, `provider_operations_migration.py` e os testes Go `provider_resolution`. Homologação: roteiro sandbox Efí com os três produtos, evidência sem segredo. Produção permanece fora de autorização.

### B08 — Asaas e Inter — P1 — não implementado

`apps/api-go/internal/finance/providers` contém contrato, demo e `efi`. Não há adapter Asaas nem Inter. O lote 05 mantém Asaas, Inter, Sicredi, Mercado Pago, PagBank e Stripe no planejamento. Kobana, Shipay e Tuna não estão contratados.

Inter é por demanda. Não há demanda registrada neste clone que habilite Inter. Não inventar convênio, certificado ou flag. Asaas segue como próximo PSP depois da homologação Efí, não em paralelo com produção.

Causa: ausência de pacote e de conta. Dependência: B06 entregue e B07 homologado, mais credencial sandbox Asaas quando o operador a tiver. Não iniciar Asaas neste evento. O código de compensação B13 está na branch e o critério B13 continua aberto até o lab. Asaas só depois da homologação Efí e de conta sandbox. Próximo recorte de Asaas, só então: um adapter mínimo com o mesmo corpus do B06, inbox antes do HTTP 200, sem CNAB e sem NFCom do Asaas no lugar de nota de telecom. Validação: testes de contrato com servidor falso; a homologação é outra corrida, com conta Asaas. Inter fica sem tarefa até pedido explícito do operador.

Gate de B08-inter, sem comando neste clone: registro versionado e sem segredo da decisão do operador, com a frase “Inter demandado” ou “Inter não demandado”. A segunda fecha o critério como não aplicável. A primeira só então autoriza teste futuro de adapter com HTTP falso e isolamento por tenant, sem convênio de produção. Sem o registro, o critério permanece aberto.

### B09 — ACS — P0 — journal entregue, bancada sem prova

Migração `00075_acs_task_intents.sql`, lote 13, relatório 27, commit `8c9815d`. Intenção durável, isolamento e readback na interface e no portal. Gates em 0: `NEXO_GO_JOB_ACS_TASKS`, `NEXO_ACS_TASKS_ENABLED`, `NEXO_ACS_TASK_WRITE`, `NEXO_ACS_OWNERSHIP_ENABLED`, além de `NEXO_GO_JOBS=1`. Uma instância ACS por instalação. `observed` não é homologação física.

Aberto no próprio lote 13: múltiplos ACS por tenant, transferência de propriedade, descarte de journal/PSK por retenção, resolução administrativa de incerteza sem readback, CWMP TLS no GenieACS da instalação, modelo e firmware reais. Causa da homologação: sem bancada. Próximo recorte interno pequeno, sem fingir CPE: especificar a resolução administrativa de incerteza que não marca sucesso sem readback, com teste em `apps/api-go/internal/acs`. Validação de regressão: testes Go do pacote `acs` e `e2e/acs-task-state.mjs` em lab. Homologação: um CPE e um GenieACS de laboratório com TLS, fora deste mapa.

### B10 — SSH e OLT — P0 — transporte entregue, OLT física sem prova

Lote 12, relatório 26, commit `526cd47`. Pin de host key, rotação auditada, recusa de escrita sem produto e firmware esperados, resultado desconhecido preservado. `allow_writes` só com booleano verdadeiro. Isso é aprovação local do gate, não homologação Huawei.

Aberto: IN-03 parcial; `docs/pendencias.md` e `docs/expansao-olt-onu.md` exigem modelo, firmware, login, paginação e recuperação reais. Causa: sem OLT na bancada. Não remover pin para “fazer passar”. Validação interna já existente: testes do agente em `services/network-agent`. Homologação: roteiro do lote 12 contra o equipamento do piloto, com fingerprint conferido por canal independente.

### B11 — RADIUS, IPv6 e observabilidade — P1 — núcleo entregue, franquia fora, NAS real sem prova

Entregue e que não se reabre:

- Disconnect identificado e recuperação, lote 14, `1d31df5`. Code 40. Code 43 (CoA arbitrário) não foi implementado.
- Accounting durável, IPv6 separado, quarentena e retenção, lote 15, migração `00076`, `9fd9d50`.
- Histórico paginado e CSV IPv6 exato, lote 19, `15a482d`, documento `docs/LOTE19-B11-HISTORICO.md`.
- Serialização de consumo por tenant e telemetria por NAS, lote 20, `de4fc27`, `cd4266f`, UI `8179e9a`. Rota `GET /api/radius/accounting/telemetry` em `radius_telemetry.go`. Flags de evidência da rota permanecem falsas para “isto prova política”. Relatório 33.

Sem franquia: não criar quota comercial nem bloqueio por consumo. A decisão de mercado já fechou esse requisito.

Aberto:

- CoA Code 43, se o piloto ainda precisar alterar atributos de sessão sem derrubar. Causa: só Disconnect foi implementado. Prioridade P1, depois do B13 e da homologação de Disconnect. Validação sintética com cliente RADIUS de teste; homologação no NAS do provedor.
- Transporte IPv6 e DHCPv6-PD no concentrador real; concentrador por agente sem entrega automática (nota IN-11).
- Homologação PPPoE no firmware do piloto (`docs/lab-pppoe.md` é laboratório). `NEXO_RADIUS_DISCONNECT_WRITE` permanece 0 até habilitação explícita.

Validação interna antes de publicar mudança RADIUS: `go test` dos pacotes radius no lab e o cenário `e2e/frontend-v0-radius-*.mjs`. Skip sem PostgreSQL não aprova.

### B12 — backup, restore e Backup-center — P0 — integridade local reivindicada, restore de host sem prova

No NexoISP existem `scripts/backup.sh`, `scripts/backup-manifest.py`, `scripts/restore-verify-prod.sh`, `scripts/restore-isolation.sql` e `apps/api-go/internal/db/restore.go`. No irmão `/home/enok/Documentos/projetos/Backup-center`, HEAD `2e410d2` (26/10/2026). O commit `118df92` altera diagnóstico, limites de ZIP e testes de integridade. Esses dois SHAs e os testes `tests/test_backup_integrity_isolated.py` e `tests/test_backup_executor_integrity_lab.py` pertencem ao repositório Backup-center. `git cat-file` neste clone não os resolve. `CONSOLIDACAO_LOTE01.md` desse repositório relata 258 testes Linux e fluxo sintético SQLAlchemy/PostgreSQL/Redis/Celery, e afirma que integridade de arquivo não comprova restauração completa. Nenhum push ou produção. Esta reconciliação não reexecutou essa suíte.

O complemento de 25/10 dizia que duas falhas de integridade continuavam abertas. O commit posterior `118df92` é a evidência de correção reivindicada; sem reexecução aqui, o mapa marca “teste histórico no relatório de consolidação”, não “reprovado” nem “homologado”.

Aberto: ensaio de restore em host novo (dump, documentos, chaves, grants, RLS, filas) e cópia externa do piloto. Causa: falta bancada descartável autorizada e operador. Proibido apontar restore para configuração herdada de produção. Próximo passo: a gerência sobe um lab vazio e executa o roteiro de `docs/pendencias.md` (cópia e `restore-check`) mais os testes `tests/test_backup_integrity_isolated.py` e `tests/test_backup_executor_integrity_lab.py` do Backup-center. Validação de banco do Nexo, no mesmo lab: `python3 tests/contrato/go_integration.py`, sem `-I`. A forma com `-I` falha no import de `lib` antes do PostgreSQL e não conta como esse ensaio. Comparar só contagens não fecha o critério.

### B13 — importação e reversão — P0 — código na branch, testes de banco e publicação abertos

Entregue antes deste lote, lotes 21–23, commits `845212b`, `000e0f1`, `37abd06`, `eb11a58`, `c676c5b`, `db41585`, `e193266`:

- emissão de PSP recusa título com origem externa;
- reimportação explica divergência sem sobrescrever;
- reconciliação por lote, somente leitura, na interface oficial;
- `GET /api/import/batches/{id}/revert-eligibility` em `import_revert_eligibility.go`. `evidence.reverted` permanece falso. O GET não autoriza a escrita.

Lote 24, base `82c4251`: desenho e 22 casos `planned/not_run` em `docs/LOTE24-B13-ACEITACAO.json`. Esses dois arquivos continuam históricos. Análise documental (Sonnet 5.5 alto, relato 37) não é homologação.

Implementado na branch de desenvolvimento, HEAD `8c10c1a`, sem publicação: marcador append-only da migração 78, `finance.LockInvoices` com sal `7411005` antes do `FOR UPDATE` ordenado por id, `POST /api/import/batches/{id}/compensate` idempotente que revalida, leitura `compensation` `absent` ou `committed`, ficha oficial sem apagar histórico, inventário estático em `apps/api-go/rotas.json`, contratos dos 22 casos e jornada de browser escrita. Alcance só `invoices`. Sem devolução PSP e sem liberar `external_id`. O procedimento operacional está em `docs/importacao-csv.md`. O relatório do lote é `docs/LOTE25-B13-COMPENSACAO.md`.

Quatro estados, separados de propósito:

| Estado | B13 nesta branch |
|---|---|
| Implementado | Sim, no clone de desenvolvimento `8c10c1a`. Não é tag nem deploy. |
| Testado | 22 casos e o GET before/after/replay estão escritos e `executado: false`. O relato do runner cita quatro unitários sem banco. Skip por falta de PostgreSQL não aprova. A forma `python3 -I` falha no import de `lib` e também não aprova. Browser não executado. |
| Homologado | Sem prova. Exportação real de provedor continua em B18. |
| Publicado | Não. CI de `e193266` não foi reconsultado e não cobre este HEAD. |

A última revisão da jornada de browser usou Sol 6.1 medium porque a cota de Sonnet 5.5 high estava comprovadamente esgotada. A revisão principal não está ativa para essa fatia. O script cobre três defeitos de jornada (reimportação identificável, bloqueio 409 sem usar o GET antigo, ficha estreita que não dispara POST ao cancelar) e o commit com resposta perdida. O código do teste não é a execução. Não há screenshot `import-compensacao` nas evidências.

Aberto: executar de verdade, em laboratório PostgreSQL descartável, com container, porta e prefixo exclusivos:

- `python3 tests/contrato/nativo.py`
- `python3 tests/contrato/go_integration.py`

Sem `-I`, na raiz do repositório. `python3 -I tests/contrato/nativo.py` e `python3 -I tests/contrato/go_integration.py` foram reproduzidos nesta worktree com exit 1 e `ModuleNotFoundError: No module named 'lib'` em `nativo.py:13` e `go_integration.py:11`, antes do laboratório. Essa falha de bootstrap fica registrada à parte do skip por ausência de PostgreSQL. Não é teste de banco aprovado e não substitui os dois comandos acima. Os scripts de contrato não foram alterados.
- em `apps/api-go`, com as URLs desse laboratório, `go test -count=1 -run TestImportCompensate ./internal/modules/escrita/`
- no mesmo ambiente, `go test -count=1 -race -p 1 ./internal/finance/ ./internal/outbound/ ./internal/modules/escrita/ ./internal/modules/leitura/`
- browser pelo harness `NEXO_E2E_ONLY=frontend-v0-import.mjs python3 tests/contrato/e2e.py`

`go test -race ./...` do workflow, sem URL de banco, não substitui esses comandos. Publicação exige o job `verificar` de `.github/workflows/native.yml` verde nesse commit, com os contratos que sobem PostgreSQL, mais revisão independente. Homologação com dado real é B18.

Dependências internas já presentes: B03, B04 e a elegibilidade do lote 23. B12 de restore de host não bloqueia o teste sintético; bloqueia o piloto com dado real. O detalhe dos cinco ramos de escritores, do registro da rota e do inventário está no relatório do lote 25. Nenhum critério desse escopo foi descartado.

### B14 — fiscal e NFCom — P0 somente se o fiscal estiver ativo — escopo não ativado

Não existe `services/fiscal-adapter`. CSV contábil (FI-13) não emite nota. DICI (AD-18) não transmite à ANATEL. Os relatórios financeiros de 23 e 24/10 tratam NFCom modelo 62 como política separada do boleto e citam decreto de Pernambuco como referência legal, não como habilitação deste produto. Não há CNPJ, UF, certificado ou parecer de contador no clone.

Causa: escopo real não documentado. Não inventar emissão, CSC, série nem ambiente de homologação da SEFAZ. Dependência externa: responsável fiscal define documento, UF, regime e emissor. Gate de fechamento, sem comando neste clone: registro versionado e sem segredo, com a frase “fiscal inativo neste piloto” ou com o escopo real (UF, documento, emissor e CNPJ). “Inativo” fecha o critério como não aplicável. O escopo real é a única autorização para tarefa de emissor. Enquanto o registro não existir, B14 fica aberto e sem tarefa de código. Não há teste de XML antes dessa decisão.

Validação futura, só depois da decisão: XML inválido bloqueia, timeout consulta sem segunda emissão, XML e protocolo sobrevivem a restore. Homologação é credenciamento na UF, outro gate.

### B15 — WhatsApp e régua — P1 — canal HTTP genérico, Cloud API ausente

Existem avisos, modelos e `apps/web/features/admin/message-channels.tsx` (canal com nome e Authorization). Não há adapter da Cloud API da Meta, WABA, template aprovado nem dedupe de delivery específico de WhatsApp no código Go pesquisado. Régua que cancela envio porque o título foi pago antes do send não foi evidenciada como fechada para WhatsApp.

Causa: falta conta WABA e falta o adapter. Webhook falso, assinatura e dedupe podem ser internos e ainda não estão entregues como esse adapter. Dependência de B05 para não avisar dívida já recebida. Próximo recorte interno, quando autorizado: um emissor com idempotência e opt-out, gateway desligado por padrão, sem número real. Homologação: template e número do operador. Validação: teste de contrato com HTTP falso; repetir não cria segunda mensagem.

### B16 — atendimento e Chatwoot — P2 — CRM próprio entregue, Chatwoot ausente

A matriz CR-01 a CR-09 está integrada na interface oficial (chamados, protocolo, OS vinculada). Não há adapter Chatwoot. Desligar uma integração que não existe não é o critério. O atendimento nativo não foi revalidado nesta sessão.

Aberto: Chatwoot só com conta e inbox do operador. Causa: sem pacote e sem demanda que substitua o CRM já entregue. Prioridade P2. Não abrir tarefa enquanto B13, B01 e B12 de restore não avançarem, salvo pedido explícito. Gate de fechamento, sem comando neste clone: registro versionado e sem segredo da decisão do operador, “Chatwoot demandado” ou “Chatwoot não demandado”. A segunda fecha o critério como não aplicável. A primeira só então autoriza o teste futuro com HTTP falso, isolamento account/tenant, evento sem loop, telefone que não vira identidade e ação financeira permanecendo no Nexo. Sem o registro, o critério permanece aberto.

### B17 — topologia — P2 — mapa operacional parcial

IN-04, IN-05 e IN-09 estão implementadas na matriz (CTO/CEO, porta, mapa de contratos, POPs e caixas). IN-06, projeto físico completo, permanece parcial. Não há, neste mapa, prova de versionamento draw.io, grafo com ciclo rejeitado no servidor e corpus de desempenho. Geometria de mapa não altera a rede sozinha; o lote de integração já separa isso.

Causa do que falta: especificação de projeto físico além do mapa operacional, sem bancada óptica. Prioridade P2. Próximo recorte pequeno, interno: um contrato de servidor que recuse porta ocupada, ciclo e tenant cruzado na API já existente de FTTH, com teste Go, sem canvas novo. Homologação de campo continua sem prova. Validação: teste de isolamento no lab PostgreSQL; `e2e/frontend-v0-map.mjs` e `frontend-v0-ftth.mjs` quando a UI mudar.

### B18 — release e piloto — P0 — CI relatado, piloto não iniciado

`docs/PILOTO.md` lista decisões em aberto: provedor, grupo, fonte da verdade, DNS, MFA, ensaio de corte e reversão, homologação de acesso, backup externo, monitor e encerramento. Nenhum item desse roteiro está marcado com evidência. `docs/pendencias.md` repete gateway real, fiscal, PPPoE físico, dados reais e monitor externo.

O workflow `native.yml` é o gate de release de código. O relato de 28/10 em `00_STATUS.md` atribui CI aprovado nas duas branches ao commit `e193266` (runs 40717836379 e 40717831261). Esta reconciliação não reconsultou esses runs. O merge documental `82c4251` não tem, no mesmo relato, push nem CI. Não houve deploy.

Aberto: piloto com responsável, janela e grupo reversível; restore ensaiado; reconciliação de saldos; H separado de C/T nas notas de release. Causa: sem operador e sem ambiente definitivo. O código de compensação B13 está na branch e ainda depende do lab. Seguem abertos o SBOM e o lab de restore. Validação de código antes de tag: o workflow nativo inteiro em runner com PostgreSQL, mais `git diff --check`. Skip de banco reprova a publicação. Homologação e piloto são os checklists de `PILOTO.md`, com evidência sem segredo. Ausência de provedor não fecha o piloto.

## Continuação depois do lote 25

O lote 25 não encerra o projeto e não está publicado. A gerência continua por eventos, sem pedir nova ordem e sem duplicar plano ou tarefa já concluídos.

1. Executar os testes reais do B13 no laboratório descartável nomeado em `docs/LOTE25-B13-COMPENSACAO.md`. Corrigir falha de código ou de ambiente. Não alterar teste para esconder falha. Revisão independente na fila. Integrar a branch de desenvolvimento só depois disso. `go test` que faz skip por falta de PostgreSQL não conta como aprovado.
2. Escolher o próximo recorte interno ainda aberto. O candidato já listado é o SBOM de B01, no gate de build, sem `audit fix` cego. Não reimplementar a compensação.
3. Ensaio de restore em host vazio (B12), conduzido pela gerência, quando esse for o recorte escolhido.
4. Homologações Efí, OLT, NAS, fiscal e piloto permanecem sem tarefa de produção enquanto o recurso externo não existir. Inter e NFCom não ganham código até demanda e escopo reais. Não fechar esses itens só porque o recurso falta. Default, sandbox e gate desligado não são homologação.

Gates que continuam obrigatórios para qualquer publicação: `python3 tests/contrato/nativo.py` e `python3 tests/contrato/go_integration.py`, sem `-I`, em PostgreSQL descartável. Falha por ausência de banco fica registrada como não executada, nunca como aprovada. Falha de `python3 -I` no import de `lib` é bootstrap, também não executada como laboratório, e não aprova o gate. O mapa integral preserva B01–B18. Não há percentual. O projeto permanece aberto enquanto existir critério aberto. O lote 25 não está publicado.
