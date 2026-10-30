# Parecer financeiro — revisão estática de 2026-10-30

## Veredito e base

**Direção técnica favorável, com uma inconsistência interna relevante no estorno manual que merece lote corretivo próprio antes de ampliar o uso operacional. Este parecer não homologa dinheiro externo nem autoriza abertura de gates.** B13 e B07 apresentam mecanismos concretos de atomicidade, deduplicação e recuperação; B04 permanece deliberadamente sem corte de leitura. A existência desses mecanismos e de CI aprovado não elimina o achado abaixo.

Base de produto solicitada: `3ba3f7634e9623ffc8e30b15c618e2b904e63d13`. A worktree estava limpa em `7f43b7bc3c81d6791044bfcd479743d7c00b050a`, com o relatório geral documental. A comparação de `apps/api-go` e `db/migrations` entre a base solicitada e HEAD não apresentou diferenças. As referências de linha abaixo são relativas à raiz do repositório e correspondem ao código lido nesta worktree.

Revisão exclusivamente estática. Foram percorridos handlers, SQL efetivamente carregado pelos manifestos, transações, migrations e testes específicos. Documentos foram tratados como alegações e evidência histórica atribuída, sem executar seus comandos. O CI aprovado no SHA de produto é premissa informada pelo solicitante, não uma execução desta revisão. Não houve banco, Docker, rede externa, produção, credenciais, push, deploy, merge ou alteração de produto/testes. Nenhum teste novo foi escrito ou executado.

## Achado priorizado

### F1 — Alta: estorno manual torna elegível à inadimplência uma fatura que continua integralmente coberta

**Local:** `apps/api-go/internal/finance/core.go:295`, `:304` e `:307`; SQL final em `apps/api-go/internal/finance/sql/48002566_4.sql:1`. O handler alcançável é `apps/api-go/internal/modules/escrita/financeiro.go:163`.

**Cenário verificável, sem depender de PSP:** numa fatura nominal de 10.000 centavos, sem encargos/desconto, registrar baixa manual A de 12.000. `Manual` permite recebimento na fatura aberta e `settle` envia o excesso para `reconciling`. Registrar baixa manual B de 10.000, com outra intenção: `Manual` também aceita `reconciling` (`core.go:223`), ficando o recebido em 22.000 e a fatura em conciliação. Estornar A integralmente pela rota manual. Ambos os recebimentos são positivos, os estados são aceitos e o estorno corresponde integralmente ao original; não é necessário alterar diretamente o banco para chegar ao cenário.

**Resultado demonstrável pelo fluxo:** o lançamento negativo de 12.000 preserva corretamente o caixa líquido em 10.000. A função lê essa soma, mas a usa apenas na nota e no retorno. O SQL seguinte grava incondicionalmente `status='open'` e `paid_at=null`, e a resposta também fixa `open`. Não compara o restante com nominal + encargos − desconto, nem mantém a exigência de conciliação. Se B fosse de 12.000, haveria ainda excesso de 2.000 com o mesmo estado aberto. O problema não é permitir contabilizar excesso; é converter automaticamente esse caso em candidato à inadimplência.

**Consequência e encadeamento:** `apps/api-go/internal/finance/sql/f7267ee2_0.sql:6` seleciona inadimplência por `status='open'` e vencimento, sem exigir residual positivo. A releitura em `f7267ee2_1.sql:1` verifica novamente apenas o estado aberto. Em `finance/gateway.go:279` em diante, para fatura manual sem gateway demo, o fluxo pode planejar `subscriber.suspend` apesar de o recebido líquido cobrir a obrigação. Isso depende de política automática habilitada, vencimento, recurso e demais condições; não se afirma suspensão física executada ou gate de hardware aberto nesta revisão. Há também estado de cobrança incoerente com o saldo zero antes de qualquer ação técnica.

**Evidência e limites:** `core.go:154` calcula o devido e distingue quitação, parcial e divergência no recebimento; o estorno não reaplica esse critério nem encaminha o caso à decisão explícita. `db/migrations/00073_provider_refunds.sql:25` valida o original e a correspondência do estorno manual, mas não corrige o estado econômico da fatura. A migração 66 registra fielmente a mudança para aberto: B04 pode continuar com `matches=true`, pois compara reconstrução com estado legado, não valida a decisão comercial. O fixture de excesso em `modules/leitura/balance_read_gate_test.go:143` inclusive aceita aberto com excesso, evidenciando esse limite do comparador. Isso não é um defeito do comparador nem prova de segurança da automação de inadimplência.

**Encaminhamento futuro:** definir e testar a decisão após estorno quando o líquido fica abaixo, igual ou acima do devido, incluindo conciliação anterior e elegibilidade de cobrança automática. O critério mínimo deve impedir tratar saldo coberto como inadimplência apenas porque o estorno abriu a fatura. Não foi implementada correção nem executado o cenário; a conclusão é derivada das condições e SQL acima. Não se exige nesta revisão uma política específica para aprovar automaticamente excessos.

## Pontos sólidos e fluxo examinado

### Baixa manual, idempotência e dinheiro

Em `modules/escrita/financeiro.go:111`, a baixa adquire o protocolo comum e relê a fatura visível antes de criar/ler `manual_payment_intents`. A chave é única por tenant; fatura, ator e hash do corpo são conferidos, e resultado já persistido é repetido sem chamar `Manual` novamente. `db/migrations/00064_manual_payment_intents.sql:4` não expira a deduplicação. A política restritiva liga a intenção à fatura visível, portanto a restrição de POP decorre também da RLS de invoices; não há evidência, nesse caminho HTTP, de leitura livre entre provedores.

`modules/escrita/service.go` envolve handler e auditoria em `DB.WithScope`; `db/db.go:159` só faz commit após callback sem erro. Baixa, resultado da intenção e auditoria confirmam juntos. Uma resposta perdida depois do commit tem recuperação pela mesma intenção; um erro do commit não pode ser tomado pelo cliente como certeza de ausência da baixa. O fluxo de `apps/web/features/finance/payment-intent.ts` conserva a intenção persistida para reenvio. Isso reduz duplicação por retry, sem impedir que um operador registre uma operação nova com outra intenção — autorização comercial e intenção técnica são coisas distintas.

`finance/core.go:154` mantém nominal separado do recebido; parcial positivo pode conservar aberto e excesso vai para conciliação. O desconto é acumulado, exige motivo e tem teto, e a aplicação de encargos só eleva a taxa persistida. Estorno manual acrescenta lançamento negativo e conserva o original. A unicidade de estorno manual na migração 73 impede duplicar a reversão integral; repetição não precisa devolver sucesso para ser segura contra segundo lançamento. A ressalva econômica está em F1.

### Importação e compensação B13

`modules/escrita/importacao.go:781` identifica as faturas existentes referenciadas pelo CSV e adquire o conjunto ordenado antes dos savepoints. Relê os IDs após a espera, recusa fatura reconhecida fora do conjunto adquirido (`:926`) e relê a identidade antes de registrar `import_rows` (`:842`). Uma linha errada pode voltar ao savepoint sem soltar os locks obtidos antes dele. Preview usa rollback deliberado; aplicar grava lote, linhas e auditoria na transação. Reimportação reconhecida conserva a entidade e informa divergências, sem sobrescrever o caixa pela fotografia do CSV. Índices/restrições continuam sendo a defesa para conflitos de inserção concorrente de novos títulos; conflito de unicidade vira erro de linha, não autorização para duplicar o mesmo título.

`modules/escrita/import_compensate.go:204` faz snapshot, adquire locks, relê proveniência e só então consulta o marcador e valida os efeitos. A checagem posterior inclui pagamentos, movimentos, efeitos técnicos, avisos, emissões e lotes dependentes. A classificação exige o único movimento `created` e, quando há baixa importada, origem manual comprovada por identidade, ausência de identificadores PSP/ator e igualdade temporal com o lote. `now()` transacional explica a igualdade entre criação do lote e os registros importados; não se trata apenas de confiar no texto da nota.

O teto de 200 `created`, recusa de `updated`, entidades ausentes/duplicadas e outros kinds são limites explícitos de compensação sem preimagem, não bugs a contornar. O comando acrescenta estorno/cancelamento, não apaga lote nem confunde compensação local com devolução na instituição original. Replay com mesma chave/hash retorna o marcador antes de reclassificar os movimentos que a própria compensação criou. Outra chave para lote compensado e reaproveitamento conflitante da chave são recusados.

`db/migrations/00078_import_batch_compensations.sql:16` impõe unicidade por lote e por chave no tenant, FKs compostas e RLS de tenant/portal/POP. O papel da aplicação só recebe select/insert; trigger impede update/delete do marcador. Mesmo duas compensações de lotes diferentes disputando a mesma chave não têm caminho para confirmar ambas: a violação de unicidade faz o callback falhar e desfaz os efeitos da perdedora. A restrição de suporte é da aplicação, pois não existe GUC correspondente; `compensateScope` a verifica explicitamente. Não extrapolo isso para isolamento de suporte no banco.

### Locks e TOCTOU

`finance/invoice_locks.go:30` normaliza e deduplica UUIDs, valida tenant contra o escopo, toma todos os consultivos com salt `7411005` em ordem canônica e depois as linhas nessa ordem. Os caminhos lidos de baixa/estorno/cancelamento/resolução, acordo, recebimento de gateway, emissão, devolução PSP e planejamento de efeitos usam esse helper antes das respectivas linhas de fatura/journal. Chamadas repetidas sobre locks já adquiridos na mesma transação não são uma nova aquisição em ordem inversa.

A garantia é cooperativa: o helper não transforma qualquer SQL futuro em escritor seguro. Na importação e na compensação, a releitura após espera fecha as principais janelas de TOCTOU examinadas. Em `outbound/notices.go:119`, enfileiramento também trava a união dos candidatos e depois relê/valida saldo; candidatos surgidos fora do conjunto são adiados. Isso sustenta a barreira contra aviso novo durante compensação. Não foi realizada prova dinâmica de deadlock ou inventário exaustivo de todo escritor do repositório.

### Reserva, emissão e recuperação PSP/B07

`finance/issuance.go:78` trava a fatura antes da reserva e recusa títulos com `external_source`: não transforma importação em nova cobrança PSP. Reserva e vínculo da fatura são defendidos também por triggers das migrations 69 e 77; o valor/identidade enviados ficam congelados e recebimentos não podem atravessar uma emissão ainda sem resposta vinculada. A migration 77 substitui partes da 69 para admitir sucessão comprovada; considerar apenas a versão antiga daria uma análise incompleta.

`issuance.go:126` confirma `uncertain` antes do I/O. Retentativa consulta o PSP, inclusive após resposta perdida, em vez de emitir novamente; falha/404 não volta automaticamente a `prepared`. O resultado validado é vinculado em outra transação, e `Run` retorna o erro dessa confirmação junto do resultado: receber um objeto de cobrança não basta para alegar commit local. A janela de crash antes do envio pode exigir revisão humana; é uma escolha conservadora contra duplicidade, não ausência acidental de retry de criação.

`finance/provider_refunds.go` exige devolução confirmada validada, acrescenta reversão vinculada ao recebimento e põe a obrigação em conciliação. Não deriva dinheiro de webhook não autenticado nem interpreta reversão local como devolução Bolix. `finance/dispatch.go:59` mantém os gates de sandbox e dispatch separados; a existência de helpers internos usados pelos testes não significa rota operacional liberada. Não foi feita homologação de semântica, TLS, certificados, idempotência ou extrato real da Efí.

### Leitor sombra B04

`modules/leitura/balance_read.go:21` conserva `balanceReadDatabaseGate="pending"`; as duas allowlists de produção são vazias (`:76` e `:78`). Com isso, modo de ambiente não ativa leitor sozinho. Variante permitida ausente é erro; `Strip` valida `cmp_matches` e retira campos `cmp_` antes da resposta. `due_http.go:151` usa a política comum no GET; as funções auxiliares antigas presentes no arquivo não são o ponto de entrada operacional. Baixa e acordo continuam em `DueBreakdown`.

`db/migrations/00066_financial_movements.sql` e `modules/leitura/queries/balance_shadow_compare.sql` preservam o mesmo modelo: movimentos somam nominal/encargos/desconto, pagamentos assinados são a única fonte de recebido, residual é truncado em zero, excesso é separado e cancelamento zera cobrável sem apagar dinheiro. A consulta dedicada restringe primeiro as faturas visíveis e agrega por laterais correlacionadas com tenant. Ausência de movimento preserva nominal/estado nulos e `matches` falso. As views são `security_invoker`, evitando assumir os privilégios do dono para leitura. Isso é boa direção para uma migração gradual; não demonstra por si só correção comercial de todos os estados, como F1 ilustra.

## Testes lidos, documentos confrontados e limites

Foram consultados testes dirigidos de compensação (`import_compensate_test.go`, especialmente replay, corrida, rollback, barreira, dependência e emissão), reimportação (`import_invoice_locks_test.go`), protocolo (`invoice_locks_test.go` e os arquivos de efeitos/emissão/provedor), reserva/recuperação (`issuance_transaction_test.go`, `invoice_locks_issuance_test.go`), RLS de intenção (`db/payment_intents_test.go`), devolução PSP e fixtures/gates/consulta B04. São testes existentes lidos, **não executados nesta revisão**. Barreiras e assertivas de caixa tornam a cobertura mais significativa que uma simples compilação, mas o código dos testes não prova sua execução nem cobre automaticamente F1.

`docs/LOTE25-B13-COMPENSACAO.md` preserva falhas e pendências históricas, inclusive os 22 HTTP ainda não concluídos naquela base, risco de ordem de locks e limite sem PSP real. `docs/LOTE39-B04-PROVAS-CONSOLIDADAS.md` e `B04-ACEITE-CORTE-LEITOR.json` registram evidência posterior e reuso da migração 65→66 em `01db028`, sem alegar nova migração em `b6df0c3`. Os números de testes e aprovações desses documentos são relatos históricos atribuídos à gerência; não foram reproduzidos nem confirmados pelos arquivos originais externos nesta sessão. A pendência antiga não deve ser projetada como falha atual só porque seu texto foi preservado; a aprovação posterior também não abre runtime.

O relatório geral acerta ao separar implementação interna de homologação financeira, e ao manter B04/B07 fechados. Já a conclusão de triagem de `docs/LOTE39-TRIAGEM-TECNICA.md:3` de que não havia escopo interno pronto não constitui prova de ausência de defeitos: F1 fornece um caso interno verificável para avaliação de lote futuro, sem necessidade de credenciais PSP ou hardware para definir sua regressão.

Permanecem limites conhecidos: somas legadas de recebimentos ainda usam `::int` em `finance/sql/c810a196_1.sql:1`, `48002566_3.sql:1` e `modules/leitura/queries/due.sql:5`; grandes acumulados podem exceder esse domínio. O caminho novo em bigint e o aceite B04 não autorizam transportar a garantia para esses escritores/leitores ainda legados. Isso é restrição já documentada, não descoberta inédita nem motivo para abrir o corte. Não foi testado o limiar numérico.

Dúvidas para aceite futuro: qual decisão comercial deve suceder o estorno com líquido igual/superior ao devido e com conciliação anterior? Quais critérios adicionais de residual devem condicionar automação de inadimplência? Essas decisões devem virar critérios no lote corretivo, preservando histórico e intenção financeira; esta revisão não as implementa. Não encontrei, nos caminhos examinados de B13/B07, evidência suficiente para afirmar duplicação de caixa ou emissão como segundo achado.

Gates financeiros, Meta e hardware continuam fechados. Sem franquia por decisão humana; Chatwoot/Webchat excluídos. A revisão não altera essas decisões, política, referência visual, cobertura declarada da etapa 7 ou backlog por conta própria.

## Verificação desta entrega

Única verificação automática autorizada: `git diff --check`, executada uma vez após gravar este parecer, com resultado registrado em `.paseo-result.json`. Nenhuma suíte verde foi repetida ou apresentada como homologação.
