# API Go — fase 1

Servidor de laboratório/homologação com três leituras do cadastro. Nenhuma configuração de produção é alterada.

## Laboratório reproduzível

Na raiz, com Docker e as dependências Node instaladas (`./nexo install`):

```sh
./nexo contrato up
./nexo contrato migrations
./nexo contrato run --rotas fase1
./nexo contrato mutacoes
./nexo contrato carga
./nexo contrato down
```

Go 1.27.2 pode estar no PATH ou ser informado em `NEXO_GO_BIN`. Sem Go local, o controlador usa a imagem `golang:1.27.2-alpine`. A verificação de concorrência no CI usa Go nativo com CGO. O ambiente cria somente os contêineres `nexo-fase1-*`, bancos descartáveis de contrato e portas locais 15439/18081/18082/19082. Não lê `.env` de produção. A carga usa portas adicionais 18100–18103/19100–19103 e banco próprio de 300 mil assinantes.

Relatórios JSON e Markdown ficam em `tests/contrato/relatorios/`; credenciais sintéticas e logs locais ficam em `tests/contrato/local/`. Ambos são ignorados pelo Git. O relatório consolidado e evidências sem credenciais ficam em `docs/migracao-go/`.

## Banco

```sh
cd apps/api-go
go run ./cmd/nexo-db bootstrap --init-app-role # somente cluster novo
go run ./cmd/nexo-db baseline                 # somente banco legado completo, sem goose
go run ./cmd/nexo-db up
go run ./cmd/nexo-db verificar
```

Esses comandos usam `DATABASE_URL_OWNER`. `bootstrap` exige `NEXO_GO_DB_PASSWORD`; a criação inicial opcional de `nexo_app` exige `NEXO_APP_DB_PASSWORD`. Papéis existentes da API Node não têm sua senha redefinida pelo bootstrap Go. Em banco novo, execute bootstrap e up; em legado, bootstrap, baseline e up. Não execute baseline em banco novo. O mesmo advisory lock do migrador Node serializa a adoção.

As migrations 1–53 são cópias congeladas. `python3 scripts/migracao-go/migrations.py` verifica SQL byte a byte e hashes. Novas migrations pertencem apenas a `db/migrations`. A migration 55 adiciona `nexo_go_session_get`, com expiração, sem alterar `session_get` do Fastify. A 56 protege o diretório com RLS, função de metadados com concessão restrita e atualização por NOTIFY.

## Servidor

```sh
cd apps/api-go
go run ./cmd/api
```

| Variável | Padrão |
|---|---|
| `DATABASE_URL_GO` | obrigatória; papel `nexo_go` |
| `NEXO_GO_ADDR` | `127.0.0.1:18082` |
| `NEXO_GO_INTERNAL_ADDR` | `127.0.0.1:19082` |
| `NEXO_GO_DB_POOL` | 10 |
| `NEXO_GO_PLAN_CACHE_MODE` | `force_custom_plan`; `auto` somente para comparação |
| `NEXO_GO_AUTH_CACHE_TTL` | 5 segundos, intervalo 0–10; 0 desliga |
| `NEXO_PANEL_RATE_PER_MIN` | 1200, mínimo 30, por processo |
| `NEXO_REQUIRE_ADMIN_MFA` | `1` exige MFA de admin/operador |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | exportação OTLP/HTTP opcional |

`/healthz`, `/metrics` e `/openapi.json` existem somente no listener interno. A porta de negócio expõe apenas os três GETs; `/api/health` permanece no Node. A imagem Docker não publica portas automaticamente; o listener de métricas deve permanecer na rede interna.

O cache usa hashes de tokens, índices por usuário/tenant e uma geração que impede reinserção após invalidação concorrente. A queda de LISTEN limpa e desliga o cache. Enquanto a escuta está indisponível, o diretório é recarregado pelo caminho controlado do banco; autenticação não usa contexto antigo. POPs, portal e tenant são aplicados por `set_config(..., true)` dentro de `WithScope`.

## Desenvolvimento

```sh
cd apps/api-go
go test -race ./...
sqlc generate                     # sqlc v1.31.1
golangci-lint run ./...            # v2.14.0
```

`NEXO_GO_TEST_DATABASE_URL` habilita os testes reais de isolamento e reuso com pool de uma conexão; `contrato run` o fornece. A verificação de deriva inclui SQL, Zod e controles compartilhados do Node, sem depender dos hooks opt-in do benchmark que já existiam na árvore inicial.

Mutações são build tags individuais, sem chave de ambiente em produção. Os casos privilegiados precisam falhar na partida, antes de aceitar HTTP. CSRF e módulo são exercitados nos testes de middleware; o isolamento do portal é testado diretamente em `WithScope`, pois as três rotas de cadastro recusam a permissão `portal:self`.
