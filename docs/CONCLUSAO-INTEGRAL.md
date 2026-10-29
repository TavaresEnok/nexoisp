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

Cinco camadas permanecem separadas: código no clone, execução local com comando e exit, CI hospedado com status e instante da fonte, publicação de candidata numa branch de desenvolvimento, e homologação no ambiente do responsável. Branch candidata verde não é `main`, não é deploy e não é homologação. Skip não é execução. Desenho não fecha critério de código.

Não há percentual. Critério sem prova fica aberto, com causa, dependência, evidência faltante e comando de validação. Skip de `tests/contrato/nativo.py` ou `tests/contrato/go_integration.py` por falta de PostgreSQL não é teste de banco aprovado. A invocação executável é `python3 tests/contrato/nativo.py` e `python3 tests/contrato/go_integration.py`, na raiz do repositório, sem `-I`, como em `.github/workflows/native.yml`. A redação original destes dois arquivos, na base `82c4251`, não executou esses dois comandos. `python3 -I` nos mesmos scripts falha com `ModuleNotFoundError: No module named 'lib'` antes do laboratório; essa falha de bootstrap não é skip de banco e não aprova o gate. A gerência, depois, executou os dois sem `-I` na base `cc542a1`. O resultado está em B01, B12 e B13 e em `docs/LOTE26-VALIDACAO-B13-SBOM.md`. Na base `0086558` o HTTP avançou além do fixture PSP e terminou exit 1 no campo opcional, e o restore sintético terminou exit 0. Exit 1 ou comando interrompido não passa o gate. Publicar ainda exige a invocação sem `-I` no commit candidato.

## Autorização, custo e franquia

- Continuar de forma autônoma depois de cada lote até o mapa integral fechar. Não parar no fim do lote como se o projeto tivesse terminado.
- Executor exclusivo: Grok 4.7 médio. Revisão independente: Sonnet 5.5 alto, ou Sol médio somente quando a cota do revisor principal estiver comprovadamente indisponível. Custo adicional zero, pela assinatura já em uso.
- Sem franquia. A decisão comercial já foi tomada: não implementar cota ou franquia de consumo. Telemetria RADIUS entregue no lote 20 permanece observação, sem política comercial de bloqueio por franquia.
- Sem PSP real e sem produção neste ciclo de reconciliação. Históricos de lote, inclusive `docs/LOTE24-B13-DESENHO-COMPENSACAO.md` e `docs/LOTE24-B13-ACEITACAO.json`, permanecem intactos.
- Interbancário só entra com demanda explícita. Fiscal só entra com escopo real (UF, documento, emissor, CNPJ). Nenhum dos dois está habilitado neste clone.

## Base e o que esta reconciliação não refez

HEAD do clone: `82c4251`, merge de `9fe63f0` (lote 24, só documentação do B13) sobre `e193266` (lote 23, elegibilidade de reversão somente leitura). O relatório histórico `00_STATUS.md` de 29/10/2026 registra o lote 24 como documental, sem push nem deploy, e o último código funcional publicado como lote 23 / `e193266`, com CI hospedado citado nas duas branches. Esta reconciliação não consultou de novo o GitHub Actions. Os identificadores de run abaixo são relato daquele arquivo, não observação nova. Essa frase cobre a redação de `82c4251` e os runs `40717836379` e `40717831261`. O lote 32, mais abaixo, registra uma leitura posterior sem token, só do run `40877414874`. Essa leitura não reescreve os runs antigos.

A reconciliação de 29/10 que gravou estes dois arquivos, na base `82c4251`, executou somente os três testes documentais daquele pedido. Não abriu conta, certificado, equipamento, backup de produção nem banco de laboratório. A branch de desenvolvimento avançou depois disso até `8c10c1a`, com o código do lote 25, em seguida até `cc542a1` (lote 26) e `e2f3b18` (lote 27, fixture PSP `b67d2f3` e harness de restore `56b2187`). A prova real do lote 27 está na base `0086558d9296054cfaf89071c9ae1bf0f2f56571`. O HEAD documental do lote 28 é `027e4615691452e35df11522ac373103ed346a1f`: a expectativa do campo opcional em `9c764d7` e o desenho do corte B04 em `728f2ff`. A worktree de desenvolvimento deste gate documental está em `ab6166a93059169155c660376a2de8a93311770b` e contém a base de sombra do lote 29. Esse HEAD não é publicação, não é `main` e não é deploy. B01 conserva a prova local de `cc542a1`. B04, B12 e B13 abaixo usam a leitura de `0086558`, do desenho e do relato posterior em `55e0d29`. Os demais itens B01–B18 conservam a leitura da base `82c4251`, salvo a frase de dependência do piloto em B18. Não se reabre lote já concluído para implementá-lo de novo.

Documentos de lote no clone: `docs/LOTE01` a `LOTE16`, `LOTE18`, `LOTE19` e `LOTE24`. Os recortes 17 e 20–23 estão nos relatórios externos 30–36 e nos commits do clone; a ausência de `docs/LOTE17.md` não apaga a entrega. Os lotes 29, 30 e 31 da leitura B04 estão em `docs/LOTE29-B04-BASE-SHADOW.md`, `docs/LOTE30-B04-PROVAS-POSTGRES.md` e `docs/LOTE31-B04-GATES-EXPLAIN-RLS.md`. O lote 32 está em `docs/LOTE32-B04-ACEITE-B15-DESENHO.md`. O lote 33 está em `docs/LOTE33-B15-OFFLINE.md`. A auditoria de snapshots permanece em `docs/evidencias/B04-GATES-6963214-AUDIT.json` e não é editada por este mapa. O plano 29 permanece DONE 13/13 na base `5ca3036`. O plano 30 `8b78eab07512` permanece DONE 4/4. O plano 31 permanece DONE na base `6963214927aa45ae1963c58d4c14ba540d78c2f0`. A corrida real `7cde1e623462ec49c9fe75ca588e25c75a62dd5b` terminou exit 1. O código das duas correções de prova está no merge `996d28f49d2c49753d8f3ca741d4232c5ef2b08a`. A prova local posterior e o aceite por critério estão no commit `d37603f`. O desenho Cloud API está no commit `6ca6d21`. Esses heads são branch de desenvolvimento. Relatórios lidos em `/home/enok/Documentos/projetos/resultados-analise-nexoisp`: `00_STATUS.md`, `08_BACKLOG_EXECUTAVEL.md`, `11_COMPLEMENTO_REVISAO.md`, `31` a `37`. O complemento de 25/10 descreve o mundo anterior a B02–B13; onde o código posterior existe, o complemento fica histórico.

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
- Isolamento tenant, POP, portal e suporte está desenhado nas rotas financeiras, de importação e de RADIUS dos lotes 10, 16, 18, 19 e 23. A compensação do lote 25 usa o mesmo recorte no POST e no GET. Em `cc542a1`, `python3 tests/contrato/go_integration.py` terminou exit 0, com 241 ações pass. O browser dirigido da mesma base também terminou exit 0. Essas duas provas e o SBOM local permanecem datados em `cc542a1`. O contrato HTTP `nativo.py` morreu antes de concluir nessa base e, de novo, na base `0086558`, depois do fixture PSP e antes dos 22 casos. A gerência relata depois, no commit `55e0d29`, exit 0 com 24 checks, incluindo B13 e financeiro. Esse relato não foi repetido neste gate documental e não preenche a matriz B04. O CI hospedado `40840682617`, no mesmo `55e0d29`, falhou no depguard dos testes. A corretiva está em `92535ed`. Essa falha permanece histórica. O run posterior `40877414874`, na branch `dev/lote31-b04-pg-validado-6963214` e no SHA `6963214`, concluiu `success` em `2026-10-29T13:11:42Z`, leitura pública sem token às `2026-10-29T13:21:13Z`. O snapshot imutável das `2026-10-29T12:56:16Z` ainda diz `in_progress`. Esse verde é CI da candidata, não de `main`, não de deploy e não dos commits documentais `d37603f` e `6ca6d21`. O CI relatado de `e193266` não cobre `cc542a1`, `0086558`, `027e461` nem `ab6166a`. Skip sem PostgreSQL não aprova.
- Segurança de sessão: cookie HttpOnly, CSRF e MFA existem no código e na matriz AC-01/AC-08/BE-20. Revisão independente de segurança e sessão com leitor de tela continuam na lista de `docs/pendencias.md`, sem prova nova.
- Acessibilidade: `apps/web/tests/audit-remediation.json` registra `completion: partial` no checkpoint de 18/10/2026. Não há suíte axe como gate do workflow. T-UI-01 do backlog (teclado até erro e ação, 503 sem amostra) não tem corrida registrada nesta reconciliação.
- Operação: `infra/monitoring/alerts.yml` e `prometheus.yml` definem alertas de API, fila e jobs. `docs/PILOTO.md` e `docs/pendencias.md` ainda exigem monitor externo no host do provedor, preflight `./nexo prod db preflight` e canal do responsável. Artefato no repositório não é monitoramento publicado.
- Runtime pinado no clone: Node `>=22.23.4 <23` (`.nvmrc` `22.23.4`), npm `>=10.9.9 <11`, Go `1.27.3` em `apps/api-go/go.mod`. O SBOM CycloneDX não é arquivo versionado. A geração local de `cc542a1` está em B01.

## B01–B18

Prioridade herdada do backlog executável. “Entregue” significa implementação presente e teste local ou de CI relatado no escopo daquele lote. Homologação externa e produção permanecem abertas em todos os itens que dependem de banco, PSP, fisco, equipamento ou piloto.

### B01 — build, dependências e SBOM — P0 — geração local feita, CI hospedado aberto

Implementado no clone: engines em `package.json`, Go 1.27.3, workflow `native.yml` com build, vet, `go test -race`, golangci-lint 2.14.0, npm ci, typecheck, testes web e build. Commit de Backup-center `e5c39eb` trava dependências Python à parte. O lote 26 acrescenta `scripts/generate-sbom.sh`, `scripts/validate-sbom.py`, `docs/SBOM.md` e o passo que grava o artefato `sbom-cyclonedx` no job `verificar`. Commit `e1b17d8`, presente em `cc542a1`. Os JSON em `sbom/` não entram no código versionado.

Gerado de verdade na base `cc542a1b502b9b78bdd0673140bbba0f15a89716`, exit 0, run `local-l26-cc542a1`. Go: 52 componentes, SHA-256 `f8090a025b2555058213d0fc4684a5000d9795afb81cfa1d904b6a2c63cc84ac`. npm: 1075 componentes, incluindo aninhados, 754 no topo, SHA-256 `003f12bca69988957ac9fb068d5f4ef41f890bced7f9a07501b788dc39d3e9bd`. Os dois arquivos guardam esse commit e esse run. Cópia em `/home/enok/Documentos/projetos/implementacao-codex/lote26-validacao-b13-sbom-2026-10-29/evidencias/sbom-cc542a1/`. O aviso de peers WASM opcionais no `npm ls` está no log e não esvazia o lockfile. Não houve `audit fix`.

Aberto: o gate do CI hospedado e o artefato `sbom-cyclonedx` de um run do commit candidato. `hosted_ci_verified` no resumo é falso. O CI de `e193266` e qualquer geração da base `6f4bf38` não validam `cc542a1`. A corrida `0086558` não gerou outro SBOM e não confere esse CI. Triagem de advisories npm/Go não foi refeita. Este SBOM não prova imagem publicada nem deploy.

Causa do que falta: o arquivo do workflow não substitui o run. Dependência: nenhuma conta externa. Próximo passo: no commit candidato, conferir o job `verificar` e o artefato hospedado, sem `audit fix` cego. Validação: checkout limpo, `go version` igual a `go 1.27.3`, `node -v` igual a `v22.23.4`, commit e run dentro dos dois CycloneDX. Gate de publicação: o mesmo workflow com PostgreSQL descartável; skip de banco não aprova o job.

### B02 — idempotência da baixa manual — P0 — entregue no código

`POST /api/invoices/:id/manual-payment` exige `intent_id`. Migração `db/migrations/00064_manual_payment_intents.sql`, commit `dc21fd1`. UI em `apps/web/features/finance/actions.tsx`. Evidência histórica: `docs/LOTE01-CONSOLIDADO.md` (100 replays, perda de resposta após commit) e o passo de `nativo.py` no workflow. Homologação bancária não se aplica a este mecanismo. Produção não publicada. Não reabrir o lote 01.

Antes de publicar lote futuro que mexa em baixa: repetir `python3 tests/contrato/nativo.py`, sem `-I`, em laboratório descartável. Esta reconciliação não o fez. A forma com `-I` falha no import de `lib` e não alcança o banco.

### B03 — contas financeiras — P0 — entregue no código, sem conta real

Migração `00065_financial_connections.sql`, commit `f3a5b8e`, `apps/api-go/internal/finance/connections.go`, UI `apps/web/features/admin/financial-connections.tsx`. Lote 02. Contratos de migração no `native.yml` (`financial_connections_migration.py`). Nenhuma conta Efí, Asaas ou Inter real foi cadastrada. Backfill ambíguo continua bloqueante se aparecer em instalação; não há evidência de backfill produtivo.

Aberto só a homologação: conta sandbox por tenant, ambiente e credencial, fora deste lote. Validação interna já nomeada: `python3 tests/contrato/financial_connections_migration.py` com `NEXO_PAYMENT_LAB=1` no lab da gerência.

### B04 — ledger e shadow-read — P0 — critérios parciais em 6963214, allowlists vazias, corte fechado

Migração `00066_financial_movements.sql`, commit `5327528`. Sombra `financial_balance_shadow` é lida em testes de devolução. `docs/LOTE03-B04-MOVIMENTOS.md` define a comparação nominal, pago, residual, excesso e cobrável. O corte permanece fechado: discrepância impede a troca.

O lote 28, commit `728f2ff`, acrescenta a preparação em `docs/B04-DESENHO-CORTE-LEITOR.md` e a matriz em `docs/B04-ACEITE-CORTE-LEITOR.json`. A gerência registra revisão Sonnet desse desenho. Essa revisão não carimba teste. O aceite mantém `implementado` falso, `corte_autorizado` falso e cada critério com `executado` falso. Allowlists de `shadow` e de `cut` nascem vazias no desenho.

O lote 29, worktree `ab6166a`, coloca no clone o núcleo I1, os ganchos, as nove variantes e o GET due de uma sentença. `NEXO_BALANCE_READ` existe. As allowlists compiladas continuam mapas vazios, então `off`, `shadow` e `cut` servem a sentença legada. O inventário, os donos e as provas estão em `docs/LOTE29-B04-BASE-SHADOW.md`. Neste gate documental o módulo `apps/api-go` compilou com `go build ./...` exit 0 e `go test -count=1 ./internal/modules/leitura/` terminou exit 0 em 0,031 s. Essa suíte não abre PostgreSQL. `EXPLAIN` não rodou. A matriz continua pendente. Produto, schema, grants, escritores, SQLs legados e UI não mudam neste gate.

Na base `0086558`, uma leitura somente de diagnóstico com papel `nexo_go` não privilegiado comparou a sombra no dataset do nativo interrompido. O artefato é `/home/enok/Documentos/projetos/implementacao-codex/lote27-b13-http-restore-2026-10-29/evidencias/b04-comparacao-sintetica-0086558.json`. O tenant alfa tinha 23 faturas, 23 linhas de sombra e zero divergência. O tenant beta estava em zero. Acordos estavam em zero nos dois. `cutover_authorized_by_this_evidence` é falso. A primeira consulta de acordo errou porque `source_unproven` pertence à view `financial_agreement_shadow`, não a `agreements`, e não alterou dados. Vinte e três faturas e zero acordos não cobrem acordo comprovado, `source_unproven`, estorno, excesso, refund, importação, compensação, rollback, RLS de portal e POP nem drift injetado. Essa prova limitada e o desenho novo não ativam o corte.

No gate do lote 29 o corte seguia fechado até a matriz ter execução própria em banco fresco e revisão independente da inclusão de um leitor. A base de sombra já estava no clone e a allowlist de corte continuava vazia. A suíte local de `leitura` e a compilação de `ab6166a` não substituíam `financial_movements_migration.py` nem `nativo.py`. O CI `40840682617` tinha falhado. A corrida `6963214` e o run `40877414874` estão nos parágrafos do lote 32, mais abaixo. A comparação de `0086558` continua fora do aceite. A migração 66 não se reimplementa. Os movimentos permanecem.

O lote 30 acrescentou as provas PostgreSQL da consulta dedicada, das oito variantes e do GET due. A gerência executou `python3 tests/contrato/go_integration.py` com `NEXO_BALANCE_READ_PG_REQUIRED=1` na base `7cde1e6`. O runner terminou exit 1, com 356 ações `pass`, falha de `TestBalanceReadPGExplain` e do pacote `leitura`, e zero `skip` nos testes PostgreSQL novos. Due, oráculo/RLS da consulta e as oito variantes em `nexo_go` passaram. O plano natural usou `invoice_movements_invoice` e `payments_tenant_invoice_identity_uq` com `Index Cond ((tenant_id = i.tenant_id) AND (invoice_id = i.id))`; o verificador daquela base exigia o nome `payments_invoice`. Evidência em `/home/enok/Documentos/projetos/implementacao-codex/lote30-b04-provas-postgres-2026-10-29/evidencias/gate-summary-7cde1e6.json`. Essa corrida permanece reprovada.

O lote 31, commits `e62ce32` e `be70bd2`, merge `996d28f`, corrige a prova e a compõe em `docs/LOTE31-B04-GATES-EXPLAIN-RLS.md`. A raiz do EXPLAIN aceita índice equivalente quando o mesmo scan correlaciona `invoice_id` e `tenant_id` e o catálogo confirma índice válido, pronto e capaz de buscar a fatura, inclusive a unicidade da migração 74. O nome isolado continua recusado e `enable_seqscan=on` permanece obrigatório. A raiz das variantes acrescenta `TestBalanceReadPGVariantsApp` com `set local role nexo_app` e conserva `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty` e `TestBalanceReadPGVariantsRLS` em `current_user=nexo_go`. Os arquivos são disjuntos. Produção, schema, índices, grants e allowlists não mudam. O texto de `explain-indices` no aceite e no desenho foi ajustado na raiz `e62ce32` e continua com `executado` falso; este gate documental não edita esses dois arquivos.

Neste gate documental, sem URL e sem `NEXO_BALANCE_READ_PG_REQUIRED`, `go -C apps/api-go build ./...` terminou exit 0 e `go -C apps/api-go test -count=1 -race -run '^TestBalanceRead|^TestDue' ./internal/modules/leitura` terminou exit 0 em 1,169 s e, na repetição do mesmo filtro, em 1,161 s. Sete testes de SQL ficaram em skip, entre eles `TestBalanceReadPGExplain` e `TestBalanceReadPGVariantsApp`. `TestBalanceReadPGExplainVerifier` passou em memória sobre o JSON capturado de `7cde1e6`. Esse `PASS` é revisão da regra. A prova nova, naquele momento, era `NEXO_BALANCE_READ_PG_REQUIRED=1 python3 tests/contrato/go_integration.py`, sem `-I`, no HEAD integrado. Até o log dessa corrida, a matriz e o `EXPLAIN` permaneciam abertos. O parágrafo seguinte registra a corrida que ocorreu depois.

O lote 32 lê a corrida real da base `6963214927aa45ae1963c58d4c14ba540d78c2f0`, registrada pela raiz `d37603f` em `docs/B04-ACEITE-CORTE-LEITOR.json` e em `docs/evidencias/B04-GATES-6963214.json`. A fonte imutável é `implementacao-codex/lote31-b04-gates-explain-rls-2026-10-29/evidencias`. `NEXO_BALANCE_READ_PG_REQUIRED=1 python3 tests/contrato/go_integration.py` terminou exit 0, com 370 ações `pass` e zero falha. O carimbo do comando no espelho é `2026-10-29T12:55:58.487575+00:00`. `gate-go-summary-6963214.json` registra os mesmos 370 e zero falha em `2026-10-29T12:52:51.344675+00:00`. Os PostgreSQL novos da leitura têm 19 ações `pass` e `new_pg_skips` 0, incluindo os sete testes SQL `TestBalanceReadPGDue`, `TestBalanceReadPGFixturesOracleAndRLS`, `TestBalanceReadPGExplain`, `TestBalanceReadPGVariants`, `TestBalanceReadPGVariantsEmpty`, `TestBalanceReadPGVariantsRLS` e `TestBalanceReadPGVariantsApp`. `python3 tests/contrato/nativo.py` terminou exit 0 com 25 grupos e 22 casos B13 no grupo de compensação. `nativo-6963214.json` marca `ok` verdadeiro.

Treze critérios dessa matriz ficam executados: `estado-open`, `estado-paid`, `estado-reconciling`, `estado-canceled`, `acordo-comprovado`, `refund-psp`, `compensacao`, `rollback`, `rls-tenant-portal-pop`, `drift-injetado`, `explain-indices`, `variante-shadow-isolada` e `flag-fechada`. Seis permanecem abertos: `acordo-nao-comprovado`, `estorno`, `excesso`, `importacao`, `matches-falso-bloqueia-corte` e `sem-fallback-silencioso`. `allowlist_shadow` e `allowlist_cut` continuam vazias. `balanceReadDatabaseGate` continua `pending`. `corte_autorizado` continua falso. `flag-fechada` prova o modo legado com as listas vazias. O gate de inclusão é `matches-falso-bloqueia-corte` e continua aberto, separado dessa prova. A lista dos treze não promove leitor.

A candidata `dev/lote31-b04-pg-validado-6963214` tem o run `40877414874`. O arquivo `ci-run-6963214.json` guarda `in_progress` e `conclusion` nula às `2026-10-29T12:56:16Z`, com `verificar` ainda em andamento. A leitura pública sem token às `2026-10-29T13:21:13Z` viu `completed` / `success`, `updated_at` `2026-10-29T13:11:42Z`, job `verificar` `success` no mesmo instante e job `agente` `success` às `2026-10-29T12:56:29Z`. O passo de migração 65 para 66 aparece `success` nessa segunda leitura. O verde vale para o SHA `6963214`. Não vale para os commits documentais posteriores, para `main`, para deploy nem para homologação. Não fecha os seis critérios abertos nem o run histórico `40840682617`. O detalhe está em `docs/LOTE32-B04-ACEITE-B15-DESENHO.md`.

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

### B12 — backup, restore e Backup-center — P0 — ensaio sintético exit 0 em 0086558, critérios externos abertos

No NexoISP existem `scripts/backup.sh`, `scripts/backup-manifest.py`, `scripts/restore-verify-prod.sh`, `scripts/restore-isolation.sql` e `apps/api-go/internal/db/restore.go`. No irmão `/home/enok/Documentos/projetos/Backup-center`, HEAD `2e410d2` (26/10/2026). O commit `118df92` altera diagnóstico, limites de ZIP e testes de integridade. Esses dois SHAs e os testes `tests/test_backup_integrity_isolated.py` e `tests/test_backup_executor_integrity_lab.py` pertencem ao repositório Backup-center. `git cat-file` neste clone não os resolve. `CONSOLIDACAO_LOTE01.md` desse repositório relata 258 testes Linux e fluxo sintético SQLAlchemy/PostgreSQL/Redis/Celery, e afirma que integridade de arquivo não comprova restauração completa. Nenhum push ou produção. Esta reconciliação não reexecutou essa suíte e não a encerra por inferência.

O complemento de 25/10 dizia que duas falhas de integridade continuavam abertas. O commit posterior `118df92` é a evidência de correção reivindicada; sem reexecução aqui, o mapa marca “teste histórico no relatório de consolidação”, não “reprovado” nem “homologado”.

Entregue no lote 27, commit `56b2187`: `tests/contrato/restore_clean_host.py`, `tests/operacao/test_restore_clean_host.py`, o passo `python3 tests/contrato/restore_clean_host.py` em `.github/workflows/native.yml` e o roteiro `docs/RESTORE-LAB-HOST-LIMPO.md`. O unittest estático dessa entrega rodou 13 testes e terminou OK. Ele só recusa identidade herdada e artefato manipulado. Não abre Docker e não aprova B12. No worker que entregou o harness, `docker` estava ausente. Essa frase descreve a entrega, não a corrida posterior.

A gerência executou o harness na base `0086558d9296054cfaf89071c9ae1bf0f2f56571`. Exit 0. `ok` verdadeiro. Dezessete fases. Evidência rastreável, fora do clone: `/home/enok/Documentos/projetos/implementacao-codex/lote27-b13-http-restore-2026-10-29/evidencias/restore-clean-host-0086558.json`, `gate-summary-0086558.json` e `gate-restore-clean-host-0086558.log`. `static_approval` é falso. `published` é falso. O harness limpou os recursos da execução `30cf94629328`. O passo do workflow continua sem run hospedado.

Comprovado nessa corrida, em dois clusters sintéticos novos (`nexo-b12-src-30cf94629328` e `nexo-b12-dst-30cf94629328`, volumes e portas próprios, imagem `postgres:16-alpine`):

- backup com manifesto e soma, restore no cluster vazio e manifesto conferido;
- manipulação recusada (`checksum-manifesto` e `dump-manipulado`) e chave errada recusada;
- documentos por bytes, verify-restore e download HTTP com recusa entre tenants;
- isolamento e grants, login e sessão, portal e POP;
- fila persistida sem execução e retomada com jobs desligados;
- replay da compensação B13 sem nova reversão.

Aberto, separados de propósito. A causa do que falta não é autorização nem bancada do ensaio sintético, que já ocorreu:

- Host físico do piloto. O cluster vazio simulado não o substitui.
- Cópia externa, `NEXO_BACKUP_COPY` e cofre.
- RPO e RTO produtivo.
- Piloto.
- Exactly-once externo. A fila que permanece com jobs desligados prova persistência no laboratório.
- Testes do Backup-center citados acima. Não foram executados e não moram neste clone.
- Run hospedado do passo em `native.yml` no commit candidato.

Proibido apontar restore para configuração herdada de produção. Comparar só contagens não fecha o critério. `python3 -I tests/contrato/go_integration.py` falha no import de `lib` e não é este ensaio. Não reimplementar o harness. Não repetir `0086558` só para registrar de novo o mesmo exit 0.

### B13 — importação e reversão — P0 — nativo relatado em 55e0d29, CI hospedado aberto

Entregue antes deste lote, lotes 21–23, commits `845212b`, `000e0f1`, `37abd06`, `eb11a58`, `c676c5b`, `db41585`, `e193266`:

- emissão de PSP recusa título com origem externa;
- reimportação explica divergência sem sobrescrever;
- reconciliação por lote, somente leitura, na interface oficial;
- `GET /api/import/batches/{id}/revert-eligibility` em `import_revert_eligibility.go`. `evidence.reverted` permanece falso. O GET não autoriza a escrita.

Lote 24, base `82c4251`: desenho e 22 casos `planned/not_run` em `docs/LOTE24-B13-ACEITACAO.json`. Esses dois arquivos continuam históricos. Análise documental (Sonnet 5.5 alto, relato 37) não é homologação.

Implementado na branch de desenvolvimento desde `8c10c1a`, ainda sem publicação: marcador append-only da migração 78, `finance.LockInvoices` com sal `7411005` antes do `FOR UPDATE` ordenado por id, `POST /api/import/batches/{id}/compensate` idempotente que revalida, leitura `compensation` `absent` ou `committed`, ficha oficial sem apagar histórico, inventário estático em `apps/api-go/rotas.json`, contratos dos 22 casos e jornada de browser escrita. Alcance só `invoices`, no máximo 200 `created`. Sem devolução PSP e sem liberar `external_id`. `evidence.reverted` permanece falso. O procedimento operacional está em `docs/importacao-csv.md`. O relatório do lote é `docs/LOTE25-B13-COMPENSACAO.md`. A validação do lote 26 está em `docs/LOTE26-VALIDACAO-B13-SBOM.md`.

O lote 27, commit `b67d2f3`, altera só o setup HTTP do efeito de cobrança: conexão financeira sintética EFI sandbox do mesmo tenant e empresa, para o `financial_binding_guard` aceitar `gateway_charge_id`. O POST continua 409 `provider_issuance`. Uma tentativa anterior morreu com `FileNotFoundError: docker` antes do PostgreSQL. A corrida `0086558` passou desse fixture.

Nessa base, `python3 tests/contrato/nativo.py` terminou exit 1 em `tests/contrato/import_compensate_contract.py:369`. O resumo marca `earlier_psp_fixture_passed` verdadeiro e `http_22_cases_passed` falso. A causa é `KeyError: entity_id` na linha `error` do lote misto. `importResult` só serializa `entity_id` quando o id não é nil. A ausência é contrato válido. O log é `gate-nativo-0086558.log`, ao lado de `gate-summary-0086558.json`. O comando parou antes de terminar os 22 HTTP. Esta nota não marca caso anterior como passado.

O lote 28, commit `9c764d7`, corrige a expectativa: a linha `error` aceita `entity_id` ausente ou nulo e recusa id presente e não nulo. O commit está em `027e461`. Correção entregue e revisão não são exit 0. A gerência relata, no commit `55e0d29`, que já contém `9c764d7`, `python3 tests/contrato/nativo.py` terminou exit 0 com 24 checks, incluindo B13 e financeiro. Esse relato permanece histórico. O exit 1 de `0086558` permanece histórico. Na base `6963214`, `python3 tests/contrato/nativo.py` terminou exit 0 com 25 grupos, e o grupo de compensação inclui 22 casos B13. Fonte: `nativo-6963214.json`. Homologação e publicação em `main` continuam abertas. O CI `40840682617` permanece falha histórica. O run `40877414874` da candidata `6963214` concluiu `success` às `2026-10-29T13:11:42Z` e não homologa operador, conta nem equipamento.

Quatro estados, separados de propósito:

| Estado | B13 |
|---|---|
| Implementado | Sim, desde `8c10c1a`. O fixture PSP está em `b67d2f3`. A expectativa do campo opcional está em `9c764d7`. Não é tag nem deploy. |
| Executado | `python3 tests/contrato/go_integration.py` exit 0 em `cc542a1`: 241 ações pass, incluindo subtestes. Dentro delas, 58 ações de `TestImportCompensate*` passaram. O browser dirigido da mesma base, exit 0, cobre desktop, viewport 390, replay e um POST commitado cuja resposta perdida a UI recupera sem segundo estorno. `cc542a1` não foi substituída por `0086558` nessas duas provas. `nativo.py` exit 1 em `cc542a1` no fixture e exit 1 em `0086558` no campo opcional. O relato de 24 checks em `55e0d29` fica histórico. Em `6963214`, `nativo.py` exit 0 com 25 grupos inclui os 22 casos de compensação, e `go_integration.py` com `NEXO_BALANCE_READ_PG_REQUIRED=1` exit 0 tem 370 ações pass. Código de teste, revisão e skip não contam como essa execução. |
| Homologado | Sem prova. Exportação real de provedor continua em B18. |
| Publicado | `main` e deploy, não. A candidata `dev/lote31-b04-pg-validado-6963214` no SHA `6963214` tem o run `40877414874` com `conclusion=success` às `2026-10-29T13:11:42Z`. O CI de `e193266` não cobre esta base. O run `40840682617` permanece falha histórica. |

A última revisão da jornada de browser, no lote 25, usou Sol 6.1 medium porque a cota de Sonnet 5.5 high estava comprovadamente esgotada. A revisão principal não ficou ativa para essa fatia de código. O script cobre três defeitos de jornada (reimportação identificável, bloqueio 409 sem usar o GET antigo, ficha estreita que não dispara POST ao cancelar) e o commit com resposta perdida. Na base `cc542a1` o harness dirigido executou esses caminhos e terminou exit 0. As capturas estão em `/home/enok/Documentos/projetos/implementacao-codex/lote26-validacao-b13-sbom-2026-10-29/evidencias/browser-real-cc542a1/`. Não estão neste commit. A corrida não nomeia os 22 casos e não os declara passados.

O Go da mesma base cobre, com banco, os testes `TestImportCompensate_B13_01` a `B13_11`, `B13_13`, `B13_14`, `B13_16` a `B13_18`, `B13_21`, `B13_22`, a barreira de B13-11 e `TestImportCompensate_IdempotencyConflictAndCap`. B13-15 passou só no núcleo sem HTTP. B13-12 e B13-20 não têm ação nessa lista. O detalhe por caso está no aceite do lote 25. B13-03, B13-21 e B13-22 só possuem teste Go; essa execução os cobre. O arquivo `docs/LOTE25-B13-COMPENSACAO-ACEITE.json` permanece com o `executado` que já tinha. A corrida `6963214` é outra fonte: o nativo inclui o grupo dos 22 casos e terminou exit 0.

Aberto para homologação e para `main`: a base `0086558` passou do fixture PSP e parou no campo opcional; esse exit 1 fica no histórico. O job `verificar` da candidata `6963214` concluiu `success` no run `40877414874`. O run `40840682617` permanece vermelho. Compilação não substitui o contrato. `python3 -I` continua falha de bootstrap no import de `lib` e não é o gate. O contrato não foi alterado para esconder a falha de `cc542a1` nem a de `0086558`.

`go test -race ./...` do workflow, sem URL de banco, não substitui o `go_integration.py` já executado nem o `nativo.py` de `6963214`. Publicação em `main` exige o job `verificar` verde no SHA que for tag. O verde de `40877414874` vale para `6963214` na branch candidata. Homologação com dado real é B18.

Dependências internas já presentes: B03, B04 e a elegibilidade do lote 23. O ensaio B12 sintético de `0086558` não bloqueia o HTTP e também não o aprova. Host físico e dado real continuam bloqueando o piloto. O detalhe dos cinco ramos de escritores, do registro da rota e do inventário está no relatório do lote 25. Nenhum critério desse escopo foi descartado. Não reimplementar o lote 25, o lote 26, o fixture `b67d2f3` nem a expectativa `9c764d7`.

### B14 — fiscal e NFCom — P0 somente se o fiscal estiver ativo — escopo não ativado

Não existe `services/fiscal-adapter`. CSV contábil (FI-13) não emite nota. DICI (AD-18) não transmite à ANATEL. Os relatórios financeiros de 23 e 24/10 tratam NFCom modelo 62 como política separada do boleto e citam decreto de Pernambuco como referência legal, não como habilitação deste produto. Não há CNPJ, UF, certificado ou parecer de contador no clone.

Causa: escopo real não documentado. Não inventar emissão, CSC, série nem ambiente de homologação da SEFAZ. Dependência externa: responsável fiscal define documento, UF, regime e emissor. Gate de fechamento, sem comando neste clone: registro versionado e sem segredo, com a frase “fiscal inativo neste piloto” ou com o escopo real (UF, documento, emissor e CNPJ). “Inativo” fecha o critério como não aplicável. O escopo real é a única autorização para tarefa de emissor. Enquanto o registro não existir, B14 fica aberto e sem tarefa de código. Não há teste de XML antes dessa decisão.

Validação futura, só depois da decisão: XML inválido bloqueia, timeout consulta sem segunda emissão, XML e protocolo sobrevivem a restore. Homologação é credenciamento na UF, outro gate.

### B15 — WhatsApp e régua — P1 — canal genérico entregue, Cloud API interna desligada, PostgreSQL e CI deste lote abertos

Existem avisos, modelos e `apps/web/features/admin/message-channels.tsx` (canal com nome e Authorization). O lote 32, commit `6ca6d21`, base lida `6963214`, registrou o desenho e a matriz quando ainda não havia pacote nem migração 79. Esse texto permanece histórico em `docs/LOTE32-B04-ACEITE-B15-DESENHO.md`. A base documental ancestral conferida neste clone é `f42256b558288590f8e804b558982f15651981fb`. O objeto `33f42256b` não está no clone.

O lote 33 coloca no clone o MVP interno offline: cliente puro, migração `00079_cloud_notice_journal.sql`, tipos, consentimento, journal, status, webhook e worker. `generic_http` continua o caminho do canal já entregue. `NEXO_CLOUD_API` só habilita a trava com o valor `on`. `provenGraphVersions` de produção devolve vazio. `cloud_accounts.active` nasce falso e a migração não insere conta. Demo não abre o cliente. HTTP real à Meta não faz parte deste ciclo. `BodyParams` não vazio é recusado. `UnprovedAuthenticator.Proven` é falso e, sem decoder provado na instância, o webhook recusa sem escrita. O commit de `MarkWire` é a última barreira. O consentimento usa `FOR SHARE`. O terceiro estouro de `cloud_lock_timeouts` é terminal e não dispara HTTP. A retenção pode apagar `skipped_settled` e o grafo expirado, sem apagar dado financeiro. O adendo está no final de `docs/B15-DESENHO-CLOUD-API.md`.

Prova separada por camada. Em 2026-10-29, `go -C apps/api-go test -count=1 -v ./internal/outbound/cloudapi/` terminou exit 0 em 0,163 s, sem rede e sem PostgreSQL. As doze funções R1, de `TestCloudAPI_B15_C10` a `C16`, `C17`, `C18`, `C22`, `C23` e `C25`, imprimiram PASS. A matriz marca só esses doze como executados. R2, G e `B15-H01` continuam não executados. Presença de `Test` no arquivo não é a fonte. A gerência ainda precisa rodar `NEXO_CLOUD_PG_REQUIRED=1 python3 tests/contrato/go_integration.py`, sem `-I` e sem runner novo. Skip não aprova R2 nem G. `tests/contrato/cloud_notices_contract.py` foi ligado a `nativo.py` e esta reconciliação não executou esse laboratório. O CI `40877414874` permanece o verde de `6963214` na candidata e não cobre o lote 33. `main`, deploy, WABA, template, versão Graph e API real continuam abertos. O detalhe está em `docs/LOTE33-B15-OFFLINE.md`.

### B16 — atendimento e Chatwoot — P2 — CRM próprio entregue, Chatwoot ausente

A matriz CR-01 a CR-09 está integrada na interface oficial (chamados, protocolo, OS vinculada). Não há adapter Chatwoot. Desligar uma integração que não existe não é o critério. O atendimento nativo não foi revalidado nesta sessão.

Aberto: Chatwoot só com conta e inbox do operador. Causa: sem pacote e sem demanda que substitua o CRM já entregue. Prioridade P2. Não abrir tarefa enquanto B13, B01 e B12 de restore não avançarem, salvo pedido explícito. Gate de fechamento, sem comando neste clone: registro versionado e sem segredo da decisão do operador, “Chatwoot demandado” ou “Chatwoot não demandado”. A segunda fecha o critério como não aplicável. A primeira só então autoriza o teste futuro com HTTP falso, isolamento account/tenant, evento sem loop, telefone que não vira identidade e ação financeira permanecendo no Nexo. Sem o registro, o critério permanece aberto.

### B17 — topologia — P2 — mapa operacional parcial

IN-04, IN-05 e IN-09 estão implementadas na matriz (CTO/CEO, porta, mapa de contratos, POPs e caixas). IN-06, projeto físico completo, permanece parcial. Não há, neste mapa, prova de versionamento draw.io, grafo com ciclo rejeitado no servidor e corpus de desempenho. Geometria de mapa não altera a rede sozinha; o lote de integração já separa isso.

Causa do que falta: especificação de projeto físico além do mapa operacional, sem bancada óptica. Prioridade P2. Próximo recorte pequeno, interno: um contrato de servidor que recuse porta ocupada, ciclo e tenant cruzado na API já existente de FTTH, com teste Go, sem canvas novo. Homologação de campo continua sem prova. Validação: teste de isolamento no lab PostgreSQL; `e2e/frontend-v0-map.mjs` e `frontend-v0-ftth.mjs` quando a UI mudar.

### B18 — release e piloto — P0 — CI relatado, piloto não iniciado

`docs/PILOTO.md` lista decisões em aberto: provedor, grupo, fonte da verdade, DNS, MFA, ensaio de corte e reversão, homologação de acesso, backup externo, monitor e encerramento. Nenhum item desse roteiro está marcado com evidência. `docs/pendencias.md` repete gateway real, fiscal, PPPoE físico, dados reais e monitor externo.

O workflow `native.yml` é o gate de release de código. O relato de 28/10 em `00_STATUS.md` atribui CI aprovado nas duas branches ao commit `e193266` (runs 40717836379 e 40717831261). Esta reconciliação não reconsultou esses runs. O merge documental `82c4251` não tem, no mesmo relato, push nem CI. Não houve deploy.

Aberto: piloto com responsável, janela e grupo reversível; restore em host físico, além do ensaio sintético já registrado em `0086558`; reconciliação de saldos; H separado de C/T nas notas de release. Causa: sem operador e sem ambiente definitivo. O relato de `nativo.py` exit 0 em `55e0d29` é histórico. A corrida `6963214` tem `nativo.py` exit 0 com 25 grupos e Go exit 0 com 370 ações `pass`. O run `40840682617` permanece falha de depguard. O run `40877414874` da candidata concluiu `success` às `2026-10-29T13:11:42Z` e publica só a branch `dev/lote31-b04-pg-validado-6963214`. O SBOM local de `cc542a1` continua a geração local; este mapa não conferiu o artefato hospedado desse run. O exit 0 do cluster vazio não é o piloto. Homologação e piloto são os checklists de `PILOTO.md`, com evidência sem segredo. Ausência de provedor não fecha o piloto. Host físico, cópia externa, fiscal, extrato e WABA continuam abertos.

## Continuação depois dos lotes 25 a 32

Os lotes 25 e 26 estão entregues e não se reimplementam. O lote 27 entregou o fixture PSP e o harness. A base `0086558` executou o restore sintético com exit 0 e levou o HTTP além do fixture, até o campo opcional. O lote 28 corrigiu essa expectativa em `9c764d7` e desenhou o corte B04 em `728f2ff`, sem ativá-lo. O lote 29 deixa a base de sombra no clone, com allowlists vazias. Os lotes 30 e 31 permanecem DONE. A base `6963214` executou Go e nativo com exit 0. O lote 32 registra esse aceite por critério e o desenho B15. O lote 33 acrescenta o MVP interno offline, com R1 em sender falso e com R2, G, CI e publicação ainda abertos. Nada disso encerra o projeto, vira `main` ou homologa. A gerência continua por eventos, sem pedir nova ordem e sem duplicar plano ou tarefa já concluídos. Este executor não cria plano, agente nem submissão.

1. `python3 tests/contrato/nativo.py` na base `6963214` terminou exit 0 com 25 grupos, entre eles a compensação B13 com 22 casos. A base `0086558` passou do fixture PSP e parou em `entity_id` opcional. O relato de 24 checks em `55e0d29` fica histórico. Exit diferente de 0, onde ocorreu, permanece falha histórica.
2. O ensaio `python3 tests/contrato/restore_clean_host.py` na base `0086558` está registrado: exit 0, 17 fases, dois clusters novos, bytes, chaves, grants, filas e replay. Os 13 testes estáticos continuam sem aprovar B12 sozinhos. Host físico, cópia externa, cofre, RPO/RTO produtivo, Backup-center, piloto e exactly-once externo permanecem abertos. Não refazer essa corrida como pendência de bancada.
3. O run `40840682617` falhou no depguard de `55e0d29` e permanece falha. O run `40877414874` da branch `dev/lote31-b04-pg-validado-6963214`, SHA `6963214`, concluiu `success` às `2026-10-29T13:11:42Z`. A fonte do snapshot antigo é `ci-run-6963214.json` (`in_progress` às `2026-10-29T12:56:16Z`). A fonte da conclusão é a API pública do GitHub, lida sem token às `2026-10-29T13:21:13Z`. Go, browser e SBOM local de `cc542a1` permanecem a prova local dessas partes. O CI de `e193266` e a geração de `6f4bf38` não cobrem esta candidata. Artefato SBOM deste run não foi inventariado.
4. A base B04 do lote 29 está no clone. Allowlists vazias. `corte_autorizado` falso. A comparação de 23 faturas e zero acordos não autoriza o corte. A corrida `7cde1e6` permanece exit 1. A corrida `6963214` preenche treze critérios e deixa seis abertos. O gate de inclusão `matches-falso-bloqueia-corte` continua separado e aberto. `balanceReadDatabaseGate` continua `pending`. A próxima inclusão de leitor exige esse gate e revisão independente.
5. O lote 33 implementa o MVP interno de B15, offline e desligado. R1 teve exit 0 no pacote `cloudapi` com sender falso, sem rede. R2 e G esperam `NEXO_CLOUD_PG_REQUIRED=1` no `go_integration.py` já existente. O CI do lote 33 não rodou. O verde `40877414874` continua o de `6963214`. H, WABA, fiscal, extrato, host físico e cópia externa ficam fora. Homologações Efí, OLT, NAS, fiscal e piloto permanecem sem tarefa de produção enquanto o recurso externo não existir. Default, sandbox, teste falso e gate desligado não são homologação.

Gates que continuam obrigatórios para `main` ou deploy: `python3 tests/contrato/nativo.py` e `python3 tests/contrato/go_integration.py`, sem `-I`, em PostgreSQL descartável, no commit que for tag, e o workflow hospedado desse SHA. O exit 0 de `6963214` vale para esse SHA na candidata. A corrida `7cde1e6` permanece reprovada. Falha por ausência de banco fica registrada como não executada. Falha de `python3 -I` no import de `lib` é bootstrap e não aprova o gate. O mapa integral preserva B01–B18. Não há percentual. O projeto permanece aberto enquanto existir critério aberto. Os lotes 25 a 33 não estão em `main`.
