# Auditoria da migração para Go — 16/10/2026

Registro histórico anterior à correção dos achados. A continuidade posterior está em [ANDAMENTO.md](ANDAMENTO.md): VPN/CLI e execução padrão foram migradas; o Fastify foi arquivado. A regressão contra Go também revelou duas rotas omitidas pelo inventário inicial; a contagem correta passou de 344 para **346**. As referências e avaliações abaixo descrevem o estado auditado, não a entrega posterior.

## Parecer

**A migração não está concluída integralmente.** Há cobertura de registro das 344 rotas em Go, com implementação de negócio nativa, mas isso não equivale a paridade funcional comprovada, implantação concluída ou eliminação de Node do sistema.

O plano original preserva explicitamente a VPN existente, o frontend React, o agente Python e o FreeRADIUS; também mantém o Fastify para retorno durante a coexistência. Portanto, cumprir esse plano e eliminar todo Node são objetivos diferentes. A VPN preservada é um processo Node. Nenhum backend foi removido ou ambiente implantado nesta auditoria.

## Verificações realizadas nesta auditoria

- Revisão dos documentos de planejamento, arquitetura, contrato, métricas, andamento e execução, confrontados com fontes, infraestrutura, CLI e CI.
- Registro efetivo dos módulos em chi/Huma, em programa Go temporário sem banco, compilado e executado com a imagem Go existente. Resultado: **334 operações HTTP e dez rotas de agentes**, sem ausentes ou extras em relação a `apps/api-go/rotas.json`. O programa temporário foi removido.
- Extração independente das rotas TypeScript: o extrator documental identifica 342 padrões, incluindo dois templates. Expandindo os templates de `mapa.ts:68` e `tr069.ts:109`, obtêm-se as mesmas 344 rotas. Os templates representam duas rotas cada; não são quatro faltas de implementação.
- Os dois geradores de Caddy validaram as respectivas tabelas: `rotas.yaml` tem **344 marcadores Fastify**; `rotas.go.yaml` tem **334 Go e dez marcadores Fastify para agentes fora do Caddy**. Estes dez marcadores não comprovam uma dependência de agentes do Fastify: no overlay final o listener é Go.
- As 53 migrations legadas passaram na comparação de bytes e hashes. O controle de SQL, Zod e autenticação compartilhada passou sem deriva.
- Os **12 extratores de SQL/templates passaram com `--check`**. Dois exigiram disponibilizar `gofmt` da imagem Go, pois o host não possui Go/gofmt no PATH. Não houve falha de deriva nesses arquivos.
- Busca de execução de JavaScript, subprocessos Node e proxy de negócio nos fontes Go: não foram encontrados mecanismos que deleguem os handlers ao Node/Fastify.
- Nenhuma bateria extensa, carga ou escrita de negócio foi executada. As evidências funcionais anteriores foram examinadas como históricas, sem apresentá-las como novas execuções ou como cobertura integral da versão atual.

## Achados prioritários

### 1. A execução padrão continua sendo Fastify

Evidências: `infra/prod/docker-compose.yml:130`, `infra/compose/docker-compose.yml:17`, `nexo:52`, `nexo:53` e `infra/prod/caddy/rotas.yaml`.

O Compose de produção base direciona o Caddy para `api:8080`. O Compose de desenvolvimento constrói `Dockerfile.api`, cuja imagem final usa Node e executa `apps/api/dist/main.js`. `./nexo up` usa esse ambiente; `./nexo build` compila API TypeScript e frontend. A configuração Go final é uma sobreposição opcional e não foi aplicada ao ambiente de produção identificado nesta sessão — nenhum destino produtivo foi identificado.

Consequência: ter o overlay final disponível não faz os comandos padrão nem o tráfego existente mudarem automaticamente para Go. O repositório não permite concluir que alguma produção remota já mudou.

### 2. Mesmo com o overlay final, existe Node obrigatório na VPN

Evidências: `infra/prod/docker-compose.yml:53`, `infra/prod/docker-compose.go-final.yml:42`, `apps/api/src/vpn.ts` e `infra/compose/Dockerfile.api`.

O serviço `vpn` continua executando `node apps/api/dist/vpn.js`; a sobreposição altera suas dependências, mas preserva comando e imagem. Ele configura WireGuard, supervisiona L2TP/IPsec, sincroniza peers, informa estado e faz o relay UDP de desconexão. Não foi encontrado um executável Go equivalente.

Consequência: desligar o serviço HTTP Fastify não elimina o runtime Node. Apagar `apps/api` quebra o build e o funcionamento do túnel. A preservação é deliberada no plano, fase 7, mas não atende ao objetivo adicional de eliminar Node da operação própria.

### 3. Ferramentas administrativas ainda dependem de Node

Evidências: `apps/api/src/cli.ts:12`, `:23`, `:42`; `apps/api-go/cmd/nexo-db/main.go`; `infra/homolog/homolog.sh`; `docs/operacao.md:15`, `:38`, `:173`.

Não foram encontrados equivalentes Go dos comandos `create-operator`, `rotate-secrets` e do preflight operacional completo. `nexo-db verificar` confere migrations/papéis/RLS; não substitui as verificações de configuração, certificados, contas, réplicas e operações do preflight legado. A homologação ainda inicia a API Node e chama sua CLI.

Consequência: a instalação e a manutenção ainda exigem manter e executar ferramentas Node, inclusive após a troca HTTP.

### 4. Instalação nova somente com Go não configura os acessos de RADIUS e réplica

Evidências: `apps/api/src/migrate.ts:17`, `:24`; `apps/api-go/internal/db/admin.go:102`; `db/migrations/00036_radius_integrado.sql:97`.

O migrador Node configura `nexo_radius LOGIN PASSWORD` a partir de `NEXO_RADIUS_DB_PASSWORD` e cria/atualiza `nexo_replica` com `LOGIN REPLICATION` quando existe senha de réplica. O bootstrap Go configura `nexo_app` inicial e `nexo_go`, mas não reproduz essas tarefas. A migration 36 cria `nexo_radius` como **NOLOGIN**, sem fornecer a etapa posterior de ativação.

Consequência: em cluster novo preparado apenas com os comandos Go, sem provisionamento administrativo adicional, o FreeRADIUS não consegue autenticar no PostgreSQL; a réplica também fica sem seu papel configurado. Em banco legado, credenciais previamente criadas podem continuar funcionando. É uma lacuna de instalação, não prova de quebra de todos os bancos existentes.

### 5. Regressões e Playwright atuais pelo proxy exercitam Fastify

Evidências: `tests/contrato/regressoes.py:23`, `:25`; `tests/contrato/e2e.py:30`, `:37`; `infra/prod/caddy/rotas.yaml`.

Ambos usam `proxy.load()` com a tabela padrão, inteiramente Fastify, e configuram o upstream Fastify. O ensaio de regressão usa a API do processo Vitest; o E2E inicia explicitamente o Fastify. Eles não selecionam a tabela final Go nem um upstream Go para esses cenários.

Consequência: os 192 testes e a fumaça do painel anteriormente aprovados demonstram preservação do legado e funcionamento do proxy/estáticos. **Não demonstram que esses mesmos cenários passaram com o backend Go.** Os ensaios específicos de Go continuam válidos dentro de seus próprios escopos.

### 6. A validação de agentes já apresenta uma diferença concreta de contrato

Evidências: `apps/api/src/agent-api.ts:56`; `apps/api-go/internal/agent/server.go:150`; `apps/api-go/internal/validate/body.go:112`.

No Fastify dos agentes, um `ZodError` responde com `error: err.message`, isto é, a representação textual estruturada das issues Zod. O Go usa `Rule.Parse`, que produz mensagens concatenadas como `campo: mensagem`. Assim, a mesma entrada inválida não recebe necessariamente o mesmo texto de erro, mesmo quando ambos retornam 400.

Consequência: a alegação de contrato integralmente idêntico não se sustenta para esse caminho. O ensaio positivo do agente Python não cobre essa diferença de entradas inválidas.

### 7. River foi implementado com desenho diferente do especificado

Evidências: `docs/migracao-go/ARQUITETURA.md:275`; `apps/api-go/internal/jobs/jobs.go:23`, `:198`; `apps/api-go/internal/db/jobs.go:18`; `apps/api-go/internal/network/engine.go`.

A arquitetura prevê inserção transacional de job por operação (`InsertTx`, tenant/operation IDs), unicidade por operação e migrations River sob goose. O código usa jobs periódicos globais com argumento `task`, que acionam o executor e sua varredura da tabela `operations`; a unicidade é por rotina. As migrations River são aplicadas separadamente por `nexo-db jobs-up` no schema `nexo_jobs`.

Esse desenho pode executar as operações nativamente e mantém `operations` como fonte de verdade, mas **não implementa o outbox River transacional por operação descrito na arquitetura**. Há menção ao desenho efetivo em `EXECUCAO_GO.md`; falta reconciliar a especificação e comprovar seus critérios de atraso/concorrência. Não foi constatada perda de operação apenas pela ausência de `InsertTx`, pois existe varredura.

### 8. Observabilidade prevista está apenas parcialmente implementada

Evidências: `docs/migracao-go/ARQUITETURA.md:519`; `apps/api-go/internal/httpx/http.go:67`; `apps/api-go/internal/httpx/telemetry.go:15`; `apps/api-go/internal/db/db.go:54`.

Há histograma HTTP por rota/status/célula, métricas de pool/transações/cache e tracing pgx. Porém, o middleware não emite o log estruturado de cada requisição com rota, status, duração, usuário, tenant e request ID previsto na arquitetura. Os logs de acesso do Caddy não substituem os campos de contexto da aplicação. O tracing usa amostragem de **1%**, enquanto a especificação prevê 5% e retenção de todos os 5xx; não foi encontrado o mecanismo que garanta esta última regra. As métricas de banco mostradas são agregadas, sem dimensão por rota.

Consequência: a observabilidade existente não satisfaz integralmente a documentação e não há prova atual dos portões operacionais que dependem dessas medidas.

### 9. Retirar a árvore TypeScript ainda quebra ferramentas da migração

Evidências: `scripts/migracao-go/extrair_*.cjs`; `.github/workflows/go.yml:14`, `:26`; `apps/api-go/internal/db/admin.go:21`, `:47`.

Os extratores rodam em Node, interpretam a AST TypeScript original e verificam SQL/templates e hashes. Isso é dependência de geração/CI, não execução de regra de negócio em JavaScript. Além disso, a CLI Go procura `apps/api/migrations` para localizar a raiz e verificar as cópias congeladas. O Caddy também usa Node na etapa de build do React; sua imagem final é Caddy.

Consequência: a API Go é nativa em execução, mas o processo de geração/manutenção ainda depende dos fontes legados. Remover Fastify exige separar essas dependências e preservar o acervo SQL necessário. Node para compilar o frontend React é uma dependência distinta da API.

### 10. Documentação e automações operacionais ainda não refletem o estado final

Evidências: `apps/api-go/README.md:3`, `:55`; `README.md:31`; `infra/prod/.env.example`; `nexo:40`; `scripts/backup.sh:14`.

O README Go ainda descreve somente três leituras e diz que `/api/health` permanece exclusivamente no Node, embora os handlers atuais sejam mais amplos. O exemplo de ambiente de produção não inclui `NEXO_GO_DB_PASSWORD`, exigida pela sobreposição. O comando padrão de restauração pausa/reinicia apenas `api`, sem incluir `api-go` e suas rotinas. O helper de restore cria papéis legados, mas não provisiona `nexo_go` em cluster novo.

Consequência: o roteiro operacional precisa ser adaptado e ensaiado para uma instalação Go. Não se deve presumir que o restore legado paralise todos os escritores ou restaure os papéis de uma instalação nova.

## Confronto com as fases de docs/migracao-go

| Fase | Implementação encontrada | O que impede declarar conclusão integral |
|---|---|---|
| 0 — proxy e baseline | Caddy, arquivos gerados e ensaios locais disponíveis | Sem sete dias de baseline produtiva nem implantação comprovada |
| 1 — base Go | Autenticação, RLS, cache, migrations, três leituras e harness disponíveis | Portão de desempenho permanece pendente; carga histórica perdeu iterações |
| 2 — primeiras leituras | Handlers presentes | Canários, ganho medido e sete dias em Go não comprovados |
| 3 — demais leituras | Handlers presentes; comparações históricas por grupos | Continuidade, observação e virada operacional pendentes |
| 4 — escritas simples | Handlers presentes | Sem comprovação exaustiva por escrita de estado/auditoria/efeitos; sem canário |
| 5 — complexas/identidade/rede | Implementações nativas presentes | Integrações/negativas/paridade integral e disputa Node/Go ainda não comprovadas em toda a matriz |
| 6 — financeiro | Handlers e ensaios concentrados presentes | A suíte não cobre toda a matriz exigida; faltam fechamento mensal e canário |
| 7 — jobs/agentes | River, executor, agentes/mTLS e controles de desligamento presentes | Sem semana exclusiva Go por rotina; VPN continua Node conforme escopo original |
| 8 — desligamento | Overlay final preparado; código Fastify preservado | Sem consolidação de 30 dias e sem implantação comprovada; remoção física não realizada |

`ANDAMENTO.md` e `EXECUCAO_GO.md` já reconhecem boa parte das pendências operacionais. O relatório da fase 1 é histórico e não deve ser tratado como retrato do escopo atual.

`TESTES_CONTRATO.md` pede especificação e corpus por rota, comparação do estado de todas as escritas e ensaios financeiros mistos: geração concorrente, acordo versus baixa, estorno concorrente e disputa de executores. Há somente três especificações YAML de rota no diretório próprio; outros testes são implementados em scripts por grupos. A consolidação verifica baixa concorrente e estorno repetido, mas isso não equivale ao conjunto completo exigido. Também não foi encontrada configuração do contrato contínuo de produção a cada 15 minutos no CI/Compose analisados.

Tipos TypeScript gerados do OpenAPI, frontend HTMX, múltiplas células, PgBouncer, Valkey e ClickHouse são opcionais/adiados/fora do escopo descrito. Sua ausência não foi contabilizada como falha obrigatória da migração.

## Componentes que permanecem fora de Go

| Componente | Situação |
|---|---|
| API Fastify/TypeScript | 61 fontes TS preservados; execução padrão e alternativa de retorno |
| VPN WireGuard/L2TP/relay | Node em execução, inclusive na configuração final |
| CLI administrativa | Node para operador, rotação de segredos e preflight |
| Geradores e parte do CI | Node/TypeScript; necessários para controles atuais |
| Frontend | React/TypeScript/Vite preservado por requisito; Node no build |
| Agente de rede | Python preservado por requisito |
| ACS | GenieACS externo preservado; não reimplementado em Go |
| RADIUS e bancos | FreeRADIUS, PostgreSQL e MongoDB externos; preservados |

## Ordem indicada para fechar a migração

1. Completar ferramentas administrativas/provisionamento Go e adaptar instalação, homologação, restauração e documentação.
2. Caso o objetivo seja operação própria sem Node, portar a VPN e criar sua imagem independente; depois retirar a dependência do pacote da API legado.
3. Ajustar a paridade conhecida dos agentes e reconciliar River/observabilidade com o contrato documentado.
4. Fazer as regressões e a fumaça do painel usarem efetivamente Go; concentrar a validação adicional nos fluxos e concorrências que faltam, sem repetir indiscriminadamente as baterias antigas.
5. Obter uma carga válida, identificar o ambiente produtivo e cumprir/registrar os períodos operacionais aplicáveis.
6. Após consolidar a implantação, retirar Fastify dos caminhos padrão e separar o acervo SQL e controles de geração que ainda leem `apps/api`.

**Percentual defensável: 100% de cobertura do inventário de rotas registradas (344/344). Não há base para declarar 100% de paridade, 100% das fases aceitas ou 100% do projeto convertido para Go.**
