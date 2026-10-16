# NexoISP — Arquitetura e direção do produto

Versão 1.0 · 9 de outubro de 2026

**Nome de trabalho:** NexoISP. Sugestão de identidade, sem pesquisa de disponibilidade de marca ou domínio.

## 1. Objetivo

Construir um ERP proprietário em modelo SaaS para provedores de internet. A primeira oferta deve substituir os processos essenciais usados pelo provedor piloto no MK-Auth. A evolução poderá ampliar a cobertura para funções encontradas em plataformas como SGP/TSMX.

O núcleo inicial reúne assinantes, contratos, planos, autenticação PPPoE, MikroTik, cobrança, suspensão, reativação, migração e portal do assinante. O tráfego de internet dos assinantes não passa pelo SaaS.

Priorizar uma entrega utilizável e rápida. Não construir antecipadamente uma plataforma universal para todos os fabricantes, milhares de provedores ou todos os processos de um ERP.

## 2. Como usar estes quatro documentos

| Arquivo | Papel |
|---|---|
| `01-arquitetura-e-direcao-do-produto.md` | Objetivo, escopo tecnológico e responsabilidades |
| `02-especificacao-do-mvp.md` | Comportamentos, dados e requisitos do produto |
| `03-decisoes-de-arquitetura.md` | Decisões técnicas e limites de implementação |
| `04-etapas-e-prompts-de-desenvolvimento.md` | Ordem de execução, entregas e prompts para a IA |

Instruções explícitas posteriores do proprietário prevalecem sobre estes documentos. Entre estes arquivos, requisitos de comportamento ficam no 02, escolhas técnicas no 03 e ordem de trabalho no 04. Registrar mudanças relevantes na seção correspondente, sem manter duas decisões incompatíveis.

Este pacote consolida o planejamento para iniciar o desenvolvimento. As propostas técnicas abaixo são a base recomendada; não representam regras comerciais já aprovadas ou equipamentos já homologados.

## 3. Tecnologias de referência

| Camada | Escolha inicial |
|---|---|
| Web | React, TypeScript, Vite |
| Interface | Tailwind CSS e shadcn/ui, se o projeto ainda não tiver padrão |
| Backend | Go, Chi/Huma e executáveis nativos para API, VPN e administração |
| Dados | PostgreSQL; SQL explícito e Kysely como opção inicial de acesso |
| Agente | Python; validação de mensagens e drivers por operação |
| Persistência do agente | SQLite para tentativas, resultados e sincronização |
| RADIUS | Serviço local independente; candidato definido por prova técnica |
| Infraestrutura | Linux, containers e Docker Compose inicialmente; VMs/Proxmox conforme ambiente |
| Rede MikroTik | API segura e RADIUS conforme capacidade homologada |
| Automação adicional | Nornir, Scrapli e Netmiko apenas quando necessários ao conector |
| Qualidade | Verificação de tipos/build e poucos testes dirigidos aos riscos |

Ao iniciar um repositório novo, escolher versões estáveis compatíveis e fixá-las nos arquivos de dependências. Num repositório existente, preservar ferramentas equivalentes que já funcionem. Não trocar bibliotecas por preferência estética.

Não introduzir inicialmente Kubernetes, Kafka, RabbitMQ, microserviços por módulo, Redis obrigatório, segundo backend FastAPI ou abstrações multivendor sem uso concreto.

## 4. Responsabilidades

### Aplicação central

O backend Go concentra autenticação, autorização, isolamento, cadastros, regras comerciais, integração financeira, estado desejado e tarefas. Organizar o código em módulos de identidade, clientes, contratos, financeiro, rede e operações.

Workers podem ser processos separados do mesmo produto, reutilizando módulos e contratos. O monólito modular não exige um único processo ou servidor.

O PostgreSQL guarda dados transacionais e tarefas de rede. Mudanças relacionadas de estado desejado e tarefa são gravadas na mesma transação. Usar outbox apenas onde houver publicação que precise sobreviver a falhas; evitar duplicar mecanismos sem necessidade.

### Agente local

O agente inicia comunicação com a nuvem, recebe operações estruturadas, consulta equipamentos, aplica mudanças permitidas e devolve evidências. Não recebe shell livre. O backend determina a intenção comercial; o agente executa e verifica o efeito técnico.

Implementar primeiro o driver MikroTik e a integração com um motor RADIUS. Bibliotecas de SSH não são obrigatórias quando a API homologada atende à operação.

### RADIUS e equipamentos

O RADIUS responde usando dados locais sincronizados. Sua autenticação não depende de uma chamada à nuvem a cada conexão e deve continuar durante reinício do agente.

MikroTik/BNG mantém sessões e aplica políticas. O ERP não encaminha pacotes de assinantes nem executa CGNAT no backend.

## 5. Estrutura inicial sugerida

```text
apps/
  web/
  api/
services/
  network-agent/
packages/
  contracts/
  database/
infra/
  compose/
docs/
```

Não criar pacotes vazios ou uma estrutura extensa antes de existir código que a use. O worker pode começar dentro de `apps/api`. Portal e painel podem compartilhar o aplicativo web com rotas e autorizações diferentes.

## 6. Escopo e evolução

**MVP comercial:** gestão básica do provedor, assinantes, planos, contratos, PPPoE/RADIUS, MikroTik, cobrança recorrente por um gateway, conciliação, suspensão/reativação, portal simples, importador MK-Auth, auditoria e saúde do agente.

**Depois do piloto:** primeira OLT homologada, ONUs, CGNAT, IPAM, FTTH, estoque, ordens de serviço, CRM, novos conectores e NOC. IA assistiva fica fora do caminho crítico inicial.

**Fiscal:** identificar o processo necessário ao piloto. Implementar integração se ela for necessária à operação de lançamento; não assumir que preparar tabelas resolve a emissão.

**Capacidade:** medir com o volume do piloto. Milhões de contratos e 40 Gbps não são requisitos de compra ou metas comprovadas para a primeira entrega.

## 7. Forma de acelerar

Entregar telas e fluxos completos em incrementos curtos. Usar dados simulados para avançar quando faltar acesso externo, identificando claramente a simulação. Dar preferência a uma única opção por integração e ambiente de instalação.

Não exigir cobertura percentual, dezenas de testes por endpoint, observabilidade complexa ou documentação de cada função. Automatizar somente proteções críticas e usar verificações manuais para mudanças visuais simples.

A rapidez não autoriza remover isolamento, deduplicação financeira ou validação de operações obsoletas. Esses mecanismos fazem parte do comportamento do produto.

## 8. Decisões externas ainda necessárias

| Decisão | Quando é necessária | Como avançar enquanto falta |
|---|---|---|
| Provedor piloto, volume e equipamentos | Antes de homologar e migrar | Laboratório e dados sintéticos |
| Acesso a CHR/equipamento | Antes de comprovar integração real | Driver simulado, explicitamente identificado |
| Política comercial de suspensão | Antes de ativar automação em produção | Política de demonstração, sem efeito em produção |
| Gateway e credenciais sandbox | Etapa financeira | Adaptador de demonstração |
| Motor RADIUS e distribuição | Antes do piloto instalado | Comparar candidatos no laboratório |
| Processo fiscal e regras comerciais | Antes da operação comercial | Registro explícito de pendências |

Não inventar senhas, endpoints, dados do provedor ou decisões comerciais. Escolhas técnicas reversíveis podem ser feitas pela IA e registradas sem interromper o trabalho.
