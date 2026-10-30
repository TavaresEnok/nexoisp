# B04 — desenho do corte de leitura dos saldos reconstruídos

Este recorte desenha a promoção futura da leitura. O produto, o schema, os grants, os escritores e as migrações aplicadas permanecem como estão. A flag de corte permanece fechada. Nenhum leitor passa a responder com o saldo reconstruído neste recorte.

A base já entregue continua em `docs/LOTE03-B04-MOVIMENTOS.md` e na migração `db/migrations/00066_financial_movements.sql`. `payments.signed_cents` continua sendo a única fonte de dinheiro recebido. A comparação interna usa essa mesma fonte de propósito. Ela confirma que a soma dos movimentos e o estado da fatura batem com as colunas atuais. Ela não é extrato de PSP nem escrituração em partidas dobradas.

## Decisão

1. A resposta oficial continua na expressão legada de cada endpoint, lida na mesma transação e no mesmo escopo de tenant, portal e POP de hoje.
2. `financial_balance_shadow` e `financial_agreement_shadow` permanecem oráculo de conferência e de teste. O caminho quente de lista, detalhe, agregado e aviso não passa a ler a view.
3. A fórmula da leitura futura mora em `apps/api-go/internal/modules/leitura/queries/balance_shadow_compare.sql`, restrita aos `invoice_id` já escolhidos pelo leitor, igual à da view. O artefato `gen/balance_shadow_compare.sql.go` só muda por `sqlc`. Edição manual de gerado está fora do desenho. O pedido HTTP, quando a allowlist de shadow um dia incluir o leitor, executa uma variante em `leitura/shadow/`, fora do diretório que o `sqlc.yaml` lê. Essa variante é uma sentença só, com a projeção legada e as colunas `cmp_`. Ela não é enxertada no `.sql` que o modo desligado já executa.
4. A variável de processo `NEXO_BALANCE_READ` só poderá existir numa frente posterior. Os valores previstos são `off`, `shadow` e `cut`. Ausência, vazio e qualquer outro valor equivalem a `off`. As allowlists compiladas de `shadow` e de `cut` nascem vazias. Com allowlist vazia, os três valores executam somente a sentença legada de hoje e devolvem o corpo legado. O arquivo em `leitura/shadow/` não é enviado ao banco.
5. `cut` só entra na allowlist de um leitor depois do gate conjunto e de revisão independente. Leitor com `::int`, fórmula diferente, texto ao assinante, CSV, ou função compartilhada com escritor fica de fora dessa allowlist.
6. Divergência devolve o corpo legado inteiro. Não há mistura de campos, não há segunda leitura da view como substituto e não há correção silenciosa do número servido.
7. Escritores continuam decidindo baixa, estorno, acordo, importação e devolução pelas colunas da fatura e por `sum(signed_cents)` dentro do `for update` já existente. A sombra não entra nessa decisão.

`matches = false` em `financial_balance_shadow` bloqueia qualquer entrada futura na allowlist de corte de saldo, no escopo em que a linha divergente é visível. `source_unproven` ou `matches = false` em `financial_agreement_shadow` bloqueia leitura que trate o acordo como reconciliado. Acordo sem fonte comprovada não zera cobrável de fatura e não fabrica `agreement_sources`.

## Semântica que a consulta dedicada tem de preservar

A fórmula abaixo é a da view na migração 66. A consulta dedicada replica essa fórmula filtrando antes do agregado. Ela não cria outra definição de dinheiro.

| Grandeza | Coluna atual | Reconstrução | O que a comparação prova |
| --- | --- | --- | --- |
| Nominal | `invoices.amount_cents` | `sum(invoice_movements.nominal_delta)` | Igualdade no `matches` |
| Encargos lançados | `invoices.fee_cents` | `sum(fee_delta)` | Igualdade no `matches` |
| Desconto lançado | `invoices.discount_cents` | `sum(discount_delta)` | Igualdade no `matches` |
| Recebido assinado | `sum(payments.signed_cents)` | `sum(financial_payment_allocations.allocated_cents)` | As duas somas leem `signed_cents`. `kind = 'reversal'` guarda o valor negativo. A igualdade é identidade da mesma fonte |
| Estado | `invoices.status` | último `status_after` por `id` | Igualdade no `matches`. Domínio: `open`, `paid`, `reconciling`, `canceled` |
| Residual | não é coluna | `greatest(0, nominal + encargos - desconto - recebido)` | Fora do `matches` |
| Excesso | não é coluna | `greatest(0, recebido - (nominal + encargos - desconto))` | Fora do `matches`. Não vira crédito de outro contrato |
| Cobrável | não é coluna | `0` se `canceled`, senão o residual | Fora do `matches` |

`DueBreakdown` também devolve `fine_cents`, `interest_cents` e `fee_if_applied_cents`. Isso é prévia de multa e juros a partir de `tenant_settings` e dos dias de atraso. Não é `fee_cents` e não entra na sombra. Promover a prévia para encargos lançados mudaria acordo e baixa manual.

Cancelamento preserva nominal, encargos, desconto e recebimentos. O cobrável da sombra vai a zero. Estorno é outra linha `kind = 'reversal'` com `reversal_of`, `signed_cents` negativo e o mesmo tenant, a mesma fatura e o mesmo valor do recebimento original. Devolução de PSP confirmada grava essa linha com `source = 'reconciliation'`, `provider_refund_id` e `provider_return_id`, e em seguida marca a fatura `reconciling`. O efeito de rede (`payment_effects`) observa `status` e `settlement_version`. Ele não é fonte de centavos.

Acordo novo grava `agreement_sources` com nominal, encargos, desconto, recebido e `transferred_cents = nominal + encargos - desconto - recebido`. Os recebimentos antigos ficam na fatura original. As parcelas nascem sem alocação. A sombra de acordo marca `matches` só quando a soma transferida é igual a `original_cents`, a soma das parcelas é igual a `total_cents` e `total_cents = original_cents - discount_cents`. Sem linha em `agreement_sources`, `source_unproven` fica verdadeiro e `matches` fica falso.

`matches` do saldo não olha residual, excesso nem cobrável. Um corte que servisse cobrável com `matches` verdadeiro ainda assim precisa conferir esses três campos contra a expressão legada daquele leitor. Vários leitores filtram `status = 'open'`. Cobrável de fatura `reconciling` entra na sombra e fica fora de `open_cents`. A equivalência desses leitores é a soma do cobrável com o mesmo filtro de estado e de vencimento, não a soma de todo cobrável.

## Inventário dos leitores efetivos

Há três fontes editáveis e um artefato gerado:

- SQLC de leitura: editar `apps/api-go/internal/modules/leitura/queries/*.sql`. O comando `sqlc` grava `apps/api-go/internal/modules/leitura/gen/`. O cabeçalho desse diretório diz para não editar. `apps/api-go/sqlc.yaml` aponta o schema em `db/migrations` e essas queries. Por isso `gen/models.go` e `cadastro/gen/models.go` conhecem colunas da view. Isso é tipo gerado, não handler.
- SQL embutido de leitura dinâmica: editar `apps/api-go/internal/modules/leitura/dinamicas/*.sql`, carregado por `go:embed` em `dinamicas.go`.
- SQL embutido de escrita, financeiro e aviso: editar o `.sql` citado. `escrita/service.go` embute `sql/*.sql`. `finance/core.go` lê `finance/sql` só dentro de `query(nome, índice)`. `outbound` embute o SQL do aviso. Não há segunda cópia gerada desses arquivos. `DueBreakdown` não passa por `query`. `query("dueBreakdown")` não aparece em Go.
- SQL no próprio Go: `grupos.go` monta o total de `/api/contracts/{id}/finance` em string. Essa string é a fonte editável daquele total.

RLS já aplicado, e que a consulta dedicada precisa continuar atravessando com `security_invoker` no oráculo e com a fatura visível na consulta dedicada:

- tenant: `t_inv` e `t_pay` em `db/migrations/00003_financeiro.sql`
- portal: `portal_inv` e `portal_pay` em `db/migrations/00004_portal_importacao.sql`
- POP: `pop_invoices` em `db/migrations/00034_escopo_pop_aviso_documentos.sql`, pela visibilidade do contrato
- movimentos: `movements_visible` na migração 66, exigindo a fatura do mesmo tenant
- pagamentos não têm política POP própria. Soma de `payments` sem partir de uma fatura já filtrada ignora POP. A consulta dedicada soma `signed_cents` só da fatura já visível

Índices que a consulta por fatura pode usar, sem índice novo neste desenho:

- `invoice_movements_invoice` em `(tenant_id, invoice_id, id)` na migração 66
- `payments_invoice` em `(invoice_id) include (signed_cents)` em `db/migrations/00039_indices_de_escala.sql`
- `payments_tenant_invoice_identity_uq` em `(tenant_id, invoice_id, id)`, unicidade já criada pela migração 74 em `db/migrations/00074_provider_operations.sql`. A lateral de pagamentos busca `tenant_id` e `invoice_id` por igualdade; esse índice cobre as duas colunas na ordem da chave, e `payments_invoice` continua na migração 39 para o caminho em que `invoice_id` é a chave e `tenant_id` fica no filtro do mesmo scan
- `invoices_list` e `invoices_attention` na mesma migração 39, para a escolha das faturas, não para a sombra

### Coorte de saldo por fatura

Estes leitores expõem `paid_cents` ou residual de faturas em aberto. A resposta de hoje permanece. Uma frente futura pode acrescentar comparação em `shadow` depois que a consulta dedicada existir. `cut` continua fechado enquanto o campo for `::int` ou o agregado couber em `int`.

| Rota | Permissão | Função | Fonte editável | Artefato | Expressão servida |
| --- | --- | --- | --- | --- | --- |
| `GET /api/invoices/{id}` | `finance:read` | grupo em `grupos.go`; prefixo `Group91a4cc44` | `queries/group91a4cc44_0.sql` | `gen/group91a4cc44_0.sql.go` | `paid_cents = sum(signed_cents)::int` da fatura. Itens em `_1.sql` e linhas de pagamento em `_2.sql` não são saldo reconstruído. Eventos de gateway em `_3.sql` não têm centavos |
| `GET /api/contracts/{id}/finance` | `finance:read` | `grupos.go`, ramo do path | lista em `queries/groupc47037ac_0.sql`; totais na string de `grupos.go` | `gen/groupc47037ac_0.sql.go` para a lista | Lista: `paid_cents::int`. Totais: `nominal_open_cents`, `received_open_cents`, `received_cents`, `open_cents` e `overdue_cents` em `bigint`, só com `status = 'open'` no residual |
| `GET /api/finance/reconciliation` | `finance:read` | `grupos.go` | `queries/group152f5ccd_0.sql` | `gen/group152f5ccd_0.sql.go` | Faturas `reconciling` com `paid_cents::int`. `_1.sql` lista `gateway_events` e fica fora do corte |
| `GET /api/finance/summary` | `finance:read` | consulta gerada | `queries/readf038858e.sql` | `gen/readf038858e.sql.go` | `open_cents` e `overdue_cents` em `bigint` para `open`. `received_month_cents` é caixa do mês em `::int`, não saldo de fatura |
| `GET /api/invoices` | `finance:read` | `dinamicas.go` `invoices` | `dinamicas/4a483e96_1.sql` | nenhum; o SQL é o embed | `paid_cents::int`. `_0.sql` só calcula a data local |

### Agregados com a fórmula de residual e cast `int`

Comparação futura em `shadow` pode existir. A allowlist de `cut` não os recebe enquanto o cast `::int` puder falhar acima de 2147483647 centavos e enquanto o corpo JSON mudar de tipo. O modo `shadow` só roda se a expressão legada conclui. Estouro do `::int` continua falhando a requisição como hoje.

| Rota | Permissão | Função | Fonte editável | Expressão servida |
| --- | --- | --- | --- | --- |
| `GET /api/today` | `subscribers:read` | `today.go` sobre o embed | `dinamicas/8d9dae54_3.sql` | `overdue_cents::int` de faturas `open` vencidas |
| `GET /api/contracts/{id}/termination-quote` | `contracts:read` | `dinamicas.go` `terminationQuote` | `dinamicas/4facfb98_0.sql` | `open_cents::int` com nominal, encargos, desconto e recebido, só `open`. O total da resposta soma esse valor à multa de fidelidade |

### Leitura compartilhada com escritor

`GET /api/invoices/{id}/due` entra no ramo desse path em `auxiliares.go` e chama `leitura.DueBreakdown`. A função executa `tx.Objects(ctx, gen.Due, id)`. `gen.Due` está em `apps/api-go/internal/modules/leitura/gen/due.sql.go`, gerado por sqlc a partir de `apps/api-go/internal/modules/leitura/queries/due.sql`. Multa, juros, `fee_if_applied_cents` e `remaining_cents` são calculados em Go dentro de `DueBreakdown`, depois da query.

`finance.Agreement` em `advanced.go` e `finance.Manual` em `core.go` chamam a mesma `DueBreakdown`. O SQL vivo dos dois escritores e do GET é `queries/due.sql`. O artefato gerado é `gen/due.sql.go`. Edição manual desse artefato está fora do desenho.

`apps/api-go/internal/finance/sql/c59c1801_0.sql` repete o texto e `finance/financeiro.json` o cita em `helper:dueBreakdown`. Nenhuma chamada executa esse helper. O arquivo é cópia inerte. Nenhuma frente o edita, o registra em `query` nem o usa como fonte de `DueBreakdown`.

O corte dessa URL só existe depois que o GET deixar de ser o mesmo ponto de entrada dos escritores. `DueBreakdown` permanece sem flag e continua executando `gen.Due`. A comparação do GET usa outro arquivo, descrito na estratégia de shadow.

### Escritores que leem saldo e ficam fora do corte

| Caminho | Fonte editável | Leitura | Por que fica |
| --- | --- | --- | --- |
| `finance.settle` | `finance/sql/c810a196_1.sql` | `sum(signed_cents)::int` contra `amount + fee - discount` da linha bloqueada | Decide `paid`, `open` ou `reconciling` e dispara `Paid` |
| `finance.Reverse` | `finance/sql/48002566_3.sql` | a mesma soma depois do estorno manual | Uma reversão integral de baixa manual. Gateway volta pelo gateway |
| `finance.Agreement` | `advanced.go` chama `leitura.DueBreakdown`, que executa `gen.Due` de `queries/due.sql` | residual para `agreement_sources.transferred_cents` | Escritor. A prévia de juros não pode ser trocada pela sombra. A cópia `finance/sql/c59c1801_0.sql` não é a fonte |
| `helper:importInvoiceRow` | `escrita/sql/56aea313_1.sql` | `sum(signed_cents)::bigint` com `tenant_id` | Decide a linha importada. Dono funcional já coberto por B13 |
| `helper:terminationQuote` no encerramento | `escrita/sql/4facfb98_0.sql`, chamado por `escrita/contratos.go` | `sum(amount_cents)::int` das faturas `open` | O Go do encerramento não lê `open_cents` para a multa. A fórmula é só nominal. É outra consulta, homônima da do GET |

### Leitores fora da coorte

Estes calculam dinheiro e continuam na expressão própria. Não há tarefa de corte para eles neste DAG.

| Rota ou caminho | Fonte editável | Motivo de ficar fora |
| --- | --- | --- |
| `GET /api/finance/monthly` | `queries/group3a79e37d_0.sql` | Caixa por `paid_at`, `sum(signed_cents)::int`, sem saldo de fatura e sem filtro POP em `payments` |
| `GET /api/dashboard/panels` | `dinamicas/9603e721_4.sql` | Caixa do dia, `sum(signed_cents)::bigint::float` |
| `GET /api/finance/reports/receipts` | `escrita/sql/b92a2082_1.sql` | Caixa agrupado, mesma soma em float |
| `GET /api/finance/reports/aging` | `escrita/sql/d634dac7_1.sql` | `due_cents` pode ficar negativo no excesso e segue como float. Residual da sombra esconderia o excesso |
| `GET /api/finance/reports/to-cancel` | `escrita/sql/dafcc056_1.sql` | Soma nominal + encargos - desconto, sem recebimento |
| `GET /api/finance/export` | `escrita/sql/c5014101_0.sql` e `c5014101_1.sql` | CSV com documento do assinante. Pagamentos são linha assinada. Títulos usam `valor_pago::int` |
| `GET /api/portal/overview` | `queries/overview_2.sql` | Lista `amount_cents` e `status`. Não calcula residual. Trocar o valor exibido muda o contrato do assinante |
| `GET /api/dashboard` | `queries/dashboard_0.sql` | `mrr_cents` é preço de plano ativo, não saldo de fatura |
| avisos | `outbound/sql/69b06ce3_3.sql`, texto em `outbound/notices.go` | `due_cents` pode ser negativo e segue para mensagem ao assinante |
| `GET /api/import/batches/{id}/reconciliation` | `leitura/import_reconciliation.go` | `open_residual_cents = greatest(amount_cents - received, 0)` para `open` e `reconciling`, sem encargos nem desconto. B13 já é dono dessa leitura |
| detalhe de pagamento | `queries/group91a4cc44_2.sql` | Linha de `payments`, inclusive `signed_cents`, `kind` e `reversal_of`. É o razão de caixa, não a sombra |

Nenhum handler de produto consulta `financial_balance_shadow`. As leituras atuais da view estão em teste: `tests/contrato/financial_movements.py`, `financial_movements_migration.py`, `payment_effects.py`, `provider_contract.py`, `issuance_conflicts.py`, `import_compensate_contract.py`, `finance/provider_refunds_test.go` e `escrita/import_compensate_test.go`.

## View ou consulta dedicada

A view agrega todos os `invoice_movements` visíveis e todas as alocações visíveis e só depois junta na fatura. Num `GET` de uma fatura ou numa lista paginada, esse formato pode somar o histórico inteiro do tenant antes de filtrar. `security_invoker = true` preserva RLS e não empurra sozinho o `invoice_id` para dentro do `GROUP BY`. No painel, a view ainda somaria movimentos de faturas pagas e canceladas que o SQL atual nem visita: ele parte de `status in ('open', 'reconciling')` e do índice `invoices_attention`.

A consulta dedicada parte dos ids que o leitor já selecionou e faz duas laterais por fatura: soma dos deltas em `invoice_movements` com `tenant_id` e `invoice_id`, no índice `invoice_movements_invoice`; soma de `signed_cents` em `payments` com os mesmos predicados. Em pagamentos o plano natural pode usar `payments_invoice` ou a unicidade `payments_tenant_invoice_identity_uq` da migração 74. Os dois servem a mesma busca seletiva quando o catálogo mostra chave capaz de localizar `invoice_id`. Residual, excesso, cobrável e `matches` copiam a expressão da view, inclusive o `is true`. Movimento ausente deixa a soma nula e `matches` falso. A resposta permanece a legada. Não se coalesce nominal ausente para zero para “fechar” a conta.

O oráculo do teste é a própria view, na mesma transação e com o papel `nexo_app`, para os mesmos ids. A frente da consulta só fica aceita quando os números da lateral e os da view coincidem nas fixtures não vazias e quando o `EXPLAIN ANALYZE BUFFERS` de um id e de uma página, com `enable_seqscan=on` e volume representativo, mostra acesso indexado correlacionado. No mesmo nó de scan de `invoice_movements` alias `mv` e de `payments` alias `py`, `invoice_id` restringe o índice ao `i.id` externo e `tenant_id` restringe ao `i.tenant_id` externo. Se `tenant_id` não for chave, o filtro desse próprio scan basta. Índice de nome diferente entra só depois de `pg_index`, `pg_class`, `pg_attribute` e `pg_get_indexdef` mostrarem índice válido, pronto, na relação certa, com chaves adequadas e predicado satisfeito pelas igualdades da lateral. Presença do nome, texto de RLS, subplan ou condição repartida entre nós não prova o acesso. Se o plano vier em varredura da tabela de movimentos para um único id, a frente para. Índice novo, se ainda for necessário, entra em migração posterior, nunca editando a 66, e só com esse `EXPLAIN` anexado. Este desenho não cria índice, grant nem view nova. A corrida `7cde1e6` observou `invoice_movements_invoice` e `payments_tenant_invoice_identity_uq` com `Index Cond ((tenant_id = i.tenant_id) AND (invoice_id = i.id))` e permanece falha histórica do verificador que exigia o nome `payments_invoice`. Ela não é reclassificada como aceite. Naquele momento o critério `explain-indices` aguardava corrida nova; a execução posterior `6963214` está registrada na matriz.

Custo esperado da lateral, no dia em que a variante chegar a rodar, é o custo que os leitores já pagam na soma de pagamentos, mais uma soma indexada de movimentos daquelas faturas. Isso é menor do que materializar a sombra do tenant em cada request. Com a variável desligada ou com a allowlist vazia, essa soma de movimentos não entra na sentença enviada ao banco.

## Ativação, recuo, concorrência, discrepância e observação

O SQL legado da coorte permanece a sentença do modo desligado. A lateral não é inserida em `group91a4cc44_0.sql`, `groupc47037ac_0.sql`, `group152f5ccd_0.sql`, `readf038858e.sql`, `due.sql` nem nos embeds `4a483e96_1.sql`, `8d9dae54_3.sql` e `4facfb98_0.sql`. Esses arquivos fazem `select i.*` ou devolvem a linha inteira em JSON. Uma coluna extra no mesmo arquivo apareceria no corpo com a flag desligada, porque `tx.Objects` materializa toda coluna.

A comparação mora num arquivo novo, um por leitor, em `apps/api-go/internal/modules/leitura/shadow/`. Esse diretório fica fora de `apps/api-go/sqlc.yaml`, cujo `queries` é só `internal/modules/leitura/queries`. Assim a variante não regenera `gen/` e não altera `gen.Due` nem as constantes `Group*` e `Readf038858e`. Não há artefato gerado da variante e ninguém edita `gen/` à mão. A fórmula da lateral tem uma fonte editável, `queries/balance_shadow_compare.sql`, gerada por sqlc só na frente L1. Cada variante copia essa fórmula. O teste da frente dona exige o mesmo texto de expressão. Não há segunda definição de dinheiro em Go.

`Pick(leitor, legado)` em `balance_read.go` escolhe uma sentença:

- `off`, valor desconhecido, ou leitor fora da allowlist do modo: devolve a string legada. O arquivo de `shadow/` não é executado.
- `shadow` com o leitor na allowlist de shadow: devolve a variante registrada. Essa variante é a única sentença daquela leitura, no mesmo `WithScope`. Ela projeta as colunas legadas e as colunas `cmp_*`. A sentença legada não roda em seguida.
- variante ausente com o leitor já na allowlist: a requisição falha. `Pick` não substitui a variante faltante pela sentença legada.
- `cut` com allowlist vazia: devolve a sentença legada. Nenhum front C troca o centavo servido. Troca de campo fica para depois do gate G, com allowlist ainda vazia neste desenho.

`Strip` remove toda chave com prefixo `cmp_` antes de a linha entrar no valor HTTP. O corpo servido continua sendo as colunas legadas, tanto quando `cmp_matches` é verdadeiro quanto quando algum campo diverge. Divergência só incrementa `mismatch`. Se uma chave `cmp_` aparecer com o modo desligado, a requisição falha e o corpo não sai. Os leitores que publicam a linha crua, e por isso vazariam coluna, são o detalhe da fatura (`rows[0]`), a lista do contrato, as faturas da conciliação, a lista `GET /api/invoices`, o objeto de `GET /api/finance/summary` e os totais do contrato. `today`, a cotação de encerramento e o GET due montam o mapa por nome; ainda assim usam `Pick` e `Strip`, para o modo desligado continuar na sentença atual.

O wrapper nasce na L1, com allowlists vazias e teste próprio, sem endpoint novo. As frentes C só registram a variante em arquivo próprio. Elas não aprovam a L1.

Recuo é voltar a variável para `off` ou `shadow` e reiniciar o processo. Não há migração reversa, não há reescrita de saldo e o SQL legado permanece no binário.

Concorrência: no modo desligado há uma sentença, a legada. No shadow allowlisted há uma sentença, a variante. Duas queries separadas enxergariam commits diferentes em `READ COMMITTED`, então a comparação não é uma segunda ida ao banco. O leitor não toma `for update` novo. Quem escreve continua em `LockInvoices` e lê `signed_cents` na transação que já segura a fatura. A sombra não participa dessa decisão porque o agregado da view não está preso à linha.

Discrepância não escolhe o maior valor, não preenche campo a campo e não relê a view para “corrigir” a resposta. `matches = false` no escopo visível mantém a allowlist de corte sem aquele leitor. Drift injetado em teste, com trigger desligada, precisa aparecer como `matches` falso e sumir no `rollback`, como `financial_movements.py` já exige.

Observabilidade, quando `shadow` um dia rodar: contador `balance_read_compare_total` com rótulos `reader` e `result` (`match`, `mismatch`). Sem `tenant_id`, sem `invoice_id` e sem valor no rótulo. O log de mismatch, se houver, leva leitor, `tenant_id`, `invoice_id`, `matches` e os nomes dos campos. Ficam de fora nota, documento, identificador de gateway, segredo, corpo de PSP e os centavos. Ambiente de laboratório pode guardar a diferença em artefato local do teste, não em métrica.

## Pontos de chamada

O metadado gerado continua apontando para a sentença legada. `grupos_generated.go` e `consultas_generated.go` estão marcados como gerados e não se editam. Trocar a constante ali faria a variante rodar em todo request.

| Leitor | Quem executa hoje | Sentença legada | Variante futura | Quem registra a variante |
| --- | --- | --- | --- | --- |
| detalhe da fatura | `grupos.go` `grupo`, ramo que contém `/api/invoices/{id}`, só `query(0, id)`; `rows[0]` é o corpo. Itens, pagamentos e eventos seguem nos índices 1 a 3 | `gen.Group91a4cc440` em `grupos_generated.go`, vindo de `queries/group91a4cc44_0.sql` | `shadow/group91a4cc44_0.sql` | `variants_sqlc.go` |
| lista do financeiro do contrato | o mesmo `grupo`, ramo `/api/contracts/{id}/finance`, `query(0, id)` | `gen.Groupc47037ac0` em `grupos_generated.go` | `shadow/groupc47037ac_0.sql` | `variants_sqlc.go` |
| totais desse financeiro | string inline em `grupos.go`, no mesmo ramo, hoje em `tx.Objects` | depois da L1, a mesma string em `contract_finance_totals.go` | `shadow/contract_finance_totals.sql` | `variants_inline.go` |
| conciliação | `grupos.go`, ramo `/api/finance/reconciliation`, só o índice 0, chave `invoices`. O índice 1 permanece `gen.Group152f5ccd1` | `gen.Group152f5ccd0` | `shadow/group152f5ccd_0.sql` | `variants_sqlc.go` |
| resumo | `consultas.go`, a chamada `s.rows` só quando `spec.Path` é `/api/finance/summary`; `first(rows)` é o corpo | `gen.Readf038858e` em `consultas_generated.go` | `shadow/readf038858e.sql` | `variants_sqlc.go` |
| lista de faturas | `dinamicas.go` `invoices`, só `dynamicSQL("/api/invoices", 1, ...)` | embed `dinamicas/4a483e96_1.sql`, índice 1 de `dinamicas.json`. Os índices 0 e 2 ficam | `shadow/4a483e96_1.sql`, embed próprio, sem entrar na lista de `dinamicas.json` | `variants_dinamicas.go` |
| hoje | `today.go`, só `one(3)` no bloco `finance:read`. Os outros índices de `/api/today` ficam | embed `dinamicas/8d9dae54_3.sql` | `shadow/8d9dae54_3.sql` | `variants_c2.go` |
| cotação de encerramento | `dinamicas.go` `terminationQuote`, só `complexRows` de `helper:terminationQuote` índice 0 | embed `dinamicas/4facfb98_0.sql` | `shadow/4facfb98_0.sql` | `variants_c2.go` |
| GET due | `auxiliares.go`, ramo `/api/invoices/{id}/due` | `gen.Due`, de `queries/due.sql` | `shadow/due.sql`, executada só por `due_http.go` | `variants_due.go` |

`grupos.go` é compartilhado pelos ramos genéricos. Por isso a L1 é a única frente que o edita: o fechamento `query` passa o índice 0 daqueles três paths por `Pick`, e o ramo do contrato chama `contract_finance_totals.go`. C1-sqlc e C1-inline não alteram `grupos.go`. A L1 também é a única que toca `consultas.go`, `dinamicas.go` e `today.go`, e só nos pontos da tabela. `dynamicSQL` em si não muda, para os outros paths dinâmicos continuarem iguais.

## DAG

As frentes abaixo eram trabalho futuro quando este desenho foi escrito em `728f2ff`. Este recorte de desenho não as executa. Cada uma tem aceite próprio. O gate conjunto não devolve aceite para a consulta, e a consulta não espera os endpoints para ser aceita. O código que depois entrou na worktree está inventariado em `docs/LOTE29-B04-BASE-SHADOW.md` e não herda aceite deste arquivo.

```text
L1 consulta, Pick/Strip, ganchos e allowlists vazias
   |-- C1-sqlc
   |-- C1-dinamicas
   |-- C1-inline
   |-- C2-agregados
   \-- C3b variante do GET due
C3a DueHTTP delega a DueBreakdown (sem depender de L1)
   \-- C3b
L1, C1-sqlc, C1-dinamicas, C1-inline, C2, C3a, C3b e a matriz executada
   \-- G gate conjunto
```

| Frente | Arquivos | Aceite próprio | Paralelo com |
| --- | --- | --- | --- |
| L1 | `queries/balance_shadow_compare.sql`; `gen/balance_shadow_compare.sql.go` só via sqlc; `balance_read.go`; `contract_finance_totals.go` com a string movida de `grupos.go`; ganchos em `grupos.go`, `consultas.go`, `dinamicas.go` e `today.go` | Lateral igual à view nas fixtures; `EXPLAIN` prova o scan correlacionado de movimentos e de pagamentos, e índice equivalente da migração 74 só entra com prova de catálogo; com allowlist vazia, `Pick` devolve a sentença legada e o corpo não ganha `cmp_`; os `.sql` legados ficam sem diff | nenhuma; é a primeira |
| C1-sqlc | `shadow/group91a4cc44_0.sql`, `shadow/groupc47037ac_0.sql`, `shadow/group152f5ccd_0.sql`, `shadow/readf038858e.sql`, `variants_sqlc.go` | Registro dos quatro ids. Diff vazio nos `.sql` de `queries/` e em `grupos.go`. Modo desligado executa `gen.Group91a4cc440`, `gen.Groupc47037ac0`, `gen.Group152f5ccd0` e `gen.Readf038858e` | C1-dinamicas, C1-inline, C2, depois de L1 |
| C1-dinamicas | `shadow/4a483e96_1.sql`, `variants_dinamicas.go` | O embed atual e `dinamicas.json` ficam. `Pick("invoice-list")` com modo desligado devolve `dynamicSQL("/api/invoices", 1, ...)` | as outras C1 e C2 |
| C1-inline | `shadow/contract_finance_totals.sql`, `variants_inline.go` | Não edita `grupos.go` nem `contract_finance_totals.go`. A variante, por dentro, repete a string legada e acrescenta `cmp_` | as outras C1 e C2 |
| C2 | `shadow/8d9dae54_3.sql`, `shadow/4facfb98_0.sql`, `variants_c2.go` | Não edita `today.go` nem `dinamicas.go`. Fora da allowlist de corte enquanto houver `::int` | C1 |
| C3a | cria `due_http.go` e troca só o ramo GET de `auxiliares.go` para `DueHTTP`. Vigia `queries/due.sql`, `gen/due.sql.go`, `core.go` e `advanced.go` | `DueHTTP` delega a `DueBreakdown`. Agreement e Manual seguem chamando `DueBreakdown` e portanto `gen.Due`. `queries/due.sql` sem diff. `gen/due.sql.go` sem edição manual. `query("dueBreakdown")` continua sem chamada. `c59c1801_0.sql` e `financeiro.json` permanecem intocados | L1 e C1 |
| C3b | `due_http.go`, `shadow/due.sql`, `variants_due.go` | Não edita `queries/due.sql`, `gen/due.sql.go` nem `DueBreakdown`. A prévia de multa e juros continua em `DueBreakdown`. O mapa devolvido a Agreement e Manual continua o dessa função | nenhuma com C3a; depois de L1 e C3a |
| G | revisão deste desenho e de `docs/B04-ACEITE-CORTE-LEITOR.json` | Só documenta abertura de allowlist. Não edita produto sozinho. Allowlist de corte continua vazia se algum item da matriz estiver vazio ou se algum leitor inseguro for candidato | depende de todas as anteriores |

C1 não aprova L1. G não aprova L1 nem C3a. C3b não aprova C3a. C1-sqlc e C1-inline não compartilham `grupos.go`: a L1 instala o gancho e cada uma só acrescenta o arquivo em `shadow/` e o `variants_*.go` correspondente. Não há frente para mensal, recibos, aging, a cancelar, exportação, portal, avisos, reconciliação de importação, acordo como tela, índice, grant, escritor, edição de `grupos_generated.go`, edição de `consultas_generated.go`, edição manual de `gen/` ou ativação de `finance/sql/c59c1801_0.sql`. Essas ausências são o limite do DAG, não vagas por preencher.

Critério para um id entrar um dia na allowlist de corte: SQL editável em `bigint`; campo servido definido como recebido, residual ou cobrável com o mesmo filtro de estado do endpoint; prova não vazia de `open`, `paid`, `reconciling`, `canceled`, parcial, excesso e estorno; `matches` falso devolve o corpo legado inteiro; função não compartilhada com escritor; `EXPLAIN` da L1 aceito pela correlação no mesmo scan e pela estrutura no catálogo, incluindo a equivalência da migração 74; RLS de tenant, portal e POP com contagem zero no escopo alheio e um no escopo próprio; revisão independente. Enquanto isso faltar, o id permanece fora da allowlist.

## Matriz e gates que já existem

A matriz executável está em `docs/B04-ACEITE-CORTE-LEITOR.json`. Na data deste desenho nenhum critério era marcado como executado; a matriz registra as provas posteriores. O registro posterior do lote 29, em `docs/LOTE29-B04-BASE-SHADOW.md`, também mantém `executado` falso.

Os gates já existentes, que continuam sendo a execução e que este desenho não reimplementa:

- `python3 tests/contrato/nativo.py`, com `NEXO_PAYMENT_LAB=1`, que inclui `tests/contrato/financial_movements.py`
- `NEXO_PAYMENT_LAB=1 python3 tests/contrato/financial_movements_migration.py`

`financial_movements.py` já exige acordo parcial autenticado, encargos, desconto, recebimento parcial, estorno, excesso, recusa de mutação, rollback conjunto, RLS de tenant, portal e POP, e drift com trigger desligada. `financial_movements_migration.py` já exige abertura histórica na subida 65 para 66, repetição do prepare, acordo antigo `source_unproven` com `matches` falso e drift sintético revertido. Refund de PSP, importação e compensação de lote têm donos em `provider_refunds` e na compensação B13. A matriz pede prova não vazia desses estados nesses testes já existentes, ou num acréscimo mínimo dentro dos dois gates acima. Não há runner novo.

Cada linha da matriz exige contagem maior que zero do estado pedido, ou o par antes e depois no rollback e no drift. Conjunto vazio, tenant sem acordo e amostra só de faturas `open` não fecham a linha.

## Prova sintética 0086558 e o restore

A gerência leu o laboratório sintético do commit `0086558` com papel `nexo_go` não privilegiado. No tenant alfa havia 23 faturas e 23 linhas de sombra, sem drift. Beta estava em zero. Acordos estavam em zero. O artefato citado é `implementacao-codex/lote27-b13-http-restore-2026-10-29/evidencias/b04-comparacao-sintetica-0086558.json`. Esse arquivo não está nesta worktree. Esta entrega não reexecuta o laboratório e não promove esse relato a aceite.

Essa amostra não exercita acordo comprovado, acordo `source_unproven`, estorno, excesso, refund, importação, compensação, rollback, RLS de portal e POP, nem drift injetado. Zero acordos não valida a sombra de acordo. Relatórios Go, browser do lote 26 e restore do lote 27 não homologam ledger externo. O restore prova o contrato HTTP já definido para B13 no laboratório. Ele não autoriza corte de leitura nem publica extrato de PSP.

## Limites

- A migração 66 permanece intacta, inclusive o `Down` que recusa apagar o histórico.
- `docs/LOTE03-B04-MOVIMENTOS.md` e o histórico dos lotes 24, 25, 26 e 27 permanecem intactos.
- B02 a B13 entregues não são reimplementados.
- Não há escritor novo, grant novo, flag ligada, schema novo, dado real, PSP nem rollout.
- Recebido da sombra e recebido legado compartilham `signed_cents`. A comparação é interna.
- Não há homologação, publicação, percentual de conclusão nem critério executado sem prova.
- A gerência registra revisão independente Sonnet do texto deste desenho no commit `728f2ff`. Essa revisão não executa teste, não preenche a matriz e não abre allowlist. Revisão do código integrado continua exigida antes de um leitor entrar na allowlist.

## Estado lido no lote 29

O texto acima é o contrato desenhado em `728f2ff`. O código posterior está integrado na worktree de desenvolvimento e inventariado em `docs/LOTE29-B04-BASE-SHADOW.md`. `NEXO_BALANCE_READ` existe. As allowlists compiladas de shadow e de cut estão vazias, então a resposta servida continua a sentença legada. Variantes registradas não são entrada na allowlist. O gate G desta fase só documenta esse alcance. Ele não aprova L1 nem C3a e não altera produto.

### Recorte documental do gate G no lote 38

O `verify` existente passa a exercitar a decisão de candidatura com amostra visível não vazia, drift transacional e rollback. A candidatura não autoriza corte: demais gates e revisão continuam necessários. Na redação do lote 38, a execução PostgreSQL real estava pendente; a execução posterior é registrada em `docs/LOTE39-B04-PROVAS-CONSOLIDADAS.md`.
