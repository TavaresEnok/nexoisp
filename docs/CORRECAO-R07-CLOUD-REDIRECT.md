# R07 — resultado terminal de redirect Cloud

Implementação em 31/10/2026, somente nesta worktree. Revisão independente e integração cabem ao controlador.

O cliente já recusava redirects, mas o journal rejeitava `Refused=true` com HTTP 302. A transação C falhava e preservava `wire/sending`. Agora o journal aceita status 300–399 somente na recusa explícita, persistindo `refused/failed`, o status original e provider ID nulo. Recusa com 2xx, 5xx, status fora dos limites, ID preenchido ou flags opostas continua inválida. O tratamento existente de 4xx, 5xx e 2xx indefinido permanece.

O cliente encerra qualquer 3xx antes de ler corpo ou Location, inclusive resposta sem corpo e resposta acompanhada de erro do transporte. O diagnóstico é fixo (`redirect recusado`); o journal mantém apenas `refused` no excerpt e `recusado` no log. O worker existente compõe esses resultados sem mudança e o claim continua limitado a `queued`, impedindo reenvio automático do evento terminal.

Fontes e cobertura:

- `cloudapi/client.go` e `cloudapi/client_test.go`: cliente real com RoundTripper local, uma única chamada ao host original, sem transferência do bearer para Location, sem leitura do corpo para diagnóstico e sem provider ID inventado.
- `cloudjournal/journal.go` e `cloudjournal/journal_test.go`: limites da recusa explícita, rejeição de 3xx sem classificação e das combinações incoerentes.
- `cloud_redirect_test.go`: composição cliente → worker → journal reais, fixture de manutenção e helpers existentes de PostgreSQL restritos a `nexo_test/nexo_go`. Verifica commit wire antes do transporte, persistência `302/refused/failed`, sanitização, mensagem apagada, ID nulo, finalização idempotente, segunda passagem da fila sem envio e replay terminal recusado. Usa exclusivamente transporte local por instância; não executa HTTP, DNS ou servidor externo.

## Execução e limites

Go disponível em `/usr/local/go/bin` (go1.27.3). Nos comandos abaixo, foi acrescentado `PATH=/usr/local/go/bin:$PATH`. Para executar testes, também foi usado `GOTMPDIR="$PWD/.r07-go-tmp"`, diretório temporário desta worktree removido ao final. A primeira execução dos dois comandos de testes abaixo, usando o temporário padrão, terminou com exit 1 por `fork/exec /tmp/go-build…: permission denied`; os binários não chegaram a executar. A repetição resolveu essa limitação de ambiente sem mudar código ou asserções.

| Comando | Exit | Resultado |
| --- | --- | --- |
| `go -C apps/api-go mod download` | 0 | Dependências disponíveis |
| `go -C apps/api-go test -race ./internal/outbound ./internal/outbound/cloudapi ./internal/outbound/cloudjournal -run '^TestR07' -count=1` | 0 | Testes unitários R07 PASS; composição PG SKIP, não aprovada |
| `go -C apps/api-go test -race ./internal/outbound/cloudapi ./internal/outbound/cloudjournal -run '^(TestCloudAPI_B15_C1[0-6]|TestCloudJournal_ClassifyResult)$' -count=1` | 0 | Casos existentes dirigidos PASS, incluindo timeout, 4xx/429, 5xx e 2xx |
| `go -C apps/api-go test -race ./internal/outbound -run '^TestR07RedirectWorkerJournalPG$' -count=1 -v` | 0 | SKIP explícito: `NEXO_GO_TEST_DATABASE_URL` ausente; persistência PG NOTRUN |
| `PG_REQUIRED=1 go -C apps/api-go test -race ./internal/outbound -run '^TestR07RedirectWorkerJournalPG$' -count=1 -v` | 1 | Falha esperada: URL ausente; gate obrigatório não admite SKIP |
| `git diff --check` | 0 | Sem erros de whitespace |

Não foi obtida nem solicitada URL/credencial. A execução real da composição PostgreSQL continua pendente em laboratório descartável com URL fornecida pelo controlador; o exit 0 com SKIP não comprova persistência. O teste também respeita o gate existente `NEXO_CLOUD_PG_REQUIRED=1`.

Allowlist de versões de produção vazia, Cloud desligada por padrão, request factory de produção não comprovada, RLS, CSRF, B04 e UI oficial permanecem preservados. Sem novo protocolo, bypass de URL, configuração de ambiente de produto, produção, deploy, push, merge, commit ou serviço externo.
