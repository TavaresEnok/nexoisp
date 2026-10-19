# Aplicação oficial e validação

O frontend oficial é `apps/web`, baseado no v0. `apps/web-legacy` permanece exclusivamente como referência de contratos e comportamentos: não integra o workspace npm, a imagem Caddy ou os imports da aplicação. `docs/novo-design-nexoISP` continua como referência original preservada.

## Executar

- Instalar com `npm ci` na raiz, usando Node 22.
- Iniciar com `API_URL=http://127.0.0.1:18081 npm -w apps/web run dev`, ajustando a URL para o backend Go da instalação. O endereço padrão do Vite é `http://127.0.0.1:3000`.
- Gerar com `npm -w apps/web run build` ou construir a imagem `docker build -f infra/prod/caddy/Dockerfile -t nexo-frontend .`.
- Caddy usa `NEXO_DOMAIN` e `NEXO_GO_UPSTREAM`. A imagem incorpora somente a aplicação oficial e preserva as rotas HTTP nativas do Go.
- O acesso operacional exige as contas e permissões reais do Go. Não há banco no navegador nem autenticação simulada. `/demonstracao/` permanece um contexto fictício independente, sem comandos operacionais.

## Testes reproduzíveis

`npm -w apps/web run typecheck`, `npm -w apps/web test` e `npm -w apps/web run build` executam verificações locais. A fumaça `npm -w apps/web run test:e2e` cobre os fluxos operacionais em sequência e deve ser direcionada **exclusivamente a um laboratório descartável**, pois cria e altera registros.

`python3 tests/contrato/frontend_v0.py --serve` cria PostgreSQL e Go isolados, com contas sintéticas, secrets próprios e jobs desligados. Não lê `.env` do produto. O frontend de validação deve apontar para a API desse harness. A porta do protocolo do agente é a porta HTTP mais 2000; informe `V0_AGENT_URL` se mudar a porta padrão. O processo do harness remove seu contêiner ao encerrar normalmente.

A execução dirigida de CPE/Wi-Fi usa `NEXO_V0_ACS=1` com as portas HTTP, PostgreSQL, agente e ACS separadas do primeiro laboratório. A fixture ACS TR-098/TR-181 nunca acessa roteador físico.

A execução dirigida `test:network-final` usa `NEXO_V0_NETWORK=1` em outro harness. A fixture prepara somente uma chave pública sintética e habilita os contratos de geração de instruções de túnel; não inicia WireGuard, IPsec, NAS nem interface de rede. Informe explicitamente `BASE`, `V0_VALIDATION_DB_CONTAINER` e `V0_VALIDATION_DB_PORT`. O teste valida o rótulo de laboratório antes de preparar fingerprint e timestamp sintéticos no banco.

`test:integrations` testa tokens, assinaturas e destinos por HTTP local. Com `V0_VALIDATION_DB_CONTAINER` e `V0_VALIDATION_DB_PORT`, acrescenta reenvio de uma entrega cuja falha anterior é preparada no banco descartável rotulado. Sem essas variáveis, valida a fila pendente sem acesso administrativo ao banco. Nenhum segredo de aplicação é registrado nas evidências.

## Limites preservados

A integração de interface não homologa equipamento ou serviço externo: driver Huawei, CGNAT de laboratório, entrega IPv6, histórico de prefixos, gateway financeiro real e distribuição multicélula mantêm os limites do Go documentados na matriz. Migração direta universal de SGP/MK-Auth não existe: o importador aceita CSV intermediário e faz prévia, mapeamento, aplicação e provisionamento separado. Jobs de cobrança, limpeza, avisos e expiração só executam quando habilitados no backend.

Tarefas de rede exibem intenção, observação e resultado incerto separadamente. Não use a presença de uma operação ou instrução emitida como prova de execução no equipamento.

## Regressão das correções R01–R06

A fumaça agora exige `BASE` explicitamente e inclui `frontend-v0-remediation.mjs` (26 cenários). `BASE` deve apontar para frontend conectado ao harness descartável; nunca aponte a execução de escrita ao Go operacional do usuário. O teste novo cria um provedor exclusivo e confirma o modo de laboratório antes de executar.

`BASE=http://127.0.0.1:18394 npm -w apps/web run test:remediation` executa os 13 casos compostos dirigidos. `npm -w apps/web run format:check` verifica os módulos formatados.

A comparação operacional exige `V0_OPERATIONAL_VISUAL=1`. Para reprodução exata, use o contêiner `mcr.microsoft.com/playwright:v1.55.1-jammy` da CI, rede host, `/e2e` montado e a pasta de evidências montada em `/docs/integracao-v0/evidencias`, como em `tests/contrato/e2e.py`. Fontes de sistema de outros hosts podem renderizar o atalho de teclado de forma diferente. Seis PNGs de referência ficam em `e2e/visual-baselines/operacional`; o teste compara hashes e falha sem atualizar arquivos. `UPDATE_V0_OPERATIONAL_VISUAL=1` é reservado à geração explícita de referências após revisão visual; não deve ser habilitado na CI.

As capturas normalizam apenas datas variáveis e mascaram identificadores. Persistência e autorização são verificadas por comandos e leituras reais, independentemente das capturas. A evidência final está no [relatório das seis correções](CORRECOES-REVISAO.md).

## Frontend ativo no ambiente local

Em 19/10/2026 o serviço `nexoisp-go-caddy-1` foi atualizado para a imagem validada `nexo-v0-frontend:corrections`, publicada localmente também como `nexoisp-go-caddy:latest`. **`http://localhost:18081` agora serve o frontend oficial v0.** O endereço existente da instalação permanece válido.

Foi recriado somente o serviço `caddy`, usando os mesmos três arquivos Compose registrados no contêiner e `up -d --no-deps --no-build caddy`. A API e o PostgreSQL mantiveram os mesmos IDs e horários de início. A imagem anterior foi preservada como `nexoisp-go-caddy:before-v0-20261019` para reversão.

A verificação conferiu HTML/ativos oficiais, saúde HTTP 200, sessão ausente HTTP 401, login, proteção da rota de assinantes e demonstração v0 no navegador, sem erros de execução e sem gravar registros de negócio. Evidência: [ativacao-local-v0.json](evidencias/ativacao-local-v0.json). Esta ativação é local, sem publicação em servidor externo.
