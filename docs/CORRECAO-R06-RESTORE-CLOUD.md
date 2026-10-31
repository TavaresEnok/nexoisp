# R06 — verificação dos segredos Cloud no restore

Em `apps/api-go/internal/db/restore.go`, `verifyRestore` passa a conferir
`cloud_accounts.token_enc` e `cloud_accounts.webhook_secret_enc` com
`cryptox.DecryptSecret`, dentro da transação existente `ReadOnly: true`.
Não há escrita, rotação, migration ou emissão do conteúdo dos segredos.
O recibo continua expondo apenas contagens AES/RADIUS. Os campos anteriores,
a compatibilidade ACS e a verificação RADIUS permanecem no mesmo fluxo.

A ausência de `cloud_accounts` em restores anteriores à migration 79 é
aceita somente após `to_regclass` confirmar que a relação não existe.
A consulta de existência resolve a mesma relação que o SELECT pelo
`search_path`. Erros nessa consulta, colunas ausentes e erros de leitura ou
descriptografia de uma tabela presente continuam sendo falhas.

## Teste focado

`TestR06RestoreCloud`, em `restore_cloud_test.go`, chama o verificador real
por uma conexão do próprio pacote DB. Usa somente segredos sintéticos,
um schema exclusivo descartável em `nexo_test` e a extensão pgcrypto já
existente. Não carrega `.env`, backups ou fixtures operacionais; não instala
extensões. O schema é removido ao terminar, inclusive após falhas.

Os oito casos cobrem os dois campos válidos, corrupção de cada campo,
chave incompatível em cada campo, tabela ausente pré-79 e ausência de cada
coluna em tabela presente. Comparam o registro Cloud completo antes/depois
em casos de sucesso e falha e rejeitam recibos/erros que exponham os
segredos sintéticos. Fixtures dos campos anteriores e RADIUS exercitam o
fluxo completo e a contagem sanitizada. ACS segue a condição preexistente
de existência de `public.acs_task_intents`.

Para executar, fornecer `NEXO_GO_TEST_DATABASE_OWNER_URL` apontando
exclusivamente para `nexo_test`, com permissão de criar schemas e pgcrypto
previamente disponível. `PG_REQUIRED=1` torna URL ausente uma falha; fora
desse gate, a ausência gera SKIP explícito, que não comprova PostgreSQL.
A conexão rejeita outro nome de banco antes de preparar fixtures.

## Evidência nesta worktree — 2026-10-31

| Comando | Exit | Resultado |
| --- | --- | --- |
| `go -C apps/api-go mod download` | 127 | NOTRUN: `go: command not found` |
| `go -C apps/api-go test -race ./internal/db -run '^TestR06' -count=1` | 127 | NOTRUN: `go: command not found` |
| `git diff --check` | 0 | PASS |

Fontes: código atual de `verifyRestore`, formato AES existente em
`internal/cryptox/crypto.go` e convenções de gate PostgreSQL em
`internal/db/r05_accounting_snapshot_test.go`.

Limite: este worker não dispõe de Go no PATH; compilação e execução com
race/PostgreSQL não foram comprovadas. Nenhum SKIP foi contabilizado como
PASS. O controlador deve executar o teste focado em ambiente com Go e
PostgreSQL descartável, além da revisão independente antes da integração.
Sem commit, push, merge, deploy ou acesso a produção.
