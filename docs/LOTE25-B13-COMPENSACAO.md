# Lote 25 B13 — compensação de lote de títulos

A compensação está implementada na branch de desenvolvimento `task/556b3d63d7fc/t9-documentacao-operacional`, HEAD `8c10c1a`, sobre a base aprovada `82c4251`. Não está publicada, não está homologada e não fecha o NexoISP. Não há percentual de conclusão. `docs/LOTE24-B13-DESENHO-COMPENSACAO.md` e `docs/LOTE24-B13-ACEITACAO.json` permanecem históricos: a matriz do lote 24 continua `planned/not_run`.

A matriz executável é [docs/LOTE25-B13-COMPENSACAO-ACEITE.json](LOTE25-B13-COMPENSACAO-ACEITE.json). Os 22 casos continuam com `executado: false` no conjunto: o HTTP de `nativo.py` não concluiu. Código de teste, revisão e skip não são execução. Três casos que só têm teste Go (B13-03, B13-21 e B13-22) têm a ação Go passada na base `cc542a1`; isso não passa os 22 HTTP.

## Leitura vigente depois dos lotes 26 e 27

A seção seguinte registra o que a redação do lote 25 fez. A prova posterior está em [docs/LOTE26-VALIDACAO-B13-SBOM.md](LOTE26-VALIDACAO-B13-SBOM.md) e em `/home/enok/Documentos/projetos/implementacao-codex/lote26-validacao-b13-sbom-2026-10-29/evidencias/gate-summary-cc542a1.json`.

Na base `cc542a1b502b9b78bdd0673140bbba0f15a89716`:

- `python3 tests/contrato/go_integration.py` exit 0. 241 ações pass, incluindo subtestes. 58 delas são `TestImportCompensate*`, todas pass. Pacotes sem teste aparecem como skip de pacote, não como skip desses casos.
- O browser dirigido de `frontend-v0-import.mjs` exit 0. Desktop e viewport 390. Um POST já commitado com resposta perdida foi recuperado pela ficha, sem segundo estorno. As capturas ficam no arquivo externo `browser-real-cc542a1/`. Essa jornada não declara os 22 HTTP passados.
- `python3 tests/contrato/nativo.py` exit 1 em `import_compensate_contract.py:335`, no `UPDATE` de `gateway_charge_id` sem `financial_connection_id`. A limpeza de elegibilidade anterior passou. O comando não concluiu.

No HEAD `e2f3b18`, o commit `b67d2f3` corrige esse setup com conexão EFI sandbox sintética e mantém o 409 `provider_issuance`. `py_compile` passou. A nova chamada de `nativo.py` morreu com `FileNotFoundError: docker` antes do PostgreSQL. O ensaio do fixture corrigido permanece pendente. Não reimplementar o lote 25.

O contrato MVP não muda: só `invoices`, até 200 `created`, sem PSP, sem franquia, IDs e histórico preservados, `evidence.reverted` falso. Sem homologação, push ou deploy.

## O que a redação do lote 25 verificou

Esta tarefa leu o desenho, a matriz do lote 24, `AGENTS.md` e o código já integrado na branch. Não alterou controlador, modelos, testes nem dados. Não acessou credencial real e não chamou PSP. Naquele momento não executou `nativo.py`, `go_integration.py`, `go test` com PostgreSQL, Playwright nem o workflow. Não havia PNG `import-compensacao-*.png` no clone. A execução nomeada acima é posterior e não reescreve esse fato.

Os quatro unitários sem banco citados no aceite (`TestImportCompensateSourceGuards`, `TestImportCompensate_B13_15`, `TestImportCompensate_B13_19`, `TestImportCompensateHashOmitsKey`) eram, na redação, relato do runner que escreveu a matriz. Esta redação não os reexecutou. Eles não cobrem concorrência, RLS, rollback nem HTTP. Depois, os quatro passaram dentro do `go_integration.py` de `cc542a1` e continuam sem cobrir o HTTP.

## Arquivos da implementação

| Peça | Arquivo | Commit na branch |
|---|---|---|
| Marcador append-only | `db/migrations/00078_import_batch_compensations.sql` | `0a67a13` |
| Protocolo `finance.LockInvoices`, sal `7411005` | `apps/api-go/internal/finance/invoice_locks.go` | `2da4e0c` |
| Núcleo `importCompensate` | `apps/api-go/internal/modules/escrita/import_compensate.go` | `0c04ded` |
| Registro da rota no serviço de escrita | `apps/api-go/internal/modules/escrita/importacao.go` e `apps/api-go/internal/modules/escrita/rotas.json` | `e8fe763` |
| Inventário estático da rota | `apps/api-go/rotas.json`, `POST /api/import/batches/:id/compensate` | `a5709b4` |
| Leitura do marcador | `apps/api-go/internal/modules/leitura/import_revert_eligibility.go` | `ee80de1` |
| Contrato HTTP do GET antes, depois e no replay | `tests/contrato/import_revert_eligibility_contract.py` | `82589b1` |
| 22 casos e corridas | `tests/contrato/import_compensate_contract.py`, `tests/contrato/nativo.py`, `apps/api-go/internal/modules/escrita/import_compensate_test.go` | `6de0e98` |
| Ficha oficial | `apps/web/features/admin/import-batches.tsx` | `8f06bae` |
| Jornada de browser | `e2e/frontend-v0-import.mjs` | `1ec8569` |

O inventário em `apps/api-go/rotas.json` fecha a lacuna apontada na revisão de `t5-registrar-rota`. É lista estática incorporada ao processo. Não é prova de que `/openapi.json` foi servido, nem de que a rota foi publicada.

## Decisões e defaults adotados

O desenho do lote 24 foi implementado, sem redesenho.

- Alcance só `invoices`. `subscribers`, `contracts`, `history`, `network`, `documents` e `users` recebem 409 `kind_not_compensatable`.
- Permissão default `import:run`, o mesmo papel que aplicou o CSV. Não se acrescentou `finance:write`.
- Motivo obrigatório, trim, 10 a 200 caracteres. Vai para o marcador, para `import.compensate_batch` e para o texto `compensação do lote {id}: {motivo}` passado a `finance.Reverse`. O cancelamento grava o motivo já aparado em `status_note`.
- Idempotência: hash SHA-256 só de `batch_id` e `reason`. A chave não entra no hash e não sai no JSON de resposta nem no GET.
- Teto de 200 linhas `created`. Acima disso, 409 `row_cap`, sem marcador.
- Uma transação do registry. Sem savepoint por fatura. Bloqueio ou erro desfaz pagamento novo, cancelamento, marcador, movimento e auditoria desta tentativa.
- Ordem de lock: `pg_advisory_xact_lock(hashtextextended(tenant || ':invoice:' || id, 7411005))` em `invoice_id` crescente, e só depois `select id from invoices ... order by id for update`.
- `evidence.reverted` fica falso. A nota do POST é `compensação append-only; nenhuma linha financeira, lote ou auditoria foi apagada`. A nota do GET continua a da avaliação somente leitura.
- Nenhuma devolução PSP. `provider_refund_id` da compensação não é preenchido por esta rota. `external_id` não é limpo, então a mesma origem não recria o título: a reimportação cai em `unchanged` e pode aparecer como lote dependente.
- O down da migração 78 levanta exceção e não apaga marcador.

Divergência conhecida, já na matriz: o desenho pedia 409 de `payments_one_reversal_uq` numa segunda reversão da baixa original. `finance.Reverse`, fora do núcleo novo, recusa antes com 400 `fatura cancelada`, porque a compensação já cancelou a fatura. O teste verifica essa recusa e a unicidade. O código de caixa não foi alterado para mascarar o caso.

O subteste de auditoria de B13-03 ainda arma o gancho `importCompensateBeforeCommit`, nulo em produção. O subteste do marcador usa falha real de chave estrangeira do ator.

## Cinco ramos de escritores e registro seguro

`finance.LockInvoices` foi integrado nos escritores antes de existir a rota. O commit `e8fe763` (`t5-registrar-rota`) só então registrou `POST /api/import/batches/:id/compensate` no mapa de operações, com a transação que o registry já abre. O núcleo `importCompensate` não registra rota e não abre outra transação.

Os cinco ramos de produção, todos anteriores a esse registro:

1. `2da4e0c` `t2-locks-financeiros`: helper; `Manual` e `Reverse` em `finance/core.go`; `invoiceCancel`, `invoicePayment` e `invoiceResolve` em `financeiro.go`; acordo em `finance/advanced.go`; recebimento de gateway em `finance/gateway.go`; `prepare` e `lockIssuanceInvoice` em `finance/issuance.go`. Em `invoicePayment` o consultivo entra antes do `select ... for update` e antes de `manual_payment_intents`.
2. `35413a8` `t3-consumidor-efeitos`: `planPaidEffect` trava antes de `payment_effects` e de `service_resources`.
3. `573b8d9` `t4-locks-reimport-avisos`: em CSV `invoices`, `lockReferencedInvoices` corre antes dos savepoints de linha e segura as faturas que o arquivo já pode reconhecer.
4. `5337074` `t3-operacoes-devolucoes`: `PrepareProviderOperation` e `ApplyProviderRefund` tomam o par consultivo e linha antes do insert que dispara o trigger.
5. `13ac6dd` `t4-enfileiramento-avisos`: `outbound` trava as faturas candidatas antes do upsert em `notice_log` e relê a candidatura debaixo do lock.

`f676a04` (`t3-locks-psp-efeitos`) é o ciclo de aceite da emissão: acrescenta `invoice_locks_issuance_test.go`. O `LockInvoices` de `issuance.go` já estava no ramo 1. Esse commit de teste não é um sexto escritor de produção.

Chamada aninhada repete o par. Ela é reentrante na mesma transação porque a ordem não se inverte. O teste B13-22 descreve a ordem invertida como espera de deadlock `40P01`. Esse teste não rodou neste ambiente.

## Leitura, interface e contratos

O GET, para o lote do tenant visível, devolve `compensation.state=absent` ou `committed` com `compensation_id`, `created_at`, `reason` e o `result` persistido. O `result` guardado conserva `idempotent_replay=false`; o replay do POST é que responde `true`. Segredo de idempotência não entra no payload.

O contrato `import_revert_eligibility_contract.py`, chamado por `nativo.py`, descreve o before, o after e o replay: ausente e fatura `open` antes; committed, cancelada e um movimento a mais depois; segundo POST sem movimento novo; `evidence.reverted` falso nas três leituras; outro tenant 404; POP, portal, suporte e cookie sem CSRF não gravam. O arquivo existe. Na redação do lote 25, `nativo.py` não foi executado. Na base `cc542a1` o comando inteiro morreu antes de concluir, então o before/after/replay também não fica passado.

A ficha oficial não é página nova. O badge "Sem efeitos posteriores" continua leitura. Outros kinds mantêm o texto de que a reversão daquele tipo não está disponível.

## Três defeitos da jornada e commit com resposta perdida

O script `e2e/frontend-v0-import.mjs` foi estendido para a UI entregue. A última revisão dessa jornada de browser usou Sol 6.1 medium, porque a cota de Sonnet 5.5 high estava comprovadamente esgotada. Essa substituição não é a revisão principal ativa. Não houve, neste registro, revisão principal Sonnet da jornada. Revisão de código não executa o script e não homologa.

Três defeitos que o script passa a cobrir, para a jornada não mentir sobre a UI:

1. Reimportação de assinantes usa outro arquivo e refaz o mapa. O lote original permanece o mesmo id; o segundo lote é outro. Sem isso, a ficha de títulos e a de assinantes se misturavam no mesmo nome.
2. O 409 de bloqueio separa a frase do POST e a contagem em `<strong>`. O script não trata o número como parte da descrição, e exige `compensation.state=absent` com a baixa posterior intacta.
3. No viewport de 390 px, Escape pode fechar a ficha junto com o diálogo. O script reabre o lote antes de medir overflow e exige que cancelar a confirmação não envie POST.

O cenário real de commit com resposta perdida está no mesmo script e não é um desses três. O servidor responde 200, o teste aborta a resposta no navegador, a ficha relê o GET e mostra "A resposta da tentativa não chegou íntegra. A leitura do lote mostra a compensação registrada." Há um estorno, o botão some, e outra chave recebe 409 `already_compensated`. A frase de resposta inconclusiva, usada no 503, não aparece nesse caminho. O 503 coberto ao lado conserva a mesma chave e só grava na segunda confirmação.

Nenhum desses caminhos foi executado na redação do lote 25. Não havia evidência Playwright naquele HEAD. Em `cc542a1` o harness dirigido executou a jornada e terminou exit 0; as capturas não entraram no commit. O passo de CI `python3 tests/contrato/e2e.py` inclui `frontend-v0-import.mjs` via `e2e/smoke.mjs` e não foi consultado como run hospedado.

## Testes: o que é real, o que é skip, o que falta

A tabela mistura o registro original e a prova de `cc542a1`. Onde as duas divergem, vale a coluna da base `cc542a1`.

| Verificação | Registro original do lote 25 | Base cc542a1 |
|---|---|---|
| Quatro unitários Go sem banco | Relato do runner da matriz, não reexecutado na redação. Não aprovam banco. | `TestImportCompensateSourceGuards`, `TestImportCompensate_B13_15`, `TestImportCompensate_B13_19` e `TestImportCompensateHashOmitsKey` passaram dentro das 58 ações. B13-15 continua sem CSRF, cookie e HTTP. |
| `TestImportCompensate_B13_*` que abre PostgreSQL | Escritos. Skip sem `NEXO_GO_TEST_DATABASE_URL` não aprova. | Passaram no `go_integration.py`, exit 0, com URL de banco. Não são skip. Não substituem o HTTP. |
| `python3 tests/contrato/nativo.py` | Não executado na redação. É o gate HTTP dos 22 casos e do GET before/after/replay. | Exit 1 em `cc542a1`, comando não concluído. Os 22 HTTP não estão passados. O fixture corrigido em `b67d2f3` ainda não rodou até o fim. |
| `python3 tests/contrato/go_integration.py` | Não executado na redação. Sobe PostgreSQL descartável e roda `go test -count=1 -race -p 1 ./...`. | Exit 0 em `cc542a1`: 241 ações pass. Vale para essa base, não para o CI hospedado e não para o fixture posterior. |
| `python3 -I tests/contrato/nativo.py` e `python3 -I tests/contrato/go_integration.py` | Falha de bootstrap, reproduzida nesta worktree em 2026-10-29, exit 1, antes de Docker e de PostgreSQL. `ModuleNotFoundError: No module named 'lib'` em `nativo.py:13` e em `go_integration.py:11`. `-I` implica `-P` e `-E`: o diretório do script sai de `sys.path` e `PYTHONPATH` é ignorado. Isto não é skip por ausência de banco, não aprova o laboratório e não é o gate. Os testes não foram alterados. |
| `go test -race ./...` do workflow, sem URL de banco | Compila e deixa os testes de banco em skip. Esse skip não publica o lote. |
| Browser `frontend-v0-import.mjs` | Na redação, script presente e execução ausente. Em `cc542a1`, o harness dirigido terminou exit 0, com capturas só no arquivo externo. Não marca os 22 HTTP. |
| Homologação com exportação real de provedor | Aberta em B18. Fora deste lote. |
| Publicação e deploy | Não ocorreram. CI de `e193266` não cobre `cc542a1` nem `e2f3b18`. |

Comandos que a gerência executa num laboratório descartável, antes de publicar. Container, porta e prefixo exclusivos. Não apontar para banco de produção.

```text
python3 tests/contrato/nativo.py
python3 tests/contrato/go_integration.py
```

Diretório de trabalho: a raiz do repositório. Sem `-I`, sem `-P` e sem `PYTHONSAFEPATH`. O interpretador coloca `tests/contrato` em `sys.path`, e `from lib` resolve `tests/contrato/lib.py`. Essa é a invocação de `.github/workflows/native.yml`.

A forma com `-I` não é comando de gate. Reproduzida aqui, ela termina em exit 1 no import de `lib` e não chega ao laboratório. Registrar essa falha de bootstrap à parte de qualquer skip por falta de `NEXO_GO_TEST_DATABASE_URL`. Não alterar `nativo.py` nem `go_integration.py` para esconder o import. Um `python3 -I -c` que insere `tests/contrato` em `sys.path` e importa `lib` só prova o módulo local; não executa os contratos e não substitui os dois comandos acima.

No mesmo laboratório, a partir de `apps/api-go`, com `NEXO_GO_TEST_DATABASE_URL` e `NEXO_GO_TEST_DATABASE_OWNER_URL` desse banco:

```text
go test -count=1 -run TestImportCompensate ./internal/modules/escrita/
go test -count=1 -race -p 1 ./internal/finance/ ./internal/outbound/ ./internal/modules/escrita/ ./internal/modules/leitura/
```

O segundo comando só aprova se as URLs existirem. Sem elas, o skip é falha de gate.

CI hospedado, workflow `.github/workflows/native.yml`, job `verificar`, no commit que for candidato a publicação:

- `go test -race ./...` em `apps/api-go`, lido junto com os dois contratos abaixo, porque o job sem URL não substitui o PostgreSQL do contrato;
- `python3 tests/contrato/nativo.py`;
- `python3 tests/contrato/go_integration.py`;
- `python3 tests/contrato/e2e.py`, que sobe Go, Caddy e Playwright e percorre `e2e/smoke.mjs`, inclusive `frontend-v0-import.mjs`.

Jornada dirigida, quando a gerência quiser só a importação dentro do mesmo harness:

```text
NEXO_E2E_ONLY=frontend-v0-import.mjs python3 tests/contrato/e2e.py
```

`npm -w apps/web run test:import` só fala com um `BASE` já no ar. Sozinho, não sobe o PostgreSQL do contrato.

Nesta documentação, os comandos obrigatórios são apenas a existência do relatório, os dois JSON e `git diff --check`.

## Plano de recuperação

A autoridade depois de uma tentativa é o GET do lote, não a memória do navegador.

- 409 com `compensation.state=absent`: a transação inteira voltou. Corrigir a causa (pagamento alheio, aviso, emissão, lote dependente, kind errado) sem apagar histórico. Nova tentativa usa motivo válido e chave nova só quando o operador confirma de novo.
- Resposta 503, 408, 429 ou rede sem marcador: a ficha conserva a chave daquele motivo. Confirmar de novo reenvia a mesma chave. Não inventar segunda compensação.
- Resposta perdida ou corpo ilegível com GET `committed`: não confirmar de novo como se fosse a primeira vez. A ficha mostra o marcador. Outra chave recebe `already_compensated`. A mesma chave devolve o resultado, com `idempotent_replay=true`, sem segundo estorno.
- Não restaurar backup antigo por cima para desfazer a compensação. Não chamar o PSP. Não limpar `external_id`. Não rodar down da migração 78 para apagar o marcador.
- Falha no lab: corrigir o código ou o ambiente e repetir os comandos. Não alterar o teste para esconder a falha. Revisão independente na fila, depois integração da branch de desenvolvimento.
- `python3 -I` em `nativo.py` ou `go_integration.py` para no import de `lib` e não é evidência de banco. A recuperação é repetir `python3 tests/contrato/nativo.py` e `python3 tests/contrato/go_integration.py`, sem `-I`. Não editar os testes para fazer o flag isolado passar.

## Riscos que continuam abertos

- Os 22 HTTP não concluíram. Em `cc542a1` o `nativo.py` morreu no fixture PSP de B13-10. A correção `b67d2f3` não teve PostgreSQL. Concorrência e rollback do contrato Python seguem sem essa prova. O Go com banco, na mesma base, cobre os testes listados na seção vigente, inclusive B13-02, a barreira de B13-11 e o `40P01` de B13-22. Isso não é o comando HTTP. A falha de bootstrap com `python3 -I` não substitui nenhum dos dois.
- A ordem de lock depende de todos os escritores citados. Um call site novo que trave a fatura antes do consultivo `7411005` reabre deadlock.
- O teto de 200 linhas `created` recusa o lote inteiro. Operação maior precisa de recorte, não de apagar o teto em silêncio.
- Kinds que não são títulos continuam sem compensação. O procedimento de corte RADIUS permanece o caminho operacional desses lotes.
- B13-20 não devolve o 409 do índice único enquanto `finance.Reverse` recusar fatura cancelada com 400. A unicidade continua no índice e no marcador.
- O gancho de teste `importCompensateBeforeCommit` precisa permanecer nil fora do teste.
- A jornada de browser rodou em `cc542a1` e as capturas não estão no commit. A revisão principal Sonnet dessa fatia de código, no lote 25, não ficou ativa. Sol 6.1 medium cobriu a última revisão daquele script por cota esgotada. Execução não reescreve essa revisão.
- O inventário OpenAPI estático não prova o listener interno.
- Sem franquia nova, sem PSP real e sem produção. Defaults de gate desligado não homologam Efí, Asaas, Inter, OLT, NAS, fiscal nem piloto.

## Continuação

A gerência continua sem pedir nova ordem e sem reimplementar os lotes 25 e 26. O que falta de execução, com procedimento em `docs/LOTE26-VALIDACAO-B13-SBOM.md`:

1. `python3 tests/contrato/nativo.py`, sem `-I`, no HEAD que contém `b67d2f3`.
2. `python3 tests/contrato/restore_clean_host.py` quando o Docker existir. O unittest estático não aprova B12. Host físico, cópia externa, cofre, RPO/RTO, piloto e os testes do Backup-center continuam abertos.
3. Run hospedado do `native.yml` neste HEAD, com o artefato `sbom-cyclonedx`. A geração local de `cc542a1` não é esse run. O CI de `e193266` e a base `6f4bf38` também não.

Itens externos não fecham por ausência de recurso. Default, sandbox e skip não viram homologação. O projeto global permanece aberto enquanto existir critério aberto em `docs/CONCLUSAO-INTEGRAL.md`. Não há percentual.
