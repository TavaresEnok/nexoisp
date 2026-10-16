# Execução do backend Go

## Configuração atual

O fluxo padrão usa API Go, River, VPN Go e Caddy. Há **346 rotas**, sendo 336 HTTP e dez dos agentes no listener mTLS. As duas rotas dinâmicas de valores personalizados omitidas no inventário inicial foram incluídas após as regressões contra Go.

O Fastify foi movido para `legacy/fastify`, retirado dos workspaces ativos e preservado somente para comparação e retorno explícito. O frontend React usa Node no build, mas sua imagem final é Caddy. Os serviços externos Python/FreeRADIUS/GenieACS permanecem conforme o escopo original.

## Desenvolvimento

```bash
./nexo up
./nexo db prepare
NEXO_NEW_PASSWORD='<12+ caracteres>' ./nexo db create-operator voce@empresa.com 'Seu nome'
./nexo test
```

`up` prepara o banco antes de iniciar a API. Quando `NEXO_DEMO_MODE=1` está explicitamente configurado no arquivo local, executa também o seed Go. `seed-demo` recusa produção.

## Produção

Configure `infra/prod/.env` e `infra/prod/certs/{ca.crt,server.crt,server.key}`. O exemplo inclui `NEXO_GO_DB_PASSWORD`. Preserve as chaves de cifra/assinatura, o volume do banco e `vpnstate` de instalações existentes.

```bash
./nexo prod up
NEXO_NEW_PASSWORD='<12+ caracteres>' ./nexo prod db create-operator voce@empresa.com 'Seu nome'
./nexo prod db preflight
./nexo prod ps
```

A configuração padrão é `infra/prod/docker-compose.yml`; as antigas sobreposições de coexistência não são necessárias para uma instalação nativa. `NEXO_PROD_ENV_FILE` e `NEXO_PROD_PROJECT` permitem selecionar o arquivo e o projeto explicitamente. Não imprimir a saída completa de `docker compose config`, pois contém segredos; usar `config --quiet` na validação.

Em uma instalação já em execução com Fastify, a troca substitui os serviços `api` e `vpn` e o proxy. Deve ser feita na janela de implantação depois dos critérios operacionais aplicáveis. O procedimento não copia nem reinicializa dados. O acesso administrativo é um container temporário `migrate`, separado dos processos de execução. Não inicie stacks distintas simultaneamente sobre as mesmas rotinas.

A produção deste usuário não foi identificada/configurada nesta sessão. Os comandos acima foram preparados e validados, mas não há alegação de tráfego produtivo já transferido.

## Banco e administração

`nexo-db` oferece:

- `prepare`: bootstrap de papéis, adoção de legado completo quando necessário, goose up, River up e verificação;
- `bootstrap [--init-app-role]`, `baseline`, `up`, `jobs-up`, `verificar`: etapas explícitas;
- `create-operator <email> <nome>`: senha lida somente de `NEXO_NEW_PASSWORD`;
- `rotate-secrets`: recifra recursos, MFA, segredos de webhooks e cabeçalhos de canais em uma transação; falha desfaz o conjunto;
- `preflight`: configuração, certificados, migrations, RLS, papéis e verificações operacionais;
- `seed-demo` e `totp`: ferramentas de desenvolvimento/homologação.

`DATABASE_URL_OWNER` pertence exclusivamente ao processo administrativo. API/VPN usam `DATABASE_URL_GO`. O bootstrap configura `nexo_radius` e, quando solicitada, `nexo_replica`; em legado preserva a senha existente de `nexo_app`.

As 53 migrations originais permanecem congeladas em `legacy/fastify/migrations`; `db/legado.sha256.json` permite verificar as cópias goose sem distribuir TypeScript junto à imagem. Novas migrations pertencem a `db/migrations`.

O River usa seu migrador oficial versionado pela dependência Go, no schema `nexo_jobs`, por `jobs-up`/prepare. Essa é a implementação efetiva, substituindo a proposta inicial de copiar o SQL River para uma migration goose.

## Operações e rotinas

O River possui a fila principal e `network`. As intenções do RADIUS integrado inserem um job com tenant/operação na mesma transação; a unicidade usa os argumentos. As reservas continuam em `operations` com `SKIP LOCKED` e exclusividade por equipamento. Jobs periódicos também recuperam operações legadas e continuam os estados incertos/reagendados.

`NEXO_GO_JOBS=1` e `NEXO_GO_JOB_<ROTINA>=1` habilitam os trabalhos. BILLING, NOTICES, SCHEDULED, SLA, PURGE, TRUST, SUSPEND, NOTIFICATIONS, WEBHOOKS, ALERTS e CLEANUP usam intervalo de um minuto; RECONCILE, dez minutos; RADIUS, dois segundos; RADIUS_SYNC, quinze segundos. A unicidade impede acumular jobs vivos da mesma rotina.

Na coexistência explícita, desligar os controles `NEXO_NODE_JOB_*` correspondentes antes da transferência. As rotinas Go compartilham a trava de sessão do worker legado durante essa janela. Não remover tabelas River para fazer retorno.

## VPN

`nexo-vpn` mantém WireGuard, peers, estado e relay UDP, e supervisiona strongSwan/xl2tpd para L2TP. Usa o volume `vpnstate` existente: preservar `server.key`. A imagem precisa de `NET_ADMIN` e acesso ao dispositivo PPP conforme o Compose. WireGuard, L2TP, FreeRADIUS e o banco permanecem serviços distintos da API.

## Backup, restauração e rotação

```bash
./nexo prod backup
./nexo prod restore-check <arquivo>
./nexo prod restore <arquivo> --yes
./nexo prod db rotate-secrets
```

O restore valida o checksum antes de parar os escritores; pausa API, VPN e RADIUS que estavam em execução, provisiona o banco restaurado e reinicia os mesmos serviços. Uma falha mantém os escritores parados para recuperação, sem tentar continuar sobre um banco parcialmente restaurado. Papéis/login não são incluídos pelo pg_dump: `prepare` os configura com as credenciais da instalação.

Para rotação, configurar a chave nova em `NEXO_SECRET_KEY` e a antiga em `NEXO_SECRET_KEY_PREVIOUS`, executar a CLI, conferir zero pendências e reiniciar os serviços com a chave nova. Só então retirar a chave anterior.

## Retorno explícito

Os arquivos `docker-compose.fastify.yml` em `infra/prod` e `infra/compose` preservam a configuração anterior. As sobreposições `docker-compose.go.yml` e `docker-compose.go-final.yml` pertencem ao fluxo de coexistência baseado nesse arquivo legado, não ao Compose padrão nativo.

No retorno, parar Go/River e a VPN Go antes de iniciar a configuração Fastify do mesmo projeto/volumes. Desligar os jobs Go, religar os controles Node e transferir a porta dos agentes. Preservar banco, chaves e tabelas River; nunca usar `down -v` para trocar de implementação.

## Evidências e limites

Compilação/testes Go, requests da suíte histórica contra Go, correções dos casos afetados, Playwright contra Go, preparação/seed/operador/rotação nativos, concorrência entre duas réplicas, outbox/rollback e VPN isolada são registrados em `ANDAMENTO.md` e nos relatórios locais. O backend não usa subprocessos Node.

A carga histórica inválida não comprova desempenho. Baseline, canários, consolidação de 30 dias, fechamento financeiro mensal e homologação no equipamento real continuam exigindo ambiente e tempo reais; não foram substituídos por ensaios sintéticos.
