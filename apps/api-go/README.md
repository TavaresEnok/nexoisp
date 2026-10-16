# Backend Go do NexoISP

API, rotinas River, VPN e administração são executáveis nativos Go. O frontend React é servido pelo Caddy; o agente Python, FreeRADIUS e GenieACS continuam como serviços separados.

- `cmd/api`: 336 operações HTTP e dez rotas de agentes em listener mTLS.
- `cmd/nexo-db`: instalação/adoção de banco, migrations, operador, rotação, preflight e seed de laboratório.
- `cmd/nexo-vpn`: WireGuard, L2TP/IPsec, sincronização e relay CoA.

## Execução

Na raiz: `./nexo up` para desenvolvimento e `./nexo prod up` para produção configurada. Estes comandos preparam o banco pelo processo administrativo antes de iniciar os serviços. A API e a VPN recebem somente o papel `nexo_go`, sem credencial de proprietário.

```sh
./nexo db prepare
NEXO_NEW_PASSWORD='<senha>' ./nexo db create-operator email@empresa.com 'Operador'
./nexo prod db preflight
./nexo prod db rotate-secrets
```

A imagem da API contém `nexo-api-go`, `nexo-db` e o acervo SQL. A imagem da VPN contém `nexo-vpn` e as ferramentas nativas de rede; nenhuma contém Node. A administração exige `DATABASE_URL_OWNER` somente em seu processo separado.

`prepare` cria os papéis necessários, adota um legado completo sem reaplicar migrations e instala goose/River. Não apaga dados. `baseline` é exclusivo de bancos legados com as 53 migrations originais; bancos parciais são recusados.

## Variáveis principais

| Variável | Uso |
|---|---|
| `DATABASE_URL_GO` | conexão de execução; obrigatória |
| `NEXO_GO_ADDR` | HTTP; padrão local 127.0.0.1:18082 |
| `NEXO_GO_INTERNAL_ADDR` | métricas, OpenAPI e health interno; 127.0.0.1:19082 |
| `NEXO_GO_AGENT_ADDR`, `NEXO_AGENT_TLS_DIR` | listener e certificados mTLS |
| `NEXO_GO_DB_POOL` | conexões por réplica; padrão 10 |
| `NEXO_GO_AUTH_CACHE_TTL` | 0–10 segundos; padrão 5 |
| `NEXO_GO_JOBS`, `NEXO_GO_JOB_<ROTINA>` | ativação de River e de cada rotina |
| `NEXO_SECRET_KEY(_PREVIOUS)`, `NEXO_OP_SIGNING_KEY` | formatos compartilhados com o legado; preservar na implantação |
| `NEXO_RADIUS_KEY`, `NEXO_L2TP_PSK` | credenciais da autenticação integrada e do túnel |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | exportação de traces; 5% e retenção de HTTP 5xx |

O listener interno não é publicado nos Compose. Autenticação, CSRF, módulos, POPs e portal precedem os handlers. Banco de negócio passa por `WithScope`; cache é invalidado por LISTEN/NOTIFY. Jobs por operação são inseridos com River na transação da intenção; a varredura periódica também recupera operações criadas pelo legado.

## Verificação concentrada

```sh
cd apps/api-go
go build ./...
go vet ./...
go test -race ./...
# Na raiz:
./nexo contrato nativo
./nexo contrato e2e
```

Os ensaios usam exclusivamente bancos sintéticos. A suíte histórica, agora em `legacy/fastify/test`, pode comparar as implementações; `./nexo contrato regressoes` dirige suas chamadas HTTP/agente para Go. Alguns testes históricos também importam funções Node diretamente como referência; não constituem prova dos workers Go, que têm ensaio próprio.

O build tag `contractbridge` reproduz o contexto dos simuladores da suíte histórica com assinatura efêmera. Esse adaptador não existe no binário normal; o binário de teste recusa `NODE_ENV=production`.

Documentação de implantação, limites da validação e pendências operacionais: [EXECUCAO_GO.md](../../docs/migracao-go/EXECUCAO_GO.md) e [ANDAMENTO.md](../../docs/migracao-go/ANDAMENTO.md).
