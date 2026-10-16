# Migração gradual da API do NexoISP para Go — plano

Estado: **em execução por autorização do usuário em 16/10/2026**. O usuário determinou prosseguir por todas as fases sem novas perguntas. Estado verificável em `ANDAMENTO.md`; os critérios operacionais continuam sendo medidos, sem declarar períodos de observação que ainda não ocorreram.

Atualização de escopo autorizada pelo usuário após a auditoria: concluir também VPN, ferramentas administrativas e desativação do Fastify no fluxo padrão. API/VPN/CLI agora usam Go; a referência anterior foi movida para `legacy/fastify`, fora dos workspaces e imagens ativos. O inventário final é **346 rotas (336 HTTP + dez agentes)**: a execução das regressões contra Go encontrou duas rotas dinâmicas de campos personalizados omitidas na versão inicial. As contagens e caminhos antigos no corpo deste plano são históricos; os procedimentos atuais estão em `EXECUCAO_GO.md`. A implementação não declara cumpridos os períodos de produção ainda não observados.

Documentos deste diretório:

| Arquivo | Conteúdo |
|---|---|
| `PLANO.md` | este documento: fases, ordem, riscos, critérios de conclusão e de volta atrás |
| `ARQUITETURA.md` | projeto Go, camadas, sqlc, RLS, transação de autenticação, River, Ristretto, proxy, células |
| `INVENTARIO_ROTAS.md` | as 344 rotas atuais com permissão, módulo, tabelas, leitura/escrita, complexidade e fase |
| `TESTES_CONTRATO.md` | comparação automática Fastify × Go por rota, incluindo mutações |
| `METRICAS.md` | o que medir e os limites que liberam (ou interrompem) cada etapa |
| `PROMPT_FASE_1.md` | instrução para a próxima IA executar somente a fase 1 |
| `ferramentas/` | scripts que geraram o inventário (documentação, não produção) |

## 1. Por que migrar, e o que a evidência do piloto sustenta

Os números abaixo vêm de `docs/benchmarks/2026-10-15/` (piloto REAL e comparação controlada, três leituras: assinante, contrato e listagem, 1.000 req/s, 4 × 1 CPU de API).

| Achado medido | Valor | Vale para |
|---|---|---|
| `plan_cache_mode = force_custom_plan` (contra `auto` com prepared) | −29 % a −31 % de CPU API+banco; P99 −65 % | todas as stacks |
| Autenticação numa transação (contra três) | −25 % de CPU da API no Fastify; −6 % a −8 % no Go | todas as stacks |
| Go (melhor configuração) contra Fastify (melhor configuração) | CPU da API −23 %; **CPU total API+banco −2 %**; RAM da API −79 % | só a fatia de três leituras |

Consequências para o plano:

1. **O banco domina o custo.** A economia total do Go nessa fatia ficou dentro da dispersão. O ganho grande veio de política de plano e da autenticação agrupada, que o Go adota desde o primeiro dia (é o desenho proposto em `ARQUITETURA.md`).
2. **A migração se justifica por CPU e memória da camada de aplicação, previsibilidade de latência e manutenção**, não por uma queda grande da conta total. Cada fase tem um portão em `METRICAS.md`. Se as medições de produção não confirmarem ganho, o plano prevê parar com segurança (seção 7).
3. O piloto não cobriu cookies/CSRF, MFA, POPs restritos, auditoria de negativas nem escrita. Por isso a fase 1 começa exatamente por esses controles, antes de qualquer rota de escrita.

## 2. Regras invariáveis (valem em todas as fases)

1. **Strangler.** Fastify e Go rodam juntos atrás do mesmo proxy, no mesmo domínio. As rotas passam para o Go uma a uma, por uma tabela de roteamento versionada. Não há reescrita de uma vez.
2. **Contrato idêntico.** Mesmas rotas, mesmos corpos JSON, mesmos códigos HTTP e de erro (`{"error": "...", "code": "..."}`), mesmos cabeçalhos relevantes, mesmo cookie `nexo_session` e a mesma regra de CSRF (`x-nexo-csrf: 1` em escrita por cookie). O painel React não percebe a troca.
3. **Teste de contrato antes de virar cada rota** (`TESTES_CONTRATO.md`), incluindo isolamento entre provedores, permissões, POPs, módulos, MFA e limite de requisições, com dados esperados calculados no banco e teste de mutação.
4. **Segurança não regride.** Tenant sempre da sessão; RLS ativo; papel do banco sem `BYPASSRLS`, sem superusuário e sem posse de tabelas; auditoria preservada (inclusive `access.denied`).
5. **Autenticação numa transação só** (sessão + módulos + POPs), com cache curto em memória e invalidação ao bloquear, suspender ou encerrar sessão.
6. **Banco compartilhado.** As duas APIs usam o mesmo PostgreSQL e as mesmas migrations. **goose passa a ser a fonte única** a partir da fase 1.
7. **Nenhuma consulta atravessa provedores**, mesmo com uma célula só: diretório provedor → célula criado desde já e verificado em toda transação.
8. **O front-end não muda.** `apps/web` (React 18 + Vite + React Router) fica intocado. O proxy passa a servir o build do Vite e a rotear `/api/*`.
9. **O Fastify não é removido nem alterado** durante a migração. Exceções exigem aprovação explícita e estão listadas na seção 9.

Fora do escopo (só entram se as métricas justificarem, com critérios em `METRICAS.md`, seção 7): PgBouncer, Valkey e ClickHouse.

## 3. Mecanismo de virada e de volta atrás por rota

Cada rota tem um estado na tabela de roteamento (`infra/prod/caddy/rotas.yaml`, gerada e validada a partir do inventário):

```
fastify ──► go-canario (1 % → 10 % → 50 %) ──► go ──► go-consolidada
   ▲               │                              │
   └─── volta ─────┴──────────── volta ───────────┘
```

- **`fastify`**: estado inicial de todas as rotas.
- **`go-canario`**: o proxy divide a rota entre as duas APIs por peso. Os degraus são 1 %, 10 % e 50 %, cada um com tempo mínimo de observação (seção 6).
- **`go`**: 100 % no Go. O handler do Fastify continua existindo e pronto para receber a rota de volta.
- **`go-consolidada`**: a rota está no Go há pelo menos 30 dias sem volta. Só então mudanças nessa rota podem ser feitas apenas no Go.

**Volta atrás de uma rota** = mudar o estado dela para `fastify` e recarregar o proxy (`caddy reload`, sem queda de conexões). Leva menos de um minuto e não depende de deploy de código. Como o banco é o mesmo, não há dado a migrar de volta.

A volta é segura **somente se** o Go gravou o banco exatamente como o Fastify gravaria. Isso é garantido pelo teste de contrato com comparação de estado do banco (`TESTES_CONTRATO.md`, nível 3). Por isso nenhuma rota de escrita vira sem esse nível aprovado.

Gatilhos de volta automática (alerta que pede a ação; a volta é executada pelo operador de plantão com um comando):

- taxa de 5xx da rota no Go acima da do Fastify + 0,1 ponto percentual por 5 minutos;
- P99 da rota no Go acima de 1,2 × o P99 de referência do Fastify por 10 minutos;
- qualquer divergência no teste de contrato contínuo da rota;
- qualquer alerta de isolamento (linha de outro provedor, RLS desligado, papel com `BYPASSRLS`): **volta de todas as rotas do Go**, não só da afetada.

Regra para mudanças de produto durante a coexistência: enquanto uma rota estiver em `go-canario` ou `go`, qualquer mudança nela é feita **nas duas implementações no mesmo PR**, com o teste de contrato atualizado. O CI acusa quando só uma das duas mudou (`TESTES_CONTRATO.md`, seção 9).

## 4. Fases

Contagem por fase conforme `INVENTARIO_ROTAS.md`: F1 3, F2 12, F3 104, F4 115, F5 81, F6 18, F7 10 (API de agentes), F8 1. Cada fase só começa depois que a anterior cumpre o critério de conclusão.

### Fase 0 — Proxy e linha de base (sem Go)

Objetivo: tirar o `@fastify/static` do caminho e medir o Fastify antes de qualquer mudança.

- Caddy (já usado em produção) passa a servir o build do Vite e a rotear 100 % de `/api/*`, `/public/*` e `/aviso/*` para o Fastify. Configuração em `ARQUITETURA.md`, seção 9.
- Os cabeçalhos que hoje o hook `onSend` do Fastify aplica às páginas estáticas (CSP do painel, `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS) passam a ser aplicados pelo Caddy, com os mesmos valores.
- Log de acesso em JSON por rota e por destino; coleta de `pg_stat_statements` e CPU por contêiner (`METRICAS.md`).
- O `@fastify/static` continua no código do Fastify (regra 9), apenas deixa de ser alcançado.

Concluída quando: teste de fumaça do Playwright (`e2e/`) e os 41 arquivos de regressão da API (`apps/api/test/*.test.ts`) passam pelo proxy (depende da decisão D1); os cabeçalhos das páginas estáticas são idênticos aos de antes (comparação automática); há 7 dias de linha de base por rota.

Volta atrás: restaurar o comando anterior do Caddy (`reverse-proxy --to api:8080`).

### Fase 1 — Esqueleto Go, autenticação, três leituras e testes de contrato (laboratório e homologação)

Pode correr em paralelo com a fase 0: a fase 1 não usa o proxy (o harness chama as duas APIs diretamente). As duas precisam estar concluídas antes da fase 2.

Escopo detalhado em `PROMPT_FASE_1.md`. Resumo:

- projeto `apps/api-go` (chi + Huma + pgx + sqlc, `log/slog`, Prometheus, OpenTelemetry);
- goose adotado como fonte única das migrations, com base nas 53 atuais, sem reexecutar nada em bancos existentes;
- primeiras migrations novas via goose: diretório provedor → célula e gatilhos de invalidação do cache de autenticação;
- papel `nexo_go` (membro de `nexo_app`, sem `BYPASSRLS`) para separar as estatísticas do banco por API;
- autenticação completa por cookie e Bearer: CSRF, sessão, suporte do operador, MFA pendente, permissões, módulos, POPs, limite por sessão, auditoria de negativas, cache Ristretto com invalidação;
- rotas `GET /api/subscribers/:id`, `GET /api/contracts/:id` e `GET /api/subscribers` (com `?format=csv`);
- harness de contrato (`tests/contrato/`) com dados esperados, comparação diferencial e mutações.

Concluída quando: todos os casos do harness passam para as três rotas; todas as mutações obrigatórias são detectadas; a carga de laboratório no perfil do piloto mostra Go ≤ Fastify em CPU da API e P99, sem regressão de CPU do banco acima da dispersão medida.

Nenhum tráfego de produção vai para o Go nesta fase.

### Fase 2 — Primeira virada em produção e leituras de maior tráfego

- As três rotas da fase 1 passam pelo canário em produção: 1 % (24 h) → 10 % (48 h) → 50 % (72 h) → 100 %.
- Depois, as **12 leituras de maior tráfego**, na ordem: `GET /api/me`, `GET /api/contracts` (com CSV), `GET /api/dashboard`, `GET /api/plans`, `GET /api/plans/:id/versions`, `GET /api/subscribers/:id/portal-access` e as leituras do portal do assinante (`/api/portal/overview`, `usage-series`, `acceptances`, `tickets`, `tickets/:id` e `surveys`), que usam a política restritiva por assinante (`app.subscriber_id`). `tickets` exige o módulo `crm` e `surveys` o módulo `field`.
- `GET /api/portal/cpe` fica para a fase 5, porque consulta o servidor TR-069 (E/S externa).
- Ainda sem cache de resultados de negócio: só o cache de sessão.

Concluída quando: as 15 rotas estão em `go` há 7 dias com os critérios de `METRICAS.md`, seção 5; a comparação por janelas alternadas confirma o ganho de CPU da API sem aumento do total API+banco além da dispersão.

**Portão de continuidade**: se a soma API+banco por requisição no Go não for menor ou igual à do Fastify nessas rotas, parar e reavaliar antes da fase 3 (seção 7).

### Fase 3 — Demais leituras (104 rotas)

- Leituras do núcleo, CRM, OS/estoque, FTTH, IPAM, relatórios, auditoria e financeiro em modo leitura (listas de faturas, aging, recebidos).
- Leituras com auditoria (`export.csv`, consulta de IP para ofício, exportação LGPD, download de documento) exigem a mesma linha em `audit_events`.
- `/aviso/:slug` (HTML público com CSP própria) entra aqui, com comparação de bytes do HTML.
- Os **25 GETs com escrita lateral** (ex.: `sweep()` de operações) e as leituras que consultam serviços externos (TR-069) **não entram aqui**: vão para a fase 5.

Ordem interna: por volume medido no log do proxy (fase 0), do maior para o menor, em lotes de 5 a 15 rotas do mesmo arquivo.

### Fase 4 — Escritas simples (115 rotas)

- Cadastros, catálogos, configurações, CRM, OS e estoque sem operação de rede, sem financeiro e sem E/S externa.
- Exigem teste de contrato com **comparação de estado do banco** e de `audit_events`, efeitos de `emitEvent()` (`webhook_deliveries`), `queueNotice()` (`notifications`) e `nextNumber()` (`tenant_counters`).
- Validação de entrada com mensagens idênticas às do Zod (`ARQUITETURA.md`, seção 7).

### Fase 5 — Escritas complexas, identidade, rede e API pública (81 rotas)

- **Identidade**: login (limite por e-mail/IP, `session_create`, cookie), logout, MFA (TOTP com `otplib`; o Go precisa aceitar os mesmos segredos e janelas), troca de senha, acesso de suporte do operador e gestão de usuários. A partir daqui o Go emite cookies.
- **Rede**: rotas que criam operações (`requestOperation`) e os `contractChangeHooks`. Entra o **River como fila de saída para o RADIUS integrado** (`ARQUITETURA.md`, seção 6). O executor do Node continua ativo como alternativa; a reserva com `skip locked` garante um único executor por operação.
- **OLT, TR-069 (ACS), avisos, webhooks de teste, importação de CSV**, que fazem E/S externa.
- **API pública `/public/v1/*`** (tokens, escopos, `api_rate`, `api_idempotency`).
- **GETs com escrita lateral** (`sweep()`, contadores) e leituras com E/S externa (TR-069).

### Fase 6 — Financeiro (18 rotas)

Faturamento (`/api/finance/generate`, `/api/invoices`), baixa manual e estorno, acordos, liberação em confiança, resolução de fatura, reconciliação, suspensão automática, entrada do gateway (`/api/webhooks/gateway/:gateway`) e mudança de contrato que gera multa (`PATCH /api/contracts/:id`).

Exige, além do contrato normal: testes de **idempotência** (mesma requisição e mesmo webhook repetidos), de **concorrência** (duas baixas simultâneas na mesma fatura, geração concorrente de faturas, acordo e baixa ao mesmo tempo) e conferência de invariantes contábeis (somas por fatura, nenhum pagamento duplicado, nenhuma fatura órfã), com Fastify e Go **misturados no mesmo ensaio**. Canário mais lento: 1 % por 7 dias, 10 % por 7 dias e 100 % depois de um fechamento de mês completo sem divergência.

### Fase 7 — Rotinas em segundo plano e API de agentes

- Rotinas periódicas de `worker.ts` (cobrança automática, reconciliação, alertas, entrega de avisos e webhooks, limpeza), mudanças agendadas, SLA e avisos ao assinante passam a ser **jobs periódicos do River**.
- **Exige uma alteração mínima no Fastify** para desligar cada rotina do lado Node (por variável de ambiente). Sem isso, as duas implementações rodariam a mesma rotina. Ver decisão D2 na seção 9.
- API dos agentes (`/agent/v1/*`, porta 8443, mTLS direto, fora do Caddy): migrada por último, com teste usando o agente Python real (`./nexo agent-test`) contra o Go.
- O serviço de túnel (`vpn.ts`) e o FreeRADIUS são **mantidos** como estão.

### Fase 8 — Desligamento do Fastify (opcional, aprovação separada)

- Só depois de todas as rotas em `go-consolidada`. `GET /api/health` passa para o Go por último.
- Etapa opcional: geração de tipos TypeScript a partir do OpenAPI do Huma para o `apps/web` (só tipos, sem mudar comportamento do painel; `ARQUITETURA.md`, seção 10).
- Remover o Fastify é uma decisão nova, fora deste plano.

### Possibilidade futura, fora do escopo: Templ + HTMX

Registrada apenas como opção para o **portal do assinante**, **depois** que todo o backend estiver em Go. Não faz parte de nenhuma fase acima, e o painel React não é afetado.

## 5. Critérios de conclusão de cada fase (resumo)

| Fase | Contrato | Segurança | Desempenho | Operação |
|---|---|---|---|---|
| 0 | regressões e e2e pelo proxy | cabeçalhos iguais aos de antes | linha de base de 7 dias | volta atrás ensaiada |
| 1 | 100 % dos casos, mutações detectadas | matriz de papéis × POPs × módulos × MFA | laboratório: Go ≤ Fastify em CPU da API e P99 | nenhuma rota em produção |
| 2–4 | 0 divergências no canário e no contínuo | 0 alertas de isolamento | portões de `METRICAS.md` | volta atrás ensaiada em cada lote |
| 5 | idem + estado do banco + efeitos externos simulados | login/MFA/suporte auditados igual | fila do RADIUS: P99 do atraso ≤ 2 s (hoje o laço é de 2 s) | executor duplo ensaiado |
| 6 | idem + idempotência e concorrência | idem | idem | um fechamento de mês sem divergência |
| 7 | rotinas: mesmo resultado em ensaio paralelo | idem | atraso de jobs periódicos ≤ o atual | Node desligado rotina a rotina |

## 6. Ritmo do canário

| Tipo de rota | 1 % | 10 % | 50 % | 100 % |
|---|---|---|---|---|
| Leitura | 24 h | 48 h | 72 h | depois de 7 dias sem gatilho |
| Escrita simples | 48 h | 72 h | 7 dias | depois de 7 dias sem gatilho |
| Escrita complexa / identidade | 72 h | 7 dias | 7 dias | depois de 14 dias sem gatilho |
| Financeiro | 7 dias | 7 dias | — | depois de um fechamento de mês |

Rotas de baixíssimo volume (menos de 100 requisições por dia) pulam os degraus de 1 % e 10 %, mas não o teste de contrato nem a observação de 7 dias em 100 %.

## 7. Quando parar ou voltar atrás no plano inteiro

- **Parar a migração** se, ao fim das fases 2 e 3, a comparação por janelas alternadas não mostrar redução de CPU da API por requisição **e** a soma API+banco por requisição for maior que a do Fastify além da dispersão. Nesse caso, as rotas já migradas podem ficar no Go (o contrato é o mesmo) ou voltar para o Fastify. A decisão é sua.
- **Volta geral** (todas as rotas para o Fastify) em qualquer incidente de isolamento entre provedores, perda de auditoria ou divergência financeira.
- A volta geral é um único arquivo de roteamento com tudo em `fastify` e pode ser executada a qualquer momento até a fase 7. Depois que uma rotina periódica for desligada no Node (fase 7), a volta dela exige religar a variável correspondente.

## 8. Riscos e mitigação

| Risco | Impacto | Mitigação |
|---|---|---|
| Divergência sutil de serialização (datas, `numeric`, `bigint`, nulos, ordem de chaves) | painel mostra valor errado | convenções de JSON fixas (`ARQUITETURA.md`, seção 7) e comparação estrutural em todos os casos |
| Mensagens de validação diferentes das do Zod | painel mostra texto diferente | validador compatível com as mensagens do Zod e corpus de entradas inválidas por rota |
| Ordem dos controles diferente (CSRF → sessão → limite → MFA → permissão → tenant → módulo → validação) | código de erro diferente | autenticação como middleware antes do Huma; validação automática do Huma desligada; casos de ordem no harness |
| Cache de sessão servir sessão bloqueada | acesso após bloqueio/suspensão | validade de poucos segundos, invalidação por `LISTEN/NOTIFY` disparada no banco, limpeza total se o canal cair |
| Limite por sessão contado em dois processos | limite efetivo maior | já é por réplica hoje (documentado no código); manter, registrar no painel de métricas |
| `select c.*` ganhar coluna nova numa migration | Go omite o campo | teste de "conjunto de chaves" por rota e regeneração do sqlc no CI |
| Mudança de produto feita só no Fastify durante a coexistência | volta atrás deixa de ser segura | regra de PR duplo e verificação de deriva no CI |
| Executor RADIUS duplicado (Node e Go) | operação aplicada duas vezes | reserva com `for update skip locked` e exclusividade por equipamento já existentes; teste com dois executores concorrentes |
| Rotinas periódicas rodando nas duas stacks | cobrança ou aviso duplicado | fase 7 só com desligamento rotina a rotina no Node (decisão D2) |
| `plan_cache_mode` só no Go | comparação injusta entre stacks | medir também o Go com `auto` em laboratório; aplicar ao papel `nexo_app` só se aprovado (decisão D3) |
| Diretório de células adiciona consulta por transação | latência | diretório em memória, invalidado por `NOTIFY`; com uma célula, verificação local |
| Fila do River visível a todos os provedores | vazamento de dados de outro provedor | argumentos dos jobs só com IDs; tabelas do River acessíveis só ao papel do Go; sem dados pessoais em jobs |
| Equipe mantendo duas stacks por meses | custo de manutenção | fases curtas, lotes por arquivo de rotas, portão de continuidade na fase 2 |

## 9. Decisões de execução autorizadas

| ID | Decisão | Recomendação |
|---|---|---|
| D1 | **Aprovada pela autorização de continuidade integral de 16/10/2026.** Permitir **alteração só de teste** no Fastify: `apps/api/test/helpers.ts` passa a aceitar `NEXO_TEST_BASE_URL` para rodar as 41 regressões por HTTP contra o proxy (Fastify + Go). Sem mudança de código de execução. | Aprovar. É a maior rede de segurança disponível. |
| D2 | **Aprovada pela mesma autorização, para executar junto à migração das rotinas.** Fase 7: adicionar ao Fastify variáveis para desligar cada rotina periódica e o executor do RADIUS integrado. | Aprovar quando chegar a fase 7. |
| D3 | `plan_cache_mode`: só nas conexões do Go (recomendado agora) ou também no papel `nexo_app` (afeta o Fastify; no piloto deu −31 % de CPU total também no Fastify). | Só no Go agora; reavaliar depois da fase 2. |
| D4 | Proxy: Caddy (já em produção, TLS automático) ou HAProxy (usado no bench). | Caddy. |
| D5 | Papel `nexo_go` separado, membro de `nexo_app`, para separar estatísticas do banco por API. | Aprovar. |
| D6 | Formato futuro do token de sessão com prefixo de célula (só quando houver mais de uma célula). | Adiar. Com uma célula, tokens atuais valem para a célula padrão. |
| D7 | Local do projeto Go: `apps/api-go` no mesmo repositório e migrations em `db/migrations` na raiz. | Aprovar. |
