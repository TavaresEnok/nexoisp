# NexoISP — Etapas e prompts de desenvolvimento

Versão 1.0 · 9 de outubro de 2026

## 1. Estratégia de execução rápida

Desenvolver o MVP em entregas utilizáveis. Não começar por semanas de fundação isolada nem pedir à IA para fabricar o ERP inteiro em uma única resposta.

O prompt mestre abaixo autoriza avançar pelas etapas do MVP sem pedir confirmação entre tarefas locais reversíveis. Os prompts de etapa servem para iniciar, retomar ou concentrar o trabalho em uma entrega. Não é necessário colar todos de uma vez.

Falta de integração externa não impede código local: criar um adaptador de demonstração explícito, concluir a parte independente e registrar exatamente o que falta para homologar. Não marcar integração simulada como pronta para produção.

Não há cronograma em dias porque equipe, horas disponíveis e acessos ainda não foram informados. Ao concluir a primeira etapa, estimar as próximas com base no progresso real. Trabalhar com um marco ativo por vez.

## 2. Ordem e critérios de conclusão

| Etapa | Entrega | Concluída quando |
|---|---|---|
| E1 — Produto navegável | Login, tenants, assinantes, planos, contratos e interface básica | Um usuário opera os cadastros no banco real; isolamento mínimo verificado |
| E2 — Rede em demonstração | Estado desejado, tarefas, agente persistente e driver simulado | Provisionar, suspender e reativar atravessam API/agente e exibem resultado |
| E3 — Rede real | Um RADIUS, MikroTik, sessão PPPoE e recuperação | Laboratório comprova ciclo e falhas essenciais; simulação não basta |
| E4 — Financeiro | Recorrência, gateway, eventos e conciliação | Ciclo de sandbox funciona sem duplicação; suspensão depende de política configurada |
| E5 — Migração e portal | Importador, simulação, acesso do assinante e faturas | Dados de amostra conferidos; portal isolado; formato real validado quando disponível |
| E6 — Piloto | Instalação, monitoramento, backup, segurança final e virada controlada | Grupo piloto opera; restauração e reversão têm procedimento exercitado |

E1 e E2 produzem uma demonstração utilizável rapidamente. E3 estabelece a validade técnica. E4–E6 transformam a demonstração em MVP comercial.

É permitido desenvolver E4/E5 enquanto falta equipamento em E3, mas a pendência de homologação continua aberta e bloqueia o piloto real.

## 3. Prompt mestre — desenvolvimento do MVP

Copie este bloco para a IA dentro do repositório:

```text
Você vai desenvolver o NexoISP, ERP SaaS proprietário para provedores de internet.

Leia os quatro arquivos em docs/:
- 01-arquitetura-e-direcao-do-produto.md
- 02-especificacao-do-mvp.md
- 03-decisoes-de-arquitetura.md
- 04-etapas-e-prompts-de-desenvolvimento.md

Objetivo: entregar o MVP descrito, avançando pelas etapas E1 a E6. Trabalhe no código e nos arquivos do projeto; não termine apenas com um plano. O roadmap posterior ao MVP não está autorizado para implementação nesta execução.

Primeiro inspecione o repositório, as instruções locais e o que já funciona. Preserve trabalho existente. Se estiver vazio, monte apenas a estrutura necessária à etapa atual. Se houver tecnologia equivalente já estabelecida, evite reescrever sem necessidade concreta.

Priorize velocidade: implemente fluxos completos, telas simples e integrações diretas. Faça escolhas técnicas reversíveis sozinho e registre as relevantes. Não peça confirmação a cada arquivo ou etapa. Peça informação apenas quando faltar dado indispensável, regra comercial ou autorização para uma ação externa; continue o trabalho independente enquanto isso.

Não crie microserviços, Kafka, Kubernetes, um segundo backend central, frameworks internos, pacotes vazios, dashboards complexos ou conectores extras. Use PostgreSQL para tarefas de rede e um único driver/gateway real por vez.

Mantenha os controles essenciais: isolamento de tenant no backend e banco; proteção dos segredos; operações tipadas; persistência das tentativas; rejeição de intenções obsoletas; consulta antes de repetir efeito incerto; deduplicação de cobranças e pagamentos. Não substitua esses comportamentos por avisos na interface.

Testes enxutos: execute build/verificação de tipos das partes alteradas e verifique o fluxo entregue. Adicione apenas regressões pequenas para isolamento, duplicidade financeira, operação obsoleta e recuperação quando esses recursos existirem. Não persiga cobertura percentual, não teste detalhes triviais e não repita a suíte inteira sem motivo. Use um roteiro de laboratório para PPPoE real.

Sem acesso externo, implemente a interface e um adaptador de demonstração claramente identificado. Dados de demonstração nunca devem habilitar integrações ou suspensões em produção. Não invente credenciais, formato do MK-Auth, regras comerciais ou evidências de homologação.

Não execute cobranças reais, migração ou comandos na rede de produção sem autorização explícita para o ambiente e a ação. A criação local do código não autoriza a virada do provedor.

Mantenha uma seção curta de progresso ao final do arquivo 04, com etapa atual, o que funciona, como executar, verificações feitas e bloqueios concretos. Diferencie implementado, validado localmente e homologado externamente. Não crie documentação redundante para cada alteração.

Continue pela próxima etapa quando a atual estiver concluída e houver condições. Se encontrar dependência externa, conclua o restante autorizado e registre a pendência sem declarar o MVP completo. Ao terminar a execução, informe resultado utilizável, como abrir/rodar e próximo bloqueio real em poucas linhas.

Comece agora inspecionando o repositório e implementando a primeira etapa ainda incompleta.
```

## 4. E1 — Aplicação utilizável

Entrega: banco e migrations, login, papéis iniciais, dois tenants de demonstração, assinantes, planos, contratos e navegação. Sem dashboard analítico elaborado. O painel inicial pode mostrar apenas listas e indicadores obtidos dos dados existentes.

```text
Execute a E1 do NexoISP conforme os quatro documentos em docs/.

Entregue uma aplicação local utilizável com Fastify, React/TypeScript e PostgreSQL: login, contexto autorizado de tenant, assinantes, planos e contratos. Use migrations e dados sintéticos de dois provedores. Inclua permissões básicas, validação e estados de carregamento/erro na interface.

Não comece financeiro, OLTs ou integração real de rede nesta etapa. Prepare os vínculos de contrato/plano necessários ao próximo fluxo, sem criar módulos futuros vazios.

Verifique build/tipos e o fluxo de cadastro. Faça uma regressão pequena provando que um tenant não lê nem altera dados do outro, usando o papel real da aplicação no banco. Não adicione testes de componentes visuais triviais.

Conclua com instruções curtas para executar e abrir a aplicação. Atualize o progresso no documento 04.
```

## 5. E2 — Motor e agente em demonstração

Entrega: operações versionadas, worker, transporte autenticado de desenvolvimento, assinatura de envelopes, SQLite local e driver simulado. A interface permite solicitar operações e acompanhar evidências.

```text
Execute a E2 do NexoISP, preservando a E1.

Implemente o estado desejado versionado, as tarefas no PostgreSQL e o agente Python com persistência SQLite. Use comunicação iniciada pelo agente, identidade individual e configuração mTLS de desenvolvimento. Valide operações estruturadas e integridade do envelope com bibliotecas consolidadas.

Crie um driver de demonstração que simule provisionar, suspender e reativar. Na interface, mostre intenção, estado observado, última atualização e resultado da operação. Identifique claramente o ambiente simulado.

Implemente agora os comportamentos de operação substituída e resultado incerto; não deixe para uma refatoração posterior. Serializar escritas por equipamento e persistir as etapas essenciais. Reentrega legítima deve reutilizar evidência ou verificar o resultado.

Faça verificações pequenas para suspensão obsoleta e efeito aplicado com confirmação perdida, incluindo recuperação após reinício quando aplicável. Não monte uma plataforma genérica de testes nem simule dezenas de fabricantes.

Entregue o ciclo completo pela interface e registre como reproduzi-lo.
```

## 6. E3 — PPPoE real e recuperação

Entrega: ambiente reproduzível, um motor RADIUS, MikroTik homologado, cliente PPPoE, perfis e sessões. É a etapa que comprova a integração técnica.

```text
Execute a E3 do NexoISP com foco em um RADIUS e MikroTik RouterOS v7.

Identifique o ambiente disponível. Se ainda não houver candidato RADIUS escolhido, prepare uma prova com um candidato e registre a escolha como experimental. Verifique a documentação da versão efetiva ao implementar a integração.

Prepare configuração reproduzível para laboratório com RADIUS, MikroTik CHR ou equipamento autorizado e cliente PPPoE. Reutilize o catálogo de operações da E2, implementando o driver real sem quebrar a demonstração.

Comprove provisionamento, autenticação, perfil, suspensão e reativação. Separe mudança de autorização e tratamento de sessão. Confira os resultados; ausência de cliente online não deve impedir concluir uma autorização liberada.

Exercite apenas os casos críticos: nuvem indisponível com RADIUS local ativo; suspensão obsoleta; perda de confirmação; reinício do agente e posse expirada. Use cenários curtos reproduzíveis e preserve evidências suficientes.

Se não houver equipamento/acesso, conclua o código e roteiro que puder, liste exatamente a informação faltante e mantenha a homologação pendente. Não apresente mocks ou radclient isolado como prova de sessão PPPoE real.
```

## 7. E4 — Financeiro e automação comercial

Entrega: faturas, recorrência, gateway único, webhook, conciliação e ligação com estado desejado de rede. Regras comerciais não configuradas ficam inativas em produção.

```text
Execute a E4 do NexoISP.

Implemente faturas e itens, recorrência idempotente, pagamentos, eventos financeiros e tela de conciliação. Use valores monetários exatos. Preserve registros históricos.

Integre um gateway em sandbox se já estiver definido e acessível. Caso contrário, implemente um adaptador de demonstração identificado e a interface necessária à futura integração; não invente uma API externa.

Valide autenticidade dos eventos, correlação da cobrança, duplicatas e ordem de processamento. Inclua consulta de conciliação para notificações perdidas. Pagamento confirmado deve atualizar a intenção do serviço conforme política vigente, sem marcar a rede como restaurada antes da confirmação técnica.

Implemente suspensão automática somente para política explicitamente configurada. Não invente juros, multa, tolerância ou regra de estorno. Pode criar um cenário sintético de demonstração sem ativação em produção.

Verifique um ciclo de cobrança/pagamento e regressões pequenas de recorrência e webhook duplicados. Reutilize a proteção existente contra suspensão obsoleta. Sem suíte extensa ou múltiplos gateways.
```

## 8. E5 — Portal e migração

Entrega: portal simples e importação repetível com simulação. O formato inicial precisa ser declarado; compatibilidade com o MK-Auth depende de amostra real.

```text
Execute a E5 do NexoISP.

Crie o portal do assinante com autenticação e acesso restrito a seus contratos, faturas e meios de pagamento. Reaproveite a interface e os componentes existentes. Não inclua CRM, chat ou aplicativo móvel.

Implemente importação com prévia, mapeamento, erros por registro, identificador de origem e reexecução sem duplicação. Se houver exportação autorizada do MK-Auth, adapte ao formato real. Sem amostra, crie um formato CSV intermediário documentado e dados sintéticos; mantenha a compatibilidade MK-Auth como pendente.

Permita conferir quantidades e valores antes de aplicar. Não transforme credenciais ausentes em senhas inventadas nem descarte silenciosamente títulos incompatíveis.

Verifique acesso isolado no portal e uma reimportação da mesma amostra. Documente um procedimento curto de corte e reversão que preserve eventos posteriores. Não execute migração em produção nesta etapa sem autorização explícita.
```

## 9. E6 — Preparação e piloto

Entrega: operação recuperável com observabilidade básica, instalação, atualização segura e grupo inicial autorizado. Não confundir “pronto para implantar” com “implantado”.

```text
Execute a preparação E6 do NexoISP.

Feche apenas as lacunas necessárias ao piloto: instalação reproduzível, configuração de segredos, MFA administrativo, certificado/rotação do agente, saúde e atraso de sincronização, alerta de operação incerta, backup/restauração e atualização autenticada do agente.

Prepare limites e procedimentos para indisponibilidade local, disco cheio, manutenção e troca de executor. Valide compatibilidade de migrations ao atualizar ou reverter o agente. Não crie observabilidade sofisticada sem necessidade.

Use o volume conhecido do piloto para uma medição curta. Não prometa SLA ou capacidade não testados. Registre limitações e decisões externas ainda necessárias, inclusive política comercial e processo fiscal.

Prepare uma lista curta de entrada em produção: grupo autorizado, responsáveis, cópia de segurança, configuração validada, fonte autoritativa e reversão. Faça um exercício de restauração no ambiente de teste.

Se ainda não houver autorização explícita de produção, entregue tudo pronto para revisão e descreva a ação exata de virada que depende dela. Se houver autorização e acessos suficientes, execute somente o escopo autorizado e confira o resultado.
```

## 10. Evolução após o MVP

Implementar somente quando solicitada, uma expansão por vez:

| Ordem sugerida | Expansão | Limite inicial |
|---|---|---|
| 1 | OLT/ONU | Um fabricante, modelo e firmware; descoberta, autorização e leitura de estado |
| 2 | IPAM e CGNAT | Planejamento, validação, aplicação revisável e rastreabilidade conforme operação exigida |
| 3 | OS, estoque e FTTH | Fluxos reais do provedor e modelo de inventário necessário |
| 4 | CRM, integrações fiscais adicionais e multivendor | Priorizar demanda e custo de suporte |
| 5 | NOC e IA assistiva | Diagnóstico com evidência; sem escrita autônoma irrestrita em rede |

A prioridade pode mudar conforme o piloto, inclusive antecipando fiscal se necessário. Os módulos futuros exigem especificação própria: não há informação suficiente nestes quatro arquivos para a IA inventar todo o comportamento de cada um.

### Prompt de expansão

```text
Implemente a expansão explicitamente indicada na minha mensagem, preservando o MVP do NexoISP e seguindo docs/.

Inspecione o que existe e faça uma descrição curta do fluxo que será entregue. Identifique dados de fabricante, firmware, regra comercial ou integração que sejam indispensáveis. Não presuma suporte universal.

Entregue um fluxo completo e restrito, reaproveitando identidade, tarefas, auditoria e reconciliação. Não crie uma segunda infraestrutura de automação. Mantenha verificações proporcionais ao risco e teste a integração real quando houver acesso autorizado.

Não amplie o escopo para outras expansões. Diferencie código implementado, demonstração e homologação real ao concluir.
```

## 11. Prompt curto para retomar

```text
Leia docs/ e inspecione o estado real do repositório. Continue a primeira etapa incompleta do NexoISP, conforme o prompt mestre no arquivo 04. Não recomece nem reescreva o que já funciona. Priorize código utilizável, mantenha apenas verificações essenciais e avance no trabalho independente de bloqueios externos. Atualize o progresso ao terminar.
```

## 12. Progresso

**Atualizado em 10/10/2026.** Legenda: **validado localmente** = exercitado nesta máquina; **homologado** = comprovado com o sistema externo real.
**O MVP NÃO está concluído:** E4 e E6 têm requisitos obrigatórios que dependem de gateway e autorizações externas; a E3 foi comprovada em laboratório virtual, faltando o equipamento do piloto.

### Situação por etapa

| Etapa | Implementado | Validado localmente | Falta para concluir |
|---|---|---|---|
| E1 | Login, provedores, acesso de suporte auditado, 6 papéis, assinantes, planos versionados, contratos com histórico, auditoria | Sim (API, banco e navegador) | — **concluída** |
| E2 | Intenção versionada, tarefas no PostgreSQL, API de agentes com mTLS, envelope assinado (Ed25519), agente Python + SQLite, driver de demonstração, telas de rede/operações | Sim, ciclo completo pela interface | — **concluída (demonstração)** |
| E3 | Driver `mikrotik_radius` (FreeRADIUS em SQLite + API RouterOS com TLS), pacote `infra/site`, laboratório `infra/lab` | **Sim, em laboratório real virtual**: CHR RouterOS 7.24.5 + cliente PPPoE, 12 casos de `docs/lab-pppoe.md` aprovados | — **concluída em laboratório.** Repetir no equipamento físico/versão do piloto antes da virada |
| E4 | Faturas, recorrência idempotente, pagamentos, eventos, conciliação, política de suspensão/reativação explícita por provedor | Sim, com gateway de **demonstração** | **Gateway real não integrado** (não definido, sem sandbox). Regras comerciais pendentes |
| E5 | Portal do assinante, importador CSV com prévia/mapa/erros por linha/lotes, provisionamento de lote | Sim, com dados sintéticos | Formato real do **MK-Auth não validado** (sem amostra) |
| E6 | MFA (TOTP), sessão em cookie `HttpOnly`, backup/restauração, compose de produção e de site, pacote assinado do agente, certificado fixado, rotação de chave, saúde/alertas (log e webhook), `docs/operacao.md` | Instalação de produção exercitada localmente do zero; backup+restauração; atualização assinada 0.1.0→0.2.0 no laboratório; rotação de chave | Host público real, piloto e virada **não executados** (sem autorização/ambiente) |

### Expansões após o MVP

| Expansão | Situação |
|---|---|
| 1 — OLT/ONU | **Em andamento (10/10/2026).** Fluxo completo (descoberta, autorização, leitura de estado/sinal, desautorização, troca) validado com OLT simulada. Primeiro fabricante: **Huawei SmartAX por CLI/SSH — implementado e testado só contra emulador próprio; não homologado em equipamento real**. Detalhes em `docs/expansao-olt-onu.md` |
| 2 — IPAM e CGNAT | **Implementada e validada localmente (10/10/2026).** Blocos, IP fixo (registro), plano de CGNAT determinístico, script RouterOS para revisão, rastreio. Tradução comprovada no CHR do laboratório (`./nexo lab cgnat`). O sistema não aplica CGNAT em equipamento |
| 3 — OS, estoque, FTTH | **Implementada e validada localmente (10/10/2026).** Ordens de serviço com material, estoque por razão de movimentos, caixas e portas da rede óptica. Dados sintéticos |
| 4 — CRM, fiscal adicional, multivendor | **CRM implementado e validado localmente (10/10/2026):** prospectos, atendimentos, chamados pelo portal, exportação contábil em CSV. **Fiscal e multivendor não iniciados** (dependem de terceiros) |
| 5 — NOC e IA assistiva | **NOC e diagnóstico por regras implementados e validados localmente (10/10/2026).** Somente leitura. **IA assistiva não implementada** (chave de terceiro + decisão de LGPD) |

As expansões 2 a 5 foram feitas de uma vez por instrução do proprietário em 10/10/2026, pulando o que depende de terceiros. Detalhes e limites em
`docs/expansoes-2-a-5.md`. **Tudo o que foi pulado, em ordem de prioridade: `docs/05-prioridades-pos-projeto.md`.**

### Como executar e abrir

```bash
./nexo up                 # http://localhost:18080  (contas de demonstração na tela de login; senha demo1234)
./nexo test && ./nexo agent-test && ./nexo lab-radius
./nexo lab-up             # laboratório PPPoE real: MikroTik CHR em KVM (container privilegiado) + cliente pppd;  ./nexo lab-down remove
```

Demonstração pela interface: `admin@alfa.demo` → Contratos → abrir um contrato → "Provisionar acesso" (equipamento *NAS Demo*) → Suspender/Reativar
e ver as evidências. Financeiro: Política de cobrança → gateway "Demonstração" → Faturas → gerar competência → abrir fatura → "Simular pagador".
Falhas simuladas: `./nexo demo-tool <device_id> lose-ack` (confirmação perdida) e `... manual <usuario> suspended` (alteração externa).
Portal: ficha do assinante → "Criar acesso ao portal". Operador do SaaS: `operador@nexoisp.demo`.
Detalhes de operação e produção: `docs/operacao.md`. Decisões técnicas tomadas: fim de `docs/03-decisoes-de-arquitetura.md`.

### Verificações realizadas (10/10/2026)

- Tipos e build de API e web: sem erros.
- `./nexo test` — 61 testes na API (26 do MVP + 6 da expansão OLT/ONU + 27 das expansões 2 a 5 e complementos), com o papel real `nexo_app`: isolamento entre provedores (API, SQL direto, conexão reutilizada, FK composta); permissões;
  recorrência e webhook/pagamento duplicados; evento perdido recuperado; valor divergente sem baixa; assinatura inválida;
  suspensão obsoleta (antes de reservar, na revalidação e após pagamento); posse expirada → incerta → verificação; agente de outro provedor; divergência manual;
  importação (prévia não grava, reimportação não duplica, conta sem senha não provisiona); portal isolado na API e no banco; MFA;
  operador do SaaS (criar/suspender provedor, suporte auditado); cookie de sessão e CSRF; paginação; rotação da chave de segredos.
- `./nexo agent-test` — 31 testes no agente (10 da expansão OLT/ONU, incluindo o driver Huawei contra emulador; 2 do IP fixo; 4 de migração do banco local, rollback e disco cheio): confirmação perdida, reinício após aplicar, queda no meio, reentrega, envelope adulterado/vencido, NAS indisponível, hash NT, recusa de downgrade.
- Correções após revisão externa do commit `314e29d` (10/10/2026): (1) `begin()` passou a conferir a posse da reserva na própria transação, pelo relógio do banco;
  (2) a verificação final do agente usa o mesmo critério para suspender e para liberar/trocar plano, e sessão desconhecida (NAS sem resposta) deixou de valer como
  “sem sessão”. Cada uma tem regressão que falha no código anterior. Troca de plano repetida no laboratório com cliente online: concluída.
- **Laboratório PPPoE real** (`./nexo lab-up`): MikroTik CHR 7.24.5 em KVM, cliente `pppd`, FreeRADIUS 3.2.10 — autenticação CHAP, perfil/fila aplicados, suspensão e reativação,
  troca de plano, nuvem e agente parados, suspensão obsoleta, agente morto no meio da execução, posse expirada, NAS inacessível, alteração manual, API com TLS e perda do site;
  depois também MS-CHAPv2 com hash NT, 6 clientes simultâneos vindos de um lote importado, RADIUS local parado e atualização assinada do agente. Resultados em `docs/lab-pppoe.md`.
- `./nexo lab cgnat` — CGNAT determinístico no CHR 7.24.5: 517 regras geradas aceitas pela API do RouterOS; tráfego UDP/TCP dos 6 clientes PPPoE traduzido
  para o IP público e o bloco de portas calculados (3 execuções, 95 traduções, nenhuma divergente). Regras removidas ao final.
- IP fixo no laboratório: endereço alocado no IPAM chegou ao cliente PPPoE real pelo RADIUS local (agente 0.3.0); detalhes em `docs/lab-pppoe.md`.
- `./nexo lab-radius` — FreeRADIUS real: PAP/CHAP/MS-CHAP aceitos, `Mikrotik-Group` no Access-Accept, suspensão → Reject, reativação com troca de perfil, reinício.
- Ambiente rodando: provisionar/suspender/reativar por mTLS com o agente; confirmação perdida (uma única escrita); fila preservada no reinício do agente; divergência manual exibida.
- Interface em navegador headless: todas as telas, cinco papéis e portal sem erros de console.
- Backup → restauração (`restore-check` e `restore`) e rejeição de arquivo adulterado; pacote do agente assinado e rejeição de pacote/manifesto adulterados.
- **Instalação de produção local** (`infra/prod`, sem modo demonstração): subiu do zero com HTTPS; MFA obrigatório; sem contas/driver/gateway de demonstração; agente só entra com mTLS;
  certificado diferente do fixado é recusado; rotação de `NEXO_SECRET_KEY` com login MFA funcionando depois. Esse exercício revelou e corrigiu um erro ao criar provedor (agora com teste).
- Medição única com volume **sintético** (5.000 assinantes, esta máquina, sem rede real): importar 31 s; reimportar 13 s; gerar 5.000 mensalidades 15 s;
  enfileirar 5.000 provisionamentos 31 s; agente ≈ 32 ms por operação com driver simulado (≈ 3 min para 5.000; com equipamento real o tempo será o do equipamento);
  buscas e listas < 120 ms. Não é SLA nem capacidade garantida; o volume do piloto é desconhecido.

### Simulado x real

| Integração | Situação |
|---|---|
| Driver `demo` (NAS + RADIUS fictícios) | **Simulação**, rotulada "SIMULADO"; bloqueada fora do modo demonstração |
| Gateway `demo` (PIX/boleto fictícios, webhook assinado próprio) | **Simulação**; não movimenta dinheiro; bloqueado fora do modo demonstração |
| FreeRADIUS local | Real; validado com `radclient` e com sessão PPPoE real via CHR. Candidato experimental (ADR-005): outro motor não foi comparado |
| MikroTik RouterOS | **Real em laboratório virtual** (CHR 7.24.5, `api-ssl`). Equipamento físico do piloto não testado; interface mostra "validado em laboratório" |
| OLT (`olt_demo`) | **Simulação** de uma OLT GPON; rotulada "SIMULADO"; bloqueada fora do modo demonstração. Nenhuma OLT real integrada |
| OLT Huawei (`olt_huawei`) | Driver real por SSH, **nunca executado contra uma OLT Huawei**; testado contra emulador de CLI próprio. Interface mostra "não homologado em equipamento real" |
| MK-Auth | Não há integração: formato CSV intermediário próprio (`docs/importacao-csv.md`) |
| CGNAT | Script gerado para revisão; tradução comprovada só no CHR do laboratório. Nenhum roteador de provedor recebeu as regras |
| NOC / diagnóstico | Regras fixas sobre leituras reais do laboratório e sintéticas. Limiares vazios; heurística de falha coletiva nunca viu uma queda real |
| Fiscal | Não implementado. Existe apenas exportação contábil em CSV, que não é documento fiscal |
| IA assistiva | Não implementada |

### Limitações conhecidas (não escondidas pela interface)

- Suspensão só na modalidade "negar autenticação + derrubar sessão". Sem juros, multa, proporcionalidade, pagamento parcial automático ou estorno: vão para conciliação manual.
- Site do provedor: com CHAP a senha PPPoE fica em claro no RADIUS local; a alternativa `nt_hash` exige MS-CHAPv2 no NAS. Criptografia de disco fica a cargo do host.
- RADIUS local: segunda instância opcional no mesmo host (provada no laboratório); sem redundância entre hosts. Alerta por webhook testado contra um servidor HTTP local, não contra o serviço de chat do provedor.
- Trava das rotinas periódicas: testada com duas sessões concorrentes do banco (mesmo mecanismo); duas réplicas da API em hosts distintos não foram exercitadas.
- `infra/prod` não foi exercitado em host público com domínio real. O repositório não está sob controle de versão (git não inicializado).
- Laboratório: um NAS, até 6 clientes, sem medição de desempenho.

### Pendências externas e próxima ação

| Pendência | Bloqueia | Próxima ação concreta |
|---|---|---|
| Equipamento físico e versão do RouterOS do piloto | O piloto (não mais o desenvolvimento) | Repetir `docs/lab-pppoe.md` no equipamento real, com mais de um cliente |
| Acesso a uma OLT Huawei (modelo e firmware do provedor) | Homologar o driver `olt_huawei` | Seguir o roteiro de homologação em `docs/expansao-olt-onu.md` |
| Gateway de pagamento e credenciais de sandbox | Conclusão da E4 | Implementar um adaptador em `apps/api/src/finance/gateway.ts` (interface `Gateway`) e repetir os testes de webhook/conciliação |
| Política comercial (dias, modalidade de suspensão, juros/multa, parcial, estorno) | Ativar automações em produção | Provedor configura em "Política de cobrança"; regras novas exigem implementação |
| Amostra autorizada do MK-Auth (com versão) | Migração real | Mapear para o CSV intermediário ou escrever conversor; conferir a prévia |
| Provedor piloto, volume, RPO/RTO, processo fiscal, canal de alerta | E6 | Preencher a lista de entrada em produção em `docs/operacao.md` |
| Autorização explícita de produção | Virada | Importar base real → "Provisionar lote" → reapontar o RADIUS do NAS do grupo piloto |

**Prioridade atual (desde 10/10/2026): `docs/06-plano-entrada-producao-7-dias.md`** — fechar o núcleo para a primeira entrada em produção; o acompanhamento diário fica na seção 11 daquele documento.

**Para retomar:** `./nexo up && ./nexo test` (e `./nexo lab-up` para o laboratório PPPoE). Seguir `docs/05-prioridades-pos-projeto.md`: o primeiro item
de engenharia é o adaptador do gateway real, assim que o gateway for definido.
