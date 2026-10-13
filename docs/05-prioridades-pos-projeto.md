# NexoISP — Prioridades para depois do projeto

Criado em 10/10/2026. Lista única do que **foi pulado de propósito** para o desenvolvimento não parar.
Nada aqui está feito. A ordem é a recomendada; cada item diz quem destrava e qual é a primeira ação concreta.

O que já existe está em `docs/04-etapas-e-prompts-de-desenvolvimento.md` (seção 12) e em `docs/expansoes-2-a-5.md`.

## Como ler

| Marca | Significado |
|---|---|
| **Terceiro** | Depende de alguém de fora: provedor, gateway, fabricante, contador, advogado |
| **Decisão** | Depende só de uma escolha do dono do produto |
| **Nosso** | Trabalho de engenharia que pode começar a qualquer momento |

## P0 — Sem isto não existe piloto

São os seis itens que fecham o MVP. Sem eles o sistema continua sendo uma demonstração completa.

| # | Item | Tipo | Primeira ação | Onde mexe |
|---|---|---|---|---|
| 0.1 | Provedor piloto com autorização por escrito (quais assinantes, qual NAS, responsáveis) | Terceiro | Fechar o piloto e preencher a lista de `docs/operacao.md` §7 | — |
| 0.2 | Gateway de pagamento real com credenciais de sandbox | Terceiro | Escolher o gateway; depois escrever o adaptador e repetir os testes de webhook e conciliação | `apps/api/src/finance/gateway.ts` (interface `Gateway`) |
| 0.3 | Equipamento físico do piloto (MikroTik e versão do RouterOS). Em 10/10/2026 os 12 casos foram repetidos num CHR 7.17 do cenário do PNETLab: isso **não** fecha este item | Terceiro | Repetir os 12 casos de `docs/lab-pppoe.md` nele, com mais de um cliente | `infra/site/` |
| 0.4 | Exportação real do MK-Auth (com a versão) | Terceiro | Mapear para o CSV intermediário e conferir a prévia | `docs/importacao-csv.md` |
| 0.5 | Política comercial mínima: dias para suspender, reativação automática, modalidade de suspensão | Terceiro | Provedor configura em “Política de cobrança” | só configuração |
| 0.6 | Servidor público com domínio, backup automático e um `restore-check` feito nele | Nosso (precisa do host) | Subir `infra/prod` no host real | `infra/prod/` |

Duas decisões que travam o piloto sem serem trabalho:

| # | Item | Tipo | Por que trava |
|---|---|---|---|
| 0.7 | Processo fiscal do piloto | Decisão + Terceiro | Se o provedor não puder emitir nota por fora, a emissão vira requisito de entrada (ver 3.1) |
| 0.8 | Distribuição do FreeRADIUS (GPL-2.0) no pacote de site | Decisão + Terceiro | Precisa de validação antes de instalar o agente no site de um terceiro (ADR-005) |

## P1 — Homologar o que foi construído em simulação

Tudo abaixo está implementado e testado, mas **nunca encostou em equipamento ou serviço real**. Não vender como pronto.

| # | Item | Tipo | O que falta provar | Primeira ação |
|---|---|---|---|---|
| 1.1 | Driver OLT Huawei (`olt_huawei`) | Terceiro | Formato real das saídas por firmware, sintaxe aceita, login e paginação | Conseguir acesso a uma OLT e seguir o roteiro de `docs/expansao-olt-onu.md` |
| 1.2 | CGNAT no roteador do provedor | Terceiro | Só foi provado em CHR (7.24.5 no laboratório, com 6 clientes; e 7.17 no cenário do PNETLab, com 4 clientes e sobre um nó que já tinha NAT de provedor), sempre com regras aplicadas pela API. Falta: importar o `.rsc` pelo terminal, interface de saída real, volume real de regras e de tráfego, comportamento com jogos/VoIP | Rodar `./nexo lab cgnat` como referência e repetir no equipamento do provedor em janela de manutenção |
| 1.3 | NOC com dados reais | Terceiro | Os limiares (sinal mínimo, ONUs por PON) vêm vazios ou com padrão genérico; a heurística de falha coletiva nunca viu uma queda de fibra de verdade | Ajustar os limiares com o provedor após duas semanas de leituras |
| 1.4 | Webhooks no canal real do provedor | Nosso | Alertas de rede e avisos foram testados contra um servidor HTTP local, não contra o serviço de chat do provedor | Configurar o endereço em Administração → Avisos e usar “Enviar aviso de teste” |
| 1.5 | Capacidade | Terceiro | Só existe medição sintética (5.000 assinantes, uma máquina). Estoque, OS, CRM e NOC não foram medidos | Medir com o volume do piloto |
| 1.6 | Portal: chamados do assinante | Terceiro | Fluxo testado só com contas sintéticas; não há aviso ao provedor quando chega um chamado | Usar com o grupo piloto e decidir o canal de aviso (ver 2.5) |

## P2 — Trabalho nosso que ficou para depois

Não depende de ninguém. Foi adiado para não arriscar o que já estava validado ou por não ser necessário ao piloto.

| # | Item | Por que ficou | Tamanho |
|---|---|---|---|
| 2.1 | Enviar o repositório para um servidor remoto (GitHub, GitLab ou próprio) | O `git init` e o primeiro commit foram feitos em 10/10/2026, mas o histórico só existe nesta máquina | Minutos |
| 2.3 | Redundância do RADIUS **entre hosts** | Já existe uma segunda instância opcional no mesmo host (cobre queda do processo; provada no laboratório). Perda do host ou do disco continua derrubando a autenticação: exige replicar o banco local para outro servidor | Médio |
| 2.4 | ~~Juros, multa, proporcionalidade, pagamento parcial, estorno~~ **Feito em 13/10/2026** (baixa manual, acordo e primeiro mês proporcional; opt-in). Continua pendente: aplicar multa/juros em cobrança emitida pelo gateway, e estorno de baixa do gateway | Depende do gateway (0.2) | Médio |
| 2.5 | Mensagens **ao assinante** (e-mail, WhatsApp, SMS) para chamados, OS e cobrança | Os avisos **ao provedor** por webhook já existem. Falar com o assinante precisa de um serviço de envio (terceiro) e de modelos de mensagem aprovados | Médio |
| 2.7 | Criar perfis de linha, VLANs e `service-port` na OLT | Depende do fabricante e do desenho de rede; hoje são digitados | Médio, por fabricante |
| 2.10 | Uso em campo sem sinal | A tela “Meu trabalho” funciona no celular, mas precisa de conexão; trabalhar sem internet e sincronizar depois não existe | Médio |

Concluídos depois da primeira versão desta lista (10/10/2026): IP fixo aplicado no RADIUS (provado no laboratório), remoção da ONU ao encerrar contrato
(regra configurável, desligada por padrão), relatórios do CRM e teste da trava das rotinas periódicas com duas sessões concorrentes do banco
(duas réplicas em hosts distintos continuam sem exercício: ver 0.6).
Na rodada seguinte: segunda instância do RADIUS no mesmo host, migração do banco local do agente com cópia automática, rollback assistido
(`python -m nexo_agent.rollback`, testado em unidade; **não exercitado num site real**) e cenário de disco cheio (testado com o erro real do SQLite).

Na terceira rodada: estoque por número de série e por técnico, avisos ao provedor por webhook, tela de campo para celular, mapa esquemático da rede óptica
e registro de prefixos IPv6 por contrato. Ficaram de fora, de propósito: entrega do prefixo IPv6 pelo RADIUS (o laboratório não tem IPv6 para provar),
mapa com imagem de fundo e trajeto de cabos, e locais de estoque além de “almoxarifado” e “com o técnico”.

Design (10/10/2026): identidade visual, menu por área com busca, diálogos próprios, início com o que pede atenção, contrato em abas, portal refeito,
tema escuro. Ficou de fora: a marca do provedor no portal (logotipo e cor), teste com leitor de tela e teste de uso com atendentes e técnicos reais.

## P3 — Módulos que exigem decisão antes de qualquer código

| # | Item | Tipo | O que precisa ser decidido |
|---|---|---|---|
| 3.1 | Emissão fiscal (NFCom, NFS-e, SCM) | Decisão + Terceiro | Qual documento o provedor emite, por qual município/SEFAZ e por qual emissor. Hoje existe só a **exportação contábil em CSV**, que não é documento fiscal |
| 3.2 | Segundo fabricante de OLT (multivendor) | Decisão + Terceiro | Qual fabricante, modelo e firmware; e uma OLT para homologar. O contrato do driver está em `services/network-agent/nexo_agent/drivers/olt_base.py` |
| 3.3 | IA assistiva | Decisão + Terceiro | Chave de API de um provedor de modelo e decisão de LGPD sobre enviar dados de assinantes a terceiros. O diagnóstico entregue é por **regras fixas com evidência**; a IA entraria só para redigir a explicação, nunca para escrever na rede |
| 3.4 | Aplicar CGNAT pelo agente | Decisão | Hoje o sistema gera o script e uma pessoa aplica. Automatizar exigiria uma operação assinada nova e homologação por modelo de roteador. Recomendação: **não fazer** enquanto 1.2 não estiver provado |
| 3.5 | Segundo motor RADIUS (ToughRADIUS) | Decisão | Só reavaliar se 0.8 inviabilizar o FreeRADIUS |
| 3.6 | Segundo gateway de pagamento | Decisão | Só depois de 0.2 estar em produção |
| 3.7 | Aplicativo móvel e chat com o assinante | Decisão | Fora do escopo definido nos documentos 01 e 02 |

## Ordem sugerida

1. **2.1** (cópia remota do repositório) hoje.
2. **0.1** primeiro entre os itens de terceiros: o piloto define 0.3, 0.4, 0.5 e 0.7.
3. **0.2** em paralelo, porque é o caminho mais longo e o único requisito do MVP que só existe em simulação.
4. **0.6**, depois **0.3**, depois a virada do grupo piloto.
5. Com o piloto rodando: **1.3**, **1.4**, **1.5**, **1.6**, que só fazem sentido com dados reais.
6. **1.1** e **1.2** quando houver acesso aos equipamentos.
7. **P2** conforme a dor aparecer no piloto; **2.3** (redundância entre hosts) é o candidato natural.
8. **P3** só com a decisão tomada.

## Atualização de 13/10/2026

Implementado a partir do comparativo com o SGP (`docs/07-comparativo-sgp.md`): suspensão por perfil de bloqueio, vínculo de MAC, consumo mensal, liberação por confiança,
baixa parcial/desconto/estorno/multa e juros, acordo de pagamento, primeiro mês proporcional, dados da pessoa, etiquetas, aviso de manutenção no portal, checklist da OS e
comodato. Nada disso foi homologado em equipamento físico; a parte de rede foi repetida no CHR 7.17 do cenário do PNETLab (`docs/lab-pppoe.md`, seção 5).
Novas pendências: o perfil de bloqueio e o redirecionamento para a página de aviso precisam ser configurados no concentrador do provedor; o relato de consumo exige o
accounting ligado no NAS; a migração a partir do SGP depende de uma exportação real (ver 2.1 do comparativo).
