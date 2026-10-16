# Backend Go: execução e virada

## Estado da implementação

As 344 rotas do inventário têm implementação nativa: 334 operações do painel, portal e API pública, mais dez operações dos agentes em listener separado. `apps/api-go/rotas.json` é o manifesto completo. O painel React, o banco PostgreSQL, o agente Python, o FreeRADIUS e o serviço de túnel existente são preservados.

As novas escritas usam transações com escopo de tenant/assinante/POP, validação compatível com o painel, auditoria e efeitos associados. O motor grava intenções versionadas e envelopes Ed25519; os agentes continuam verificando a assinatura dos bytes recebidos. A identidade Go usa o formato de senha scrypt, AES-GCM e cookies existentes.

A disponibilidade de código não declara concluídos os portões operacionais do plano. Permanecem pendentes a medição de desempenho em carga válida, a linha de base, os canários, os períodos de observação e o fechamento mensal financeiro. Nenhum serviço produtivo foi alterado nesta execução.

## Preparação do banco

Usar o papel administrativo somente no processo de migração. A API recebe exclusivamente `DATABASE_URL_GO`, com o papel `nexo_go`, membro de `nexo_app`, sem propriedade das tabelas do produto nem bypass de RLS.

```bash
go -C apps/api-go build -o bin/nexo-db ./cmd/nexo-db
apps/api-go/bin/nexo-db up
apps/api-go/bin/nexo-db jobs-up
apps/api-go/bin/nexo-db verificar
```

Esses comandos usam `DATABASE_URL_OWNER` já configurada no ambiente de implantação. O bootstrap/baseline de bancos legados continua seguindo o procedimento das fases anteriores. As 53 migrations originais permanecem congeladas; as migrations públicas Go continuam em `db/migrations`.

`jobs-up` aplica as migrations oficiais do River 0.49.0 ao schema separado `nexo_jobs`, usando o proprietário. Revoga acesso de `public` e `nexo_app` e concede acesso explícito ao papel Go. Os argumentos dos jobs contêm apenas o nome da rotina; informações pessoais, senhas e envelopes não são copiados para essa fila. A API não executa DDL ao iniciar.

## Coexistência

`infra/prod/docker-compose.go.yml` adiciona a API Go e mantém o roteamento inicial no Fastify. As chaves `NEXO_SECRET_KEY`, `NEXO_SECRET_KEY_PREVIOUS` e `NEXO_OP_SIGNING_KEY` precisam ser as mesmas entre as duas implementações. Isso permite ler as credenciais, validar MFA e reconhecer assinaturas já existentes. Não gerar novas chaves para fazer a troca de linguagem.

As rotas continuam sendo transferidas pela tabela do Caddy e pelos canários previstos no plano. `infra/prod/caddy/rotas.yaml` permanece integralmente em `fastify`. O arquivo `Caddyfile.go` é um artefato separado para a configuração final; não foi recarregado em produção.

## Rotinas

O River utiliza duas filas: a principal executa as automações sequencialmente; `network` executa RADIUS e sincronização de accounting. A unicidade por rotina impede acumular cópias enquanto uma execução estiver pendente ou em andamento. O scheduler eleito e as reservas de operação com `SKIP LOCKED` permitem múltiplas réplicas.

`NEXO_GO_JOBS=1` inicia o cliente River; cada rotina também exige `NEXO_GO_JOB_<ROTINA>=1`. O Node preserva o comportamento anterior por padrão; `NEXO_NODE_JOB_<ROTINA>=0` desliga somente aquela automação. Os controles são independentes das rotas manuais correspondentes.

| Rotina | Intervalo Go | Controle Node |
|---|---|---|
| BILLING, NOTICES, SCHEDULED, SLA, PURGE, TRUST, SUSPEND | 1 minuto | mesmo nome |
| NOTIFICATIONS, WEBHOOKS, ALERTS, CLEANUP | 1 minuto | mesmo nome |
| RECONCILE | 10 minutos | RECONCILE |
| RADIUS | 2 segundos | RADIUS |
| RADIUS_SYNC | 15 segundos | desligado junto ao executor Node RADIUS |

As rotinas Go compartilham a trava consultiva de sessão do worker legado. A E/S de entrega e desconexão ocorre fora das transações de negócio. Avisos interrompidos continuam sendo marcados como incertos, sem reenvio automático. Reservas e intenções continuam na fila de operações existente; o River agenda o executor integrado.

## Configuração final preparada

Depois de cumprir os portões do plano, a sobreposição final pode ser usada sobre as duas configurações anteriores:

```bash
docker compose -f infra/prod/docker-compose.yml \
  -f infra/prod/docker-compose.go.yml \
  -f infra/prod/docker-compose.go-final.yml config --quiet
```

A sobreposição final exige Compose 2.24.4 ou posterior. Ela coloca o serviço Fastify no perfil `legacy`, retira suas dependências do Caddy/VPN/RADIUS, transfere a porta dos agentes para o Go, habilita as rotinas Go e seleciona `Caddyfile.go`. O frontend é servido pelo Caddy, todas as rotas HTTP vão para Go e os agentes usam mTLS diretamente na porta 8443. O listener interno de métricas/OpenAPI permanece sem publicação de porta. VPN e FreeRADIUS permanecem como serviços separados.

Na janela de virada, o serviço legado que já estiver em execução precisa ser parado explicitamente antes de transferir a publicação da porta dos agentes; adicionar um perfil ao Compose não encerra um container anterior. Depois disso, aplicar a sobreposição final com `up -d --build`. Essa operação e a recarga do Caddy não foram executadas nesta entrega.

Para regenerar e conferir o artefato de roteamento final:

```bash
python3 scripts/migracao-go/proxy.py \
  --table infra/prod/caddy/rotas.go.yaml \
  --output infra/prod/caddy/Caddyfile.go --fallback go --check
```

As linhas `/agent/*` da tabela são ignoradas pelo Caddy; a indicação `fastify` nelas é o marcador exigido pelo validador para rotas fora do proxy. Na configuração final, o destino efetivo dos agentes é o listener Go publicado pela sobreposição.

## Volta à coexistência

Preservar as chaves, o banco e as tabelas de operações. Desligar o cliente River e retirar a publicação da porta dos agentes no Go antes de republicar essa porta no serviço legado. Reativar os controles `NEXO_NODE_JOB_*`, usar as duas configurações de coexistência e recarregar o Caddy com a tabela `rotas.yaml`. Não executar os dois schedulers para a mesma rotina durante a troca. Não remover as tabelas River para fazer rollback; os jobs pendentes devem permanecer disponíveis para inspeção.

## Validação concentrada

A pedido do usuário, as baterias extensas por rota foram substituídas por compilação em blocos e verificações concentradas. Estão disponíveis:

```bash
./nexo contrato consolidacao
./nexo contrato agente_go
./nexo contrato mtls_go
./nexo contrato jobs-up
./nexo contrato river_radius
```

A consolidação exercita a idempotência entre Go e Fastify, auditoria de token, OS, NOC, prévia com rollback, importação com savepoints, reimportação, baixa concorrente e estorno repetido. O ensaio do agente usa o código Python real e o driver de demonstração; o de River usa um processo Go descartável e um NAS loopback sem sessões, incluindo accounting e webhook assinado/idempotente do gateway de demonstração. O ensaio mTLS usa uma CA efêmera e confere identidade, fixação e rejeições de certificado. Todos usam exclusivamente o banco sintético do laboratório. Os ensaios não substituem a comparação exaustiva, a homologação de equipamentos ou o canário operacional.
