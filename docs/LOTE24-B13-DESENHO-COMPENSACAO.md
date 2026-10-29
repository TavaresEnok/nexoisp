# Lote 24 B13 — desenho da reversão de importação por compensação

Este documento é uma decisão técnica revisável. A leitura do código em 2026-10-28 usa a base `e193266` (`feat(web): show batch revert eligibility without a revert action`). Nesta worktree, `HEAD` é exatamente `e193266619df`. A leitura descreve o que o código faz hoje e o que uma implementação futura teria de fazer. Análise de código não é homologação. Nenhum lote foi compensado, nenhum teste de compensação foi executado e nenhum schema, dado ou handler foi alterado neste lote.

A matriz de aceitação futura está em [docs/LOTE24-B13-ACEITACAO.json](LOTE24-B13-ACEITACAO.json). Cada caso de lá está marcado `planned/not_run`. O comando indicado é o argv que a implementação futura deverá conseguir rodar. Ele não é evidência de execução.

## Decisão

A reversão de um lote importado, quando for implementada, compensa. Ela preserva `payments`, `invoice_movements`, `import_batches`, `import_rows`, `audit_events` e o identificador externo da fatura. O dinheiro continua em `payments.signed_cents`. O estorno de uma baixa criada pela importação é uma linha nova `kind='reversal'` e `source='manual'`, pelo caminho já existente `finance.Reverse`. A devolução no PSP continua sendo outra operação: `provider_refund_id` / `provider_return_id`, intenção em `provider_operations` e transporte externo. A compensação de lote não chama esse caminho e não transforma estorno local em devolução externa.

O MVP executável futuro cobre somente lote `kind='invoices'`. Lotes `subscribers`, `contracts`, `history`, `network`, `documents` e `users` ficam recusados até existir prova por linha dos filhos criados na mesma gravação. Onde a prova não existe, a operação bloqueia o lote inteiro.

O GET `registerImportRevertEligibility` permanece informativo. `eligible=true` não autoriza a escrita. A escrita futura revalida os predicados debaixo dos locks e acrescenta a prova de proveniência que o GET não tem.

## O que já existe

| Peça | Símbolo e arquivo | Efeito hoje |
|---|---|---|
| Elegibilidade | `importRevertEligibilitySQL`, `registerImportRevertEligibility` em `apps/api-go/internal/modules/leitura/import_revert_eligibility.go` | GET `/api/import/batches/{id}/revert-eligibility`, permissão `import:run`, `Cache-Control: no-store`. `evidence.reverted` é a constante `false`. |
| Escopo | `importRevertEligibilityScope` delega a `importReconciliationScope` | 403 se não houver ator, se `TenantID` for vazio, se `SubscriberID` estiver preenchido, se `PopIDs != nil` ou se `Support` for verdadeiro. A mensagem atual é a da reconciliação. |
| Reconciliação | `importReconciliationSQL` em `import_reconciliation.go` | Saldo atual do lote de títulos. `received_after_import_cents` soma `signed_cents` com `created_at > b.created_at`. Também não grava. |
| Aplicar CSV | `Service.importCSV` em `importacao.go` | Uma transação `DB.WithScope`. Cada linha tem savepoint `import_row`. O lote e as linhas são inseridos no fim. Prévia devolve `previewRollback`. |
| Título | `importInvoice` e o helper `helper:importInvoiceRow` (`rotas.json`, SQL `56aea313_0.sql` … `56aea313_5.sql`) | Cria fatura, item e, se `situacao=pago`, um pagamento. Reimportação da mesma chave devolve `unchanged`. |
| Assinante | `importSubscriber` | `entity_id` da linha é `subscribers.id`. Contrato, histórico, PPPoE e extras podem nascer na mesma linha e não ganham `import_rows` próprio. |
| Contrato e demais | `importExtended`, `importContract` em `importacao_ampliada.go` | Lock consultivo `pg_advisory_xact_lock(hashtextextended($1,7411003))` na chave `tenant:source:kind:external`. Assinantes e títulos não passam por esse lock. |
| Caixa | `payments`, migrações `00003`, `00021`, `00066`, `00073` | Insert-only para `nexo_app`. `signed_cents` é gerado. `immutable_payments` chama `financial_append_only`. Estorno manual integral e único em `payments_one_reversal_uq` onde `source='manual'`. |
| Movimentos | `record_invoice_movement` e `invoice_movements` na `00066` | Abertura `created` ou `adjustment` na mesma transação da fatura. `nexo_app` só tem `SELECT`; o insert é o trigger `security definer`. Update e delete são recusados. |
| Estorno manual | `finance.Reverse` em `apps/api-go/internal/finance/core.go`; SQL em `apps/api-go/internal/finance/sql/48002566_0.sql` (trava a fatura), `48002566_2.sql` (insere a reversão) e `48002566_4.sql` (força `status='open'` e `paid_at=null`); rota `POST /api/invoices/:id/payments/:paymentId/reverse` | Exige `kind='payment'` e `source='manual'`. Recusa fatura `canceled` com 400 `fatura cancelada`. A linha que já é estorno recebe 400 `este lançamento já é um estorno`. O índice único vira 409 `esta baixa já foi estornada`. O corpo vigente de `validate_payment_reversal` está no `create or replace` de `db/migrations/00073_provider_refunds.sql` (o trigger `payment_reversal_binding` nasceu em `00066`). No `BEFORE INSERT`, para toda reversão manual ou de PSP, faz `perform 1 from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update` e só depois lê o pagamento original. `finance.Reverse` já travou a fatura em `48002566_0.sql` antes do insert de `48002566_2.sql`, então o trigger encontra a linha que a própria transação segura. `provider_issuance_payment_guard`, da migração `00077`, trava a mesma fatura de novo no `INSERT`. |
| Devolução PSP | `00073`, `00074`, `finance/provider_refunds.go`, lote 09 | Identidade remota, intenção e transporte. Fora do MVP de importação. |
| UI | `ImportBatchRevertEligibility` em `apps/web/features/admin/import-batches.tsx` | Painel "Reversão" avisa que a verificação não altera dados e que a reversão ainda não está disponível. Não há botão de executar. |
| Lote e linhas | `00004`, ampliado em `00050` e `00063` | `nexo_app` tem `SELECT, INSERT` em `import_batches` e `import_rows`. Não há `UPDATE`. Não há coluna de estado de reversão. |
| Entidades ampliadas | `import_entities` na `00063` | Chave `(tenant_id, source, kind, external_id)` e fingerprint. Usada por contratos, rede, documentos e usuários. A importação de assinantes e de títulos não grava essa tabela. |

`db.Tx` nasce em `DB.WithScope`: uma transação por request, `ROLLBACK` no retorno de erro. A auditoria de escrita passa por `record` → `audit.InTx`. CSRF de sessão cookie está em `auth.go`: mutação sem `X-Nexo-Csrf` coerente com a sessão recebe 403 `requisição sem proteção CSRF`. Bearer de token não usa esse cabeçalho.

## Proveniência por kind e por status da linha

`import_rows.entity_id` só é preenchido no resultado da função da linha. O comentário de `importRevertEligibilitySQL` fixa o mapeamento atual:

- `subscribers`: `subscribers.id`. O contrato criado na mesma linha não é o `entity_id`.
- `contracts`: `contracts.id`, devolvido por `importContract`.
- `invoices`: `invoices.id`, devolvido por `importInvoice`.
- `history`: id do atendimento, da OS ou da anotação inserida por `helper:importHistoryRow`.
- `network`, `documents`, `users`: id devolvido pelo handler interno e também gravado em `import_entities`.

Não há tabela que ligue a linha do lote ao pagamento, ao item, ao contato, à conta PPPoE ou ao extra. Não há imagem anterior (`preimage`) de linha `updated`. Inferir o estado anterior a partir do CSV atual, da nota do pagamento ou de `created_at` está fora deste desenho.

### `created`

A linha passou do savepoint e inseriu a entidade apontada por `entity_id`. Filhos inseridos no mesmo savepoint existem, mas só entram na compensação se houver prova própria, definida abaixo. Sem essa prova, o lote bloqueia quando o MVP não cobre aquele kind.

### `updated`

Só `importSubscriber` grava este status: o assinante já existia pela chave `(external_source, external_id)` e alguma coluna comparada, contato, contrato novo, PPPoE ou extra mudou. O `UPDATE` de `subscribers` não guarda o valor anterior. Compensar essa linha exigiria inventar a preimagem. A implementação futura recusa o lote inteiro se qualquer linha `updated` precisar ser desfeita. No MVP de títulos isso não ocorre: `importInvoice`, ao achar a chave externa, devolve `unchanged` e não grava `updated`. Uma linha `updated` num lote `invoices` é anomalia e bloqueia.

### `unchanged`

A chave externa já existia e a função não alterou a entidade (`importInvoice`) ou o fingerprint era o mesmo (`importExtended`). A linha pode carregar mensagens de divergência (`invoiceDivergence`); o título não é alterado. A compensação não cancela, não estorna e não edita essa entidade. Ela também não apaga a linha do lote. Uma reimportação posterior com status `unchanged` continua sendo referência em `dependent_batches` do lote que criou a entidade.

### `error`

O savepoint `import_row` sofre `ROLLBACK TO`. `entity_id` fica nulo. Nada dessa linha permanece para desfazer. A linha de erro permanece no lote como evidência.

## Pagamentos realmente criados pela importação

O único `INSERT` de pagamento no importador é `56aea313_5.sql`, chamado por `importInvoice` quando `situacao=pago`:

```sql
insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note)
values ($1,$2,$3,$4,$5,'manual',$6)
```

A nota é exatamente `Importado de {source} (id {id_externo})`. `created_by` fica nulo. `gateway`, `gateway_payment_id` e `financial_connection_id` ficam nulos. `kind` cai no default `payment`. `paid_at` é a data do CSV (`pago_em`), que pode ser anterior ao lote. `created_at` é o default `now()` do PostgreSQL, igual ao `created_at` do lote porque lote, fatura, pagamento e movimento nascem na mesma transação. `valor_pago` vazio copia o valor do título. Valor maior que o título e até o dobro é aceito (`invoicePaid`). Acima do dobro a linha é erro e não grava. Valor menor deixa a fatura `open` e soma `invoices_partial`. Valor maior ou igual marca `paid`.

Título `aberto` ou `cancelado` não insere pagamento. `importSubscriber` e `importContract` não inserem pagamento.

Prova exigida na revalidação, para no máximo um pagamento da fatura criada pela linha `created` deste lote e deste tenant:

- `invoice_id` é o `entity_id` da linha `created`;
- `kind='payment'`, `source='manual'`, `reversal_of` nulo, `created_by` nulo;
- identificadores de gateway, conexão e devolução nulos;
- `created_at` igual a `import_batches.created_at`;
- `note` igual ao texto estável acima, com o `source` do lote e o `external_id` da linha;
- não existe outra linha em `payments` da mesma fatura.

Zero pagamentos também é prova, se a soma de `signed_cents` é zero, `paid_at` da fatura é nulo e o único movimento é o `created` da própria importação. Dois pagamentos que casam o predicado, ou um pagamento que não casa, bloqueiam. A nota sozinha não basta: ela não é chave estrangeira. A igualdade de `created_at` sozinha não basta: outro transação pode cair no mesmo microssegundo.

## Dependências implícitas e lacunas

Na linha de assinante com plano e situação ativa, `importSubscriber` pode inserir, sem `import_rows` adicional:

- `contracts` com o mesmo `external_source` e `external_id` do assinante, mais `contract_history` `created`;
- `service_resources` (PPPoE) com esse mesmo par externo, `desired_version` default 0 e senha cifrada ou nula;
- contatos, etiquetas, POP, fidelidade e indicador, via `importExtras` (`helper:applyContractExtras`).

`contracts_ext_uq` e `subscribers_ext_uq` (`00001`) garantem uma chave externa por tenant, não qual lote a criou. Um lote `contracts` posterior com o mesmo id é recusado; um lote `contracts` anterior ocupa a chave e o lote de assinantes só a reutiliza. `import_entities` não é gravada no caminho de assinantes. Não há como separar "nasceu neste lote" de "já estava com esta chave". Conta PPPoE não tem único em `(tenant, external_source, external_id)`; o único relevante é `(tenant_id, pppoe_username)`.

Por isso o MVP não compensa assinante nem contrato. Apagar ou inativar esses registros sem prova atingiria entidade preexistente ou filho de outro lote. Provisionamento (`provisionBatch`, SQL `3b7f6aa5_0.sql`) e `desired_version > 0` já bloqueiam a elegibilidade de lotes de assinantes e contratos, e mesmo `desired_version = 0` não constitui prova suficiente para desfazer a conta.

Histórico importado grava `created_at` com a data do CSV (`0991d6ec_3.sql`, `0991d6ec_4.sql`, `0991d6ec_7.sql`), frequentemente anterior ao lote. A elegibilidade não trata esse kind como universo de faturas. Rede, documentos e usuários alteram inventário, arquivo e equipe; o fingerprint em `import_entities` impede reimportação diferente, e não guarda preimagem.

## Limites do predicado `created_at > b.created_at`

`now()` no PostgreSQL é o instante de início da transação. Na importação aplicada, fatura, pagamento, movimento `created`, histórico `created` do contrato e o próprio lote recebem o mesmo timestamp se usam o default. O predicado estrito `>` é o que evita que o lote bloqueie a si mesmo. Trocar para `>=` faria todo título importado como pago aparecer em `payments_after_import`.

O mesmo predicado erra para fora:

- Outra transação que começou antes e só inseriu o pagamento depois do commit da importação grava `created_at` menor que o lote. O GET não a vê. A revalidação vê, porque qualquer pagamento que não casa a prova bloqueia, inclusive com `created_at <= b.created_at`.
- Duas transações no mesmo microssegundo ficam iguais. O GET também não as vê. A prova por `created_by`, nota e ausência de gateway separa o pagamento da importação; se não separar, bloqueia.
- `paid_at` histórico do CSV não entra no predicado. Pagamento "antigo" na data civil pode ser o da importação.
- `canceled_at` de título importado já cancelado usa `time.Now()` do Go, não `now()` do banco. Pode ser posterior ao `created_at` do lote sem ser um cancelamento feito depois. A revalidação não usa `canceled_at > b.created_at` como prova de efeito posterior. Usa o conjunto de `invoice_movements`: o único movimento anterior à compensação tem de ser uma linha `origin='created'`, `recorded_at = b.created_at`, com `status_after` coerente com o insert.
- `invoice_movements_after_import`, `contract_history_after_import` e parte de `support_records` repetem o `>`. A corrida da transação que começou antes também os fura. A revalidação de títulos exige que não exista movimento além do `created` da importação, qualquer que seja o timestamp.
- `notices`, `provider_issuance`, `network_operations` e `resources_provisioned` não usam esse relógio. Issuance bloqueia pela presença de `gateway_charge_id`, `provider_issuance_id` ou linha em `provider_issuance`.
- `invoices_created_after_import` só vale para kind `subscribers` e `contracts`. Outra fatura do mesmo contrato não bloqueia lote de títulos. Isso está coberto pelo contrato `tests/contrato/import_revert_eligibility_contract.py` e permanece.

O GET também não distingue o pagamento da própria importação de um pagamento alheio com timestamp igual. Por isso ele não pode ser a autorização da escrita.

## MVP e exclusões

MVP futuro, um único request, uma única transação:

1. Kind do lote é `invoices`. Outro kind responde 409 `kind_not_compensatable` e não grava.
2. Há ao menos uma linha `status='created'` com `entity_id` não nulo. Lote só de `unchanged` e `error` responde 409 `nothing_created` e não grava marcador.
3. Não há linha `updated`. Se houver, 409.
4. Cada linha `created` aponta para uma `invoices` do mesmo tenant. Fatura ausente bloqueia (`missing` da reconciliação já conta isso).
5. A fatura não tem `gateway_charge_id`, `provider_issuance_id`, linha em `provider_issuance`, `agreement_id`, `fee_cents` diferente de zero, `discount_cents` diferente de zero, status `reconciling`, aviso em `notice_log`, efeito em `payment_effects` nem movimento além do `created` da importação.
6. O conjunto de pagamentos é vazio ou é exatamente o pagamento provado da seção anterior, ainda sem reversão.
7. Nenhum outro lote tem linha `created`, `updated` ou `unchanged` apontando para essa fatura (`dependent_batches`).
8. O número de linhas `created` do lote é no máximo 200. O teto segura o tempo em que as linhas ficam travadas. O valor 200 é recomendação técnica; produto pode confirmar outro teto antes da implementação. Acima do teto, 409, sem gravar.

Efeito por fatura criada, depois da revalidação e ainda na mesma transação, na ordem fixa id crescente:

- Sem pagamento e status `open`: cancelar com o motivo do lote. O `UPDATE` existente (`7e6eaffb_0.sql`) só atinge `status='open'` e o trigger grava `adjustment` com `status_after='canceled'`. Nominal, item e id externo permanecem. `financial_balance_shadow.collectible_cents` fica 0 para cancelada, como já definido no lote 03.
- Sem pagamento e status `canceled`, com o único movimento `created` já em `canceled`: não cancelar de novo e não inserir pagamento. O resultado conta `left_canceled`.
- Um pagamento provado e status `paid` ou `open`: chamar `finance.Reverse` nessa baixa, com motivo que inclui o id do lote, e só depois cancelar. `Reverse` recusa fatura já cancelada e recusa baixa que não seja `manual`, e a reversão manual é integral (`00073`). A ordem é obrigatória.
- Status diferente de `open`, `paid` ou `canceled`, ou pagamento que não casa a prova: 409 do lote inteiro, rollback.

Linhas `unchanged` e `error` são contadas no resultado e não são escritas.

Exclusões fundamentadas, todas bloqueantes no MVP:

- Assinantes, contratos, histórico, rede, documentos e usuários: filhos sem `entity_id` na linha, ou efeito que não é caixa, ou preimagem ausente.
- Qualquer pagamento posterior, parcial adicional, baixa de gateway ou estorno já existente.
- Emissão PSP, cancelamento remoto, devolução remota, acordo, encargos e desconto lançados depois.
- Apagar fatura, item, pagamento, movimento, lote, linha ou auditoria. As FKs e os triggers `financial_append_only` já recusam o apagamento financeiro; o desenho não pede `DELETE` nem grant novo de update nessas tabelas.
- Liberar `external_id` para a mesma origem recriar o título. `invoices_ext_uq` continua ocupado.
- Segundo ledger, crédito de excedente em outro contrato, ou redistribuição de `financial_payment_allocations`. O excedente é o mesmo pagamento com `amount_cents` maior que o nominal; a reversão zera `signed_cents` desse recebimento. `excess_cents` volta a zero porque a soma assinada volta a zero, não porque o valor foi transferido.
- Converter a baixa `manual` da importação em `provider_operations` de refund. `Reverse` já responde que pagamento de gateway volta pelo gateway; a baixa da importação não tem conexão nem id remoto. Chamar o PSP daqui inventaria uma devolução.

## Valores pagos, parciais, excedentes e títulos cancelados

| Situação gravada por `importInvoice` | Caixa hoje | Compensação do MVP |
|---|---|---|
| `aberto` | Nenhum pagamento. Status `open`. Movimento `created` com esse status. | Cancela. Nenhum `payments` novo de estorno. |
| `pago` integral (`valor_pago` vazio ou igual ao título) | Um pagamento `manual`, status `paid`, `paid_at` da origem. | `Reverse` integral dessa linha e depois cancelamento. A baixa original permanece. A soma assinada fica 0. |
| `pago` parcial (`valor_pago` menor) | Um pagamento menor que o nominal, status permanece `open`, mensagem na linha. | `Reverse` integral desse único pagamento (o valor estornado é o valor pago, não o nominal) e depois cancelamento. Não deixa saldo cobrável do título importado. |
| `pago` excedente (maior que o nominal, até o dobro) | Um pagamento maior que o nominal. A view de saldo expõe `excess_cents`. Não há crédito livre. | `Reverse` da linha inteira. Não estorna só a diferença e não abre crédito em outro contrato. Depois cancela. |
| `cancelado` na origem | Status `canceled`, `canceled_at` com relógio do Go, nota `cancelado na origem ({source})`, sem pagamento. | Não mexe na fatura. Registra `left_canceled` no marcador. Id externo continua ocupado. |
| Baixa posterior no Nexo, total ou parcial, em cima do título importado | Pagamento com `created_at` normalmente maior e `created_by` preenchido na baixa manual (`finance.Manual`). | Bloqueia. Não estorna a baixa posterior e não estorna só a baixa da importação deixando a outra. |
| Título importado que depois foi cancelado pelo operador | Movimento `adjustment` posterior, ou `canceled_at` de outra transação. | Bloqueia. O cancelamento já é efeito posterior. Não se desfaz o cancelamento alheio. |

`finance.Reverse` força `status='open'` e `paid_at=null` mesmo se ainda houvesse outros pagamentos (`48002566_4.sql`). Por isso a revalidação prova "no máximo o pagamento da importação" antes de chamá-lo. Depois do estorno, o cancelamento só corre se o `UPDATE` ainda enxergar `open`.

## Estado do lote, idempotência e reimportação

`import_batches` não tem status e o papel da aplicação não pode atualizá-lo. O estado da compensação não pode ser um `UPDATE` do lote.

Migração futura estritamente necessária, número a confirmar na hora (o próximo livre nesta leitura é `00078`):

`import_batch_compensations`, insert-only, uma linha por lote:

- `tenant_id`, `batch_id` único, FK para `import_batches (tenant_id, id)`;
- `idempotency_key` único por tenant, `request_hash`, `reason`, `actor_id`, `result jsonb`, `created_at default now()`;
- RLS de tenant, políticas restritivas de portal e de POP no mesmo espírito de `import_entities`;
- `GRANT SELECT, INSERT` para `nexo_app`;
- trigger `financial_append_only` em update e delete.

Não há estado "em andamento" persistido. Falha no meio faz `ROLLBACK` de estornos, cancelamentos, movimentos do trigger, marcador e auditoria. Repetir é seguro: ainda não existe marcador e ainda não existe reversão.

Repetição depois do commit, mesma `Idempotency-Key` e mesmo hash de `{batch_id, reason}`: devolve o `result` gravado, `idempotent_replay=true`, sem novo `payments`. Chave igual com corpo diferente: 409. Outra chave para lote que já tem marcador: 409 `already_compensated`. Duas requisições concorrentes serializam nos locks da seção seguinte; a que espera relê o marcador e não estorna de novo. O índice `payments_one_reversal_uq` é a segunda trava contra estorno duplicado se o marcador falhar em ser consultado.

`finance.Reverse` em seguida, sobre a linha `kind='reversal'`, já responde `este lançamento já é um estorno`. A baixa original já tem a reversão manual única. A compensação não se desfaz por essa rota. Nova baixa manual exige fatura `open` ou `reconciling`; a fatura compensada está `canceled` ou já estava `canceled`.

Reimportar o mesmo `id_externo` e a mesma origem encontra `invoices_ext_uq`, devolve `unchanged` e pode acrescentar mensagem de divergência. Não cria segunda fatura e não limpa o marcador. Um lote novo de títulos que só reconhece a fatura compensada passa a aparecer em `dependent_batches` do lote original. Isso não desfaz a compensação já commitada: a linha nova não alterou a fatura. A corrida em que esse lote dependente commitaria no meio da decisão fica fechada só quando `importInvoice` participar dos locks.

Unicidade que a compensação preserva:

- `invoices_ext_uq` em `(tenant_id, external_source, external_id)`;
- `invoices_recurrence_uq` da mensalidade, quando houve `competencia`;
- `subscribers_ext_uq` e `contracts_ext_uq`, intocados no MVP;
- `payments_one_reversal_uq` para o estorno manual;
- `import_entities` primary key, intocada no MVP;
- a chave nova `(tenant_id, batch_id)` do marcador.

## Escopo, permissão, CSRF, contrato HTTP, motivo, auditoria, UX

Autorização da rota futura, igual à leitura:

- permissão `import:run`, a mesma de `POST /api/import/apply` e do GET de elegibilidade;
- `importRevertEligibilityScope`: tenant integral, sem portal, sem POP e sem suporte;
- tenant só pelo `WithScope` da sessão. O corpo não escolhe tenant. Lote de outro tenant não aparece por RLS e a resposta é 404 `lote não encontrado`, a mesma do GET;
- cookie de sessão exige `X-Nexo-Csrf`. A falta continua 403.

Recomendação técnica: não exigir `finance:write` além de `import:run`. Quem aplica o CSV já lança a baixa manual da importação com `import:run`. Exigir as duas permissões é decisão de produto; o default deste desenho acompanha a permissão que criou o lote. As rotas de caixa do dia a dia continuam em `finance:write`.

`POST /api/import/batches/{id}/compensate`

- Sem query string. Filtro repetido ou desconhecido segue `rejectImportReconciliationQuery` (400).
- Cabeçalho `Idempotency-Key` obrigatório, 8 a 200 caracteres imprimíveis. Ausente: 400.
- Corpo `{"reason":"..."}`. Depois de trim, 10 a 200 caracteres. Abaixo disso ou acima: 400. O texto é obrigatório e vai para o marcador, para `audit.InTx` e para o motivo passado a `finance.Reverse` (esse caminho já exige motivo; a rota manual existente pede mínimo 5 e máximo 200).
- 200:

```json
{
  "batch_id": "uuid",
  "compensation_id": "uuid",
  "idempotent_replay": false,
  "created_rows": 0,
  "reversed_payments": 0,
  "canceled_invoices": 0,
  "left_canceled": 0,
  "skipped_unchanged": 0,
  "skipped_error": 0,
  "evidence": {
    "reverted": false,
    "note": "compensação append-only; nenhuma linha financeira, lote ou auditoria foi apagada"
  }
}
```

`reverted` permanece falso: compensar não é apagar, e o GET atual não deve passar a dizer o contrário. Quando o GET for estendido, o acréscimo é um objeto `compensation` (`absent` ou `committed`). Isso é tarefa futura de leitura; neste lote o GET não muda.

- 409 com `error` estável e, quando couber, `blockers` no mesmo formato do GET (`kind`, `count`, `sample_ids`, `description`), mais kinds internos `provenance_payment`, `provenance_movement`, `kind_not_compensatable`, `nothing_created`, `row_cap`, `already_compensated`, `idempotency_conflict`.
- 404 lote inexistente no tenant. 403 escopo, permissão ou CSRF. 400 validação.

Auditoria na mesma transação, via `record`: uma linha `import.compensate_batch` em `import_batch`, com motivo, contagens e ids dos pagamentos estornados. Cada `Reverse` já grava `invoice.payment_reverse`. O cancelamento grava `invoice.cancel`, como `invoiceCancel` já faz. Falha de auditoria desfaz a compensação. Nada disso apaga evento antigo.

UX oficial, quando a rota existir, fica no painel já entregue em `ImportBatchRevertEligibility` (`apps/web/features/admin/import-batches.tsx`), na ficha do lote. Não se cria página paralela. O badge "Sem efeitos posteriores" continua sendo leitura. O botão só aparece para kind `invoices`, escopo integral e `import:run`, pede o motivo num campo obrigatório e confirma antes do POST. O cliente `api` já manda o CSRF da sessão. Sucesso mostra as contagens e a frase de que nada foi apagado. 409 mostra os bloqueios devolvidos pelo POST, não os do GET antigo. Outros kinds permanecem com o texto de que a reversão desse tipo não está disponível. Este lote não altera esse componente: hoje o painel só lê, e é assim que deve continuar até a implementação.

## Transação atômica e corrida

A compensação usa um `DB.WithScope` e não usa savepoint por linha. Qualquer bloqueio ou erro devolve rollback total: contagem de `payments`, de `invoice_movements` e de `import_batch_compensations` igual à de antes do request.

Ordem de locks, obrigatória para todos os escritores participantes. Um `pg_advisory_xact_lock` só dentro da rota nova não serializa quem não toma essa chave.

Ordem global, sempre nesta sequência, com sal novo `7411005`:

1. Locks consultivos de transação, um por fatura, `select pg_advisory_xact_lock(hashtextextended($1,7411005))`, chave `tenant_id || ':invoice:' || invoice_id`. Ordem: `invoice_id` crescente em texto. O sal `7411005` não está em uso. A razão sólida para não reutilizar `7411003` é separar protocolos: o consultivo da fatura não compartilha o sal da chave externa de `importExtended`, que faz `hashtextextended(tenant:source:kind:external, 7411003)` em `importacao_ampliada.go`. `rotate` em `apps/api-go/internal/db/operations.go` trava o literal `pg_advisory_xact_lock(7411003)`, sem hash; é outro mecanismo. A probabilidade de um `hashtextextended` com sal `7411003` colidir com o literal `7411003` não justifica esta escolha e não é tratada aqui como risco prático. Também já estão ocupados `7411001` (`admin.go`), `7411002` (`jobs.go`) e `7411004` (`demo.go`). A chave de `importExtended` não cobre `importInvoice` nem `importSubscriber`.
2. `select id from invoices where id = any($1::uuid[]) order by id for update`.
3. Filhos, só os que o escritor realmente toca, cada lista ordenada por id, nesta ordem de tabelas: `provider_issuance`, `provider_operations`, `payment_effects`, `manual_payment_intents`, `service_resources`.
4. Inserts e updates de negócio: pagamentos, marca de compensação, `import_rows`, `notice_log`, auditoria.

Os triggers abaixo travam ou alteram `invoices` durante o passo 4. `validate_payment_reversal` está entre os que travam a fatura. Nenhum deles toma o consultivo. Se o escritor disparar o trigger antes do passo 2, a compensação fica com a fatura e espera o filho, enquanto o outro fica com o filho e espera a fatura. A prova exigida na implementação é que cada call site tome os passos 1 e 2, consultivo e depois fatura, antes da sentença que dispara o trigger. No passo 4 o trigger só encontra a linha que a própria transação já segura.

| Trigger | Onde | O que faz com a fatura | Efeito no MVP de títulos importados |
|---|---|---|---|
| `provider_issuance_reserve` | trigger em `00069`; corpo vigente no `create or replace` de `00077`; `BEFORE INSERT` em `provider_issuance` | `select * from invoices … for update` e, no sucessor, `for update` do journal pai depois da fatura | Primeira reserva exige `status='open'`, nenhum pagamento e `provider_issuance_id` nulo. O comentário do corpo diz `invoice first, journal second`. |
| `provider_issuance_reservation_link` | `00077` substitui a de `00069`, `AFTER INSERT` | `update invoices set provider_issuance_id=…` | Grava a reserva. A compensação, se já segurou a linha, relê e bloqueia. |
| `provider_issuance_bind` | `00069`, `AFTER UPDATE` para `issued` | `update invoices` com conexão, gateway e `gateway_charge_id` | Mesma regra: a revalidação sob o `for update` vê o vínculo ou a emissão espera a fatura já cancelada. |
| `provider_issuance_payment_guard` | `00077`, `BEFORE INSERT` em `payments` | `select * from invoices … for update` | Com `provider_issuance_id` nulo, deixa passar o estorno manual. Se a corrida gravou reserva e `gateway_charge_id` ainda é nulo, levanta `N6901` (`payment requires reconciliation of pending provider issuance`) e a transação inteira desfaz. |
| `provider_operation_guard` | trigger em `00074` (`BEFORE INSERT OR UPDATE`); corpo vigente em `00077` | no ramo `INSERT`, `perform … from invoices … for update` | Operação de PSP. A compensação não insere nessa tabela. Quem prepara a operação precisa ter travado a fatura antes do insert. |
| `invoice_issuance_guard` | `00069`, reescrito em `00077`, `BEFORE UPDATE` em `invoices` | Não toma outra linha; recusa `status='canceled'` quando já há `provider_issuance_id` | Segunda barreira, mensagem `provider charge must be reconciled/canceled before changing debt`. O MVP já bloqueia esse estado antes do `UPDATE`. Se a barreira disparar, o erro aborta o lote; não se captura para seguir nas outras faturas. |
| `validate_payment_reversal` | trigger `payment_reversal_binding` em `00066`, `BEFORE INSERT` em `payments`; corpo vigente no `create or replace` de `00073` | `perform 1 from invoices where id=new.invoice_id and tenant_id=new.tenant_id for update` e, em seguida, `select * into original from payments` do pagamento original | Participa da ordem de locks. Vale para toda reversão manual ou de PSP. O call site toma o consultivo e a fatura antes do `INSERT`. `finance.Reverse` já trava a fatura em `48002566_0.sql` antes de `48002566_2.sql`. `ApplyProviderRefund` já faz `for update` da fatura em `provider_refunds.go` antes do insert. Essa ordem consultivo, depois fatura, permanece válida. O índice `payments_one_reversal_uq` continua sendo a trava contra dois estornos manuais do mesmo recebimento. |
| `financial_binding_guard` | trigger `payments_connection_guard` em `00065`; corpo vigente em `00077` | Não trava a fatura quando `financial_connection_id` e `gateway_payment_id` são nulos | O insert de `48002566_2.sql` passa por esse ramo e não exige conexão nem devolução. |

Essa hierarquia não tem aresta de um lock posterior para um anterior. Esperas não fecham ciclo se todos obedecem a mesma ordem. `FOR UPDATE` sem `ORDER BY` em `id = any($1)`, como em `732e540b_1.sql` do acordo, fecha ciclo com quem trava duas faturas em ordem ordenada. Por isso o acordo entra na lista de participantes.

O marcador de idempotência é lido e inserido depois das travas das faturas do lote. A baixa manual já trava a fatura antes de `manual_payment_intents` (`invoicePayment`). A compensação não pode travar a chave de idempotência antes da fatura e depois inverter essa ordem em outro ramo.

Participantes que terão de tomar os passos 1 e 2 antes do efeito que já produzem:

| Escritor | Onde | Lock atual, na ordem em que o código trava | Participação |
|---|---|---|---|
| Compensação | handler futuro ao lado de `importCSV` | nenhum | Define a ordem, revalida sob o `for update` e grava marcador, estorno e cancelamento. |
| Baixa manual | `invoicePayment` em `financeiro.go` | Primeiro o `select id from invoices where id=$1 for update` da própria função, depois `manual_payment_intents`, e só então `finance.Manual` repete o lock em `apps/api-go/internal/finance/sql/67fd2417_0.sql` e insere em `67fd2417_5.sql` | O consultivo entra antes desse primeiro `select`. Colocá-lo só dentro de `Manual` inverte a ordem: a rota já segura a linha e passa a esperar o consultivo. `finance.settle` (`c810a196_2.sql`) roda na mesma transação, depois desse lock, e não abre outra ordem. |
| Estorno manual | `invoiceReverse`, `finance.Reverse` | `48002566_0.sql` trava a fatura; `48002566_2.sql` insere e dispara `validate_payment_reversal`, que retrava a mesma fatura antes de ler o pagamento original; o guard de `00077` trava a linha de novo; `48002566_4.sql` reabre | Consultivo antes de `48002566_0.sql`, e portanto antes do `INSERT` que dispara o trigger. A ordem consultivo, depois fatura, continua válida porque `Reverse` já segura a fatura. |
| Cancelamento local | `invoiceCancel`, `apps/api-go/internal/modules/escrita/sql/7e6eaffb_0.sql` | o `UPDATE` trava a linha, sem consultivo e sem `for update` prévio, e só se `status='open'` | Consultivo e `for update` antes do `UPDATE`. Sem isso, quem segura a linha e depois pede o consultivo cruza com quem fez o contrário. |
| Resolução de caixa | `invoiceResolve`, `539ae5b8_0.sql` e o update `539ae5b8_1.sql` | `for update` se `reconciling` | Consultivo antes. Título importado em conciliação já bloqueia a compensação. |
| Acordo | `contractAgreement`, `finance.Agreement`, `732e540b_1.sql` | `for update` de várias faturas sem `order by`; `732e540b_3.sql` marca `canceled` sem exigir `status='open'` | Consultivo na ordem dos ids e `for update` com `order by id` antes do resto. A revalidação vê `agreement_id` ou movimento extra e responde 409. |
| Recebimento de gateway | `finance.Payment` / `paymentWithReview` | `fdf4962a_0.sql` trava a fatura; `fdf4962a_1.sql` insere; em disputa, `gateway.go` põe `reconciling`; senão `settle` | Consultivo antes de `fdf4962a_0.sql`. `demoPay` chega aqui por `finance.Event`, noutra transação, e passa pelo mesmo par. |
| Emissão inicial | `SandboxIssuance.prepare` em `issuance.go` | `select id, external_source from invoices where id=$1 for update` e só depois o `insert into provider_issuance`. Não usa `lockIssuanceInvoice` | Consultivo antes desse `select`. O trigger `provider_issuance_reserve` retrava a fatura no insert. `prepare` já recusa `external_source` não nulo com 409. |
| Emissão em curso | `lockIssuanceInvoice` | Lê `provider_issuance` sem `for update` e então trava a fatura. Chamado por `SandboxIssuance.Run`, `dispatch.go`, `provider_receipts.go` e `provider_resolution.go` | Consultivo no início de `lockIssuanceInvoice`, antes do `for update` da fatura. `provider_receipts.go` atualiza a fatura para `reconciling` depois dessa trava. |
| Resolução de emissão | `provider_resolution.go` | `lockIssuanceInvoice`, depois `for update of j` no journal, e pode inserir outra `provider_issuance` ou chamar `applyGatewayPayment` / `settle` | Coberto pelo helper dentro de `lockIssuanceInvoice` e de `paymentWithReview`. Não travar o journal antes da fatura. O `for update of j` de hoje já vem depois da fatura. |
| Operação do fornecedor | `PrepareProviderOperation` e `RunProviderOperation` em `finance/provider_operations.go`; retentativa em `modules/escrita/provider_operations.go` | `for update of i` e só então insert ou `for update` da operação | Consultivo antes do `for update of i`. `provider_operation_guard` retrava a fatura no insert. |
| Devolução confirmada | `ApplyProviderRefund` em `provider_refunds.go` | `for update` da fatura, insert de `payments` com `source='reconciliation'` e `provider_refund_id` (dispara `validate_payment_reversal`, que retrava a mesma fatura), depois status `reconciling` | Consultivo antes desse `for update`, e portanto antes do insert que dispara o trigger. A compensação não chama esta função. O insert não é estorno manual e não satisfaz a prova da baixa importada. |
| Efeitos de pagamento | `planPaidEffect` em `payment_effects.go` | fatura `for update`, depois efeito `for update skip locked`, depois recurso | Consultivo antes da fatura. O `skip locked` continua depois da fatura, então não ultrapassa a compensação que segura a fatura. |
| Avisos | `outbound.Notices`, helper `runNotices`, `apps/api-go/internal/outbound/sql/69b06ce3_5.sql` | nenhum lock de fatura antes do upsert em `notice_log` | Consultivo e `for update` da fatura antes do upsert. O GET bloqueia qualquer aviso da fatura, sem filtro `created_at > b.created_at`. Sem esta participação o aviso commita depois da revalidação. |
| Reimportação que reconhece a fatura | `importInvoice`, leitura `56aea313_1.sql` em `modules/escrita/sql` | `select` sem lock | Consultivo e `for update` antes de decidir `unchanged` e antes de inserir `import_rows`. Fecha `dependent_batches`. |
| Importação que cria outra fatura | `56aea313_3.sql` e, se pago, `56aea313_5.sql` | insert da fatura nova; a FK pega `FOR KEY SHARE` no contrato; o pagamento nasce na fatura nova, já invisível para o outro lote | Não trava as faturas antigas do contrato. O lote de títulos não é bloqueado por isso. |

Não participam do MVP, com a condição que os torna participantes se a condição cair:

- Seletor de emissão `apps/api-go/internal/finance/sql/5a7438b9_0.sql`: `for update skip locked` e `external_source is null`. Título importado não entra. Se o filtro sair, o seletor passa a precisar da ordem acima. O `update` seguinte, `5a7438b9_1.sql`, grava gateway na fatura e também passaria a depender do helper.
- `provisionBatch`: o SQL `3b7f6aa5_0.sql` liga `service_resources` ao lote. Lote de títulos não provisiona conta. Volta a ser participante no dia em que assinante ou contrato forem compensáveis, junto de `network.Request`.
- `finance.Generate`: insere mensalidade nova. Não atualiza a fatura importada. A unicidade de competência já impede outra mensalidade do mesmo contrato e mês.
- `importExtended`: o advisory de id externo serializa reimportação de contrato, rede, documento e usuário. Não protege título.

Prova operacional da corrida coberta pelo MVP. A compensação, a baixa manual e a emissão pedem o consultivo `7411005` e depois a mesma linha, nessa ordem. Uma espera. Quem segue relê debaixo do `for update`.

- Se a baixa commitou, a compensação vê pagamento fora da prova e responde 409 sem estornar. A mensagem atual de `finance.Manual`, quando a compensação commitou antes, é 400 `fatura não está em aberto`: o status deixou de ser `open` ou `reconciling`.
- Se `prepare` commitou, a compensação vê `provider_issuance_id` ou o guard `N6901` e desfaz o lote inteiro. Se a compensação commitou, `prepare` vê `external_source` não nulo ou fatura que o trigger `provider_issuance_reserve` recusa, e não grava journal.
- Não ficam, juntos, marcador de compensação e pagamento novo, nem marcador e `provider_issuance` nascido na corrida.

A inversão que este desenho proíbe: `invoicePayment` trava a linha no `select` de `financeiro.go` e só depois alguém pede o consultivo. A compensação segura o consultivo e espera a linha; a baixa segura a linha e espera o consultivo. As duas não terminam. Por isso o helper é a primeira sentença da transação que toca a fatura, inclusive antes do `select` já existente. O GET pode ter dito `eligible=true` antes dessa espera. O POST ignora esse resultado.

## Implementação futura

Dependências, nesta ordem. Nenhuma começa neste lote.

1. Confirmar o número da migração e criar só `import_batch_compensations` como acima. Sem `UPDATE` em lote, linha, pagamento ou movimento.
2. Extrair um helper, por exemplo `finance.LockInvoices(ctx, tx, tenant, ids)`, que executa os passos 1 e 2 com o sal `7411005`. Cada escritor da tabela o chama antes do primeiro `for update` ou `update` que já tem, não depois. Em `invoicePayment` isso é antes do `select id from invoices where id=$1 for update`. Em `prepare` é antes do `select` de `external_source`. `lockIssuanceInvoice` o chama antes de travar a fatura, e com isso cobre `Run`, `dispatch.go`, `provider_receipts.go` e `provider_resolution.go`. Diff mínimo em cada call site, sem mudar a regra de negócio de cada um.
3. `POST` em `apps/api-go/internal/modules/escrita/importacao.go` (registro ao lado de `importOperations`) e SQL novo só de leitura para a revalidação. A mutação reutiliza `finance.Reverse`, o `UPDATE` de cancelamento e `record`.
4. Estender o GET, em tarefa separada e pequena, com `compensation` lido do marcador, mantendo `reverted=false`.
5. Botão e motivo no painel `ImportBatchRevertEligibility`, só depois do POST existir. Verificação visual no fluxo da ficha do lote, desktop e estreito, com API real.
6. Testes da matriz. Até lá os comandos permanecem `planned/not_run`.

Arquivos previstos na implementação, sem abri-los agora:

- `db/migrations/00078_import_batch_compensations.sql` (número a confirmar);
- `apps/api-go/internal/finance/core.go` (helper de lock com sal `7411005`; `Reverse` permanece a única inserção de estorno manual da compensação);
- `apps/api-go/internal/modules/escrita/financeiro.go` (`invoicePayment` antes do `select` da linha 105, `invoiceReverse`, `invoiceCancel`, `invoiceResolve`, `contractAgreement`);
- `apps/api-go/internal/modules/escrita/provider_operations.go` (retentativa que faz `for update of i`);
- `apps/api-go/internal/modules/escrita/importacao.go` e um SQL de leitura novo ao lado de `apps/api-go/internal/modules/escrita/sql/56aea313_1.sql`;
- `apps/api-go/internal/finance/gateway.go`, `issuance.go` (`prepare` e `lockIssuanceInvoice`), `dispatch.go`, `payment_effects.go`, `provider_operations.go`, `provider_receipts.go`, `provider_resolution.go`, `provider_refunds.go`;
- `apps/api-go/internal/outbound/notices.go`, antes do upsert `apps/api-go/internal/outbound/sql/69b06ce3_5.sql`;
- `apps/api-go/internal/modules/leitura/import_revert_eligibility.go` quando o GET ganhar `compensation`;
- `apps/web/features/admin/import-batches.tsx`;
- `tests/contrato/import_compensate_contract.py`, chamado de `tests/contrato/nativo.py` no mesmo ponto em que `import_revert_eligibility_contract.py` já é chamado;
- teste Go focado `TestImportCompensate` no pacote da escrita ou do finance, para rollback, corrida e idempotência.

Aceite da implementação futura: a matriz JSON, mais a ausência de `DELETE` nos diffs, a revisão dos call sites da tabela de locks e a frase operacional em `docs/importacao-csv.md` continuando a dizer que a execução só existe depois que a rota estiver de fato publicada. Comandos concretos, ainda não executados:

- `python3 -I tests/contrato/nativo.py`
- `go test -count=1 -run TestImportCompensate ./internal/modules/escrita/`
- `go test -count=1 -run TestImportCompensate ./internal/finance/`

O primeiro exige o laboratório já usado pelo contrato nativo. Os outros dois são o lugar dos casos de corrida e de rollback que não cabem num único request HTTP.

## Decisões técnicas já fechadas e o que fica para produto

Fechado pela leitura do código e por este desenho:

- compensar com estorno e cancelamento locais; não apagar histórico;
- não chamar devolução nem cancelamento de PSP para baixa nascida em `56aea313_5.sql`;
- não reconstruir preimagem; `updated` e filhos sem id na linha bloqueiam;
- MVP só de `invoices`, atômico, repetível pelo marcador e pelo índice de uma reversão manual;
- revalidar depois do lock; o GET não autoriza;
- manter `external_id`;
- a lista de escritores, os triggers que retravam a fatura e a ordem consultivo `7411005` antes do `for update`.

Precisa de confirmação de produto antes de codar, com o default deste desenho entre parênteses:

- teto de linhas `created` (200);
- permissão só `import:run`, ou também `finance:write` (só `import:run` mais o escopo integral);
- lote de títulos já cancelados na origem grava marcador sem mexer na fatura (sim);
- algum dia liberar o id externo para reimportar do zero (não; o operador abre título novo pelo painel se precisar cobrar de novo);
- compensar assinante, contrato, PPPoE, histórico, rede, documento ou usuário (não, até uma importação futura gravar os ids dos filhos na hora do apply; essa gravação é outro desenho e não faz parte do MVP).

Não retomar planos pausados de outros lotes. Não alterar política de modelos nem o controlador. A operação descrita em `docs/importacao-csv.md` (corte de RADIUS, backup, relançamento manual no sistema antigo) continua sendo o procedimento vigente. Ela não ganha, por este desenho, um botão que desfaça o lote.
