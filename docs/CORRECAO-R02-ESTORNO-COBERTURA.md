# R02 — estorno e cobertura

## Trechos confirmados antes da alteração

`Reverse` somava `signed_cents`, mas a consulta 48002566_4 fixava `open` e anulava `paid_at`. A seleção e as releituras f7267ee2 usavam estado e vencimento sem exigir saldo residual positivo; a seleção agregava a menor data e o menor identificador independentemente. A consulta 5a7438b9_0 também usava somente `open`. A migração 00067 incrementa a versão e cria efeito de pagamento em toda transição para `paid`, inclusive numa reclassificação. `noticeInvoicePayable` já revalida o saldo positivo e não foi alterado.

## Escolha técnica aplicada

O estorno conserva a inclusão append-only e classifica o saldo líquido atual, em bigint, contra valor mais taxa menos desconto: abaixo `open`, igual `paid`, acima `reconciling`. Para `paid`, `paid_at` é a maior data de recebimento com valor ainda não revertido; nos demais estados fica nulo. Não se chama `settle`. A migração aditiva 00084 preserva o gatilho normal, mas reconhece uma configuração local à transação durante a atualização de reclassificação; o código restaura o valor anterior imediatamente depois. Não modifica efeitos existentes, RLS ou grants.

As consultas de suspensão e cobrança exigem residual positivo. A seleção associa a fatura à menor data; após a trava e importação de pagamentos a releitura recalcula saldo, vencimento, contrato, recurso, política e liberação de confiança. Se a fatura travada deixar de ser a primeira elegível, o recurso fica para uma próxima execução, preservando a ordem das travas. Não foram alterados os avisos nem o fluxo de saída.

## Verificação e limitações

- `go -C apps/api-go mod download`: exit 127 nesta sessão, `go` indisponível no PATH.
- `go -C apps/api-go test -race ./internal/finance -run '^TestR02' -count=1`: exit 127 nesta sessão, `go` indisponível no PATH; não compilou nem executou testes. Em tentativa anterior, compilação dirigida no host terminou exit 0 com skip por ausência de URL PostgreSQL; não comprova SQL.
- `git diff --check`: exit 0; não valida SQL ou comportamento, nem inclui arquivos ainda não rastreados.
- A gerência informou execução real dos testes `TestR02ReversalCoverageAndEffects` e `TestR02ConcurrentReversal`, com `PG_REQUIRED=1`, race e zero skips no PostgreSQL descartável, exit 0 sobre o código da tentativa 5. O recibo `r02-pg-a5.json`, JSONL e hashes da fonte permanecem com a gerência. Essa evidência não cobre os casos acrescentados após a revisão.
- A fixture transacional reverte os dados; a fixture concorrente usa identificadores próprios, confirma duas conexões e mantém os lançamentos imutáveis até o descarte integral do banco `nexo_test`. Ambas exigem `NEXO_GO_TEST_DATABASE_URL` com `PG_REQUIRED=1`. Os novos limites com obrigação de 10500 e a preservação de efeito histórico aguardam execução PostgreSQL pela gerência.
