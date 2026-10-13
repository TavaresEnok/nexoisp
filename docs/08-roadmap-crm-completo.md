# NexoISP — o que falta para ser um CRM/ERP completo como o SGP

> **Decisão de produto (13/10/2026): o NexoISP não é um sistema de chat.** Não há atendimento por conversa. O atendimento é feito por **ocorrência e ordem de serviço**
> (abertura, acompanhamento, SLA, agenda, execução). Mensagens ao assinante existem **só de saída** (cobrança, manutenção, OS): sem caixa de entrada, sem respostas.
> Onde este documento citar "chat", "URA" ou "WhatsApp" como origem de atendimento, leia como **integração externa que abre ocorrência por API**, nunca como canal nosso.

**Criado em:** 13 de outubro de 2026
**Fontes:** (1) espelho da interface administrativa de uma instância do SGP (`docs/sgp_mirror.zip`, 625 páginas salvas; **não versionado**, contém dados de clientes) e
(2) a documentação da API (`docs/API-SGP-completa.txt`, não versionada). Este documento só resume **estrutura** (menus, telas, campos, modelos). Nada de assinante,
endereço, equipamento ou credencial do espelho foi copiado para cá.
**Complementa:** `docs/07-comparativo-sgp.md` (comparativo pela API) e `docs/05-prioridades-pos-projeto.md`.

## 1. O que o espelho mostra, e o limite dessa leitura

| Medida | Valor |
|---|---|
| Páginas salvas | 625 (cerca de 380 entradas de menu; 290 páginas do administrador de modelos) |
| Aplicativos/modelos visíveis no administrador de modelos | 9 aplicativos, 104 modelos (administração geral 45, atendimento 12, estoque 18+1, rede 14, cobrança 4, autenticação 8, benefícios 1, pré-cadastro 1) |
| Telas do operador agrupadas no menu | Cadastros, CRM, Financeiro, Fiscal, Estoque, Relatórios, Frota, Rede, Planos, Integrações, Sistema, Ferramentas, Dashboards, Formulários |

**Limites.** Vi **o que existe e quais campos tem**, não **como se comporta**: nenhuma regra de cálculo, nenhum fluxo de aprovação, nenhum volume, nenhum desempenho.
É uma instância de um provedor, com os módulos que ele contratou (por isso há telas de frota, rede neutra e TV que podem não existir em outras). Os modelos de
financeiro, fiscal e contrato têm telas próprias e **não** aparecem na lista de modelos: o total real é maior que 104.

## 2. O que aprendi sobre a forma do produto

Em ordem de importância para quem quer chegar lá.

1. **O plano comanda a rede e a cobrança, não só o preço.** Um plano de internet no SGP carrega: velocidade com mínimo garantido, *burst*, prioridade, pools IPv4/IPv6/PD,
   franquia de tráfego mensal com ação ao exceder, "duplicação noturna", políticas de entrada/saída (inclusive as de velocidade reduzida), grupo de SLA, planos de conta,
   instalação parcelada, validade, disponibilidade no pré-cadastro público, impostos, e **três degraus de inadimplência por plano**: dias para avisar, dias para reduzir
   a velocidade e dias para bloquear. No NexoISP o plano tem preço, velocidade e nome do perfil no concentrador; a política de suspensão é única por provedor.
2. **A inadimplência é um funil de comunicação, não só um interruptor.** Há "lembrador", avisos por SMS/WhatsApp/e-mail com regra própria (dias relativos ao vencimento,
   dias da semana, horário limite, feriado, intervalo entre envios, filtros por POP, plano e etiqueta), carta de cobrança, consulta/negativação (SPC/Serasa) e páginas
   hospedadas mostradas ao assinante com conexão em atraso e com conexão bloqueada. O NexoISP suspende; não avisa o assinante.
3. **O atendimento é guiado por tipos.** O tipo de ocorrência define setor, SLA, se gera OS, se notifica o cliente, se aparece na central, se aceita sem contrato,
   classificações obrigatórias, modelos de comentário e até um modelo de IA. Há ainda causa-raiz, origem, método de atendimento, motivo de OS e checklist por setor/usuário.
4. **Contrato tem ciclo de vida rico**: sete situações com motivo cadastrado, fidelidade (carência, multa rescisória, renovação), aditivos, agendamento de troca de
   plano/status/isenção, desconto temporário, combos, benefícios, indicação, assinatura eletrônica de documentos e "não suspende".
5. **Muita integração, pouca profundidade própria.** Por contagem de opções: dezenas de provedores de SMS/WhatsApp (mais de 60), dezenas de integrações de TV e
   telefonia, vários gateways de pagamento e de conta digital, consulta de crédito, ERPs, sistemas de atendimento e rastreamento. O valor do SGP aqui é **catálogo de conectores**.
6. **Rede é multifabricante e multiacesso**: OLTs de pelo menos Huawei, ZTE, VSOL, Nokia, Intelbras e Parks (nas listas de seleção; Datacom e Fiberhome também aparecem no espelho, sem eu ter confirmado driver); templates de ONU com comandos
   próprios; gerenciador de CPE (ACS/TR-069); VPN; CGNAT; VLAN; console SSH e comandos MikroTik pelo painel; mapas (conectados, FTTH, calor de OS).
   Tipos de conexão: PPPoE, IPoE, DHCP, hotspot, estático e por switch.
7. **Fiscal e regulatório são parte do produto**: NF 21/22, NF 55/65, NFCom (modelo 62), NFS-e, CT-e, nota de débito, SPED, Sintegra, grupos fiscais, CFOP, IBS (reforma
   tributária) e relatórios ANATEL (DICI, SICI, PPP SCM, STFC, infraestrutura).
8. **Plataforma configurável pelo operador**: variáveis personalizadas com regex, formulários com perguntas e gatilhos, painéis e *widgets*, favoritos, tipos de
   documento e de anotação, setores e cargos, grupos de usuário, tokens e aplicativos para a API, aplicativos móveis, encurtador de links, 2FA e captcha.

## 3. Onde o NexoISP está, por domínio

Legenda: ✅ existe · 🟡 parcial · ❌ não existe · ⛔ fora da estratégia atual (ver seção 5). **Porte** é relativo (P pequeno, M médio, G grande), não prazo.

### 3.1 Núcleo comercial

| Domínio | SGP | NexoISP | Falta | Porte |
|---|---|---|---|---|
| Cliente PF/PJ/estrangeiro, contatos múltiplos, condomínio, "como conheceu" | completo | 🟡 | Vários telefones por tipo, estado civil, profissão, estrangeiro, condomínio, origem do cliente | P |
| Contrato: situações com motivo | 7 situações + motivo | 🟡 | Situação "novo", "inativo", "inviabilidade", "velocidade reduzida" e motivo cadastrado | P |
| Fidelidade, multa rescisória, aditivos | sim | ❌ | Modelo de fidelidade, multa na rescisão, aditivo de contrato | M |
| Agendamento de troca de plano/status/isenção | sim | ❌ | Mudança agendada com data de efeito | M |
| Descontos: temporário, por vencimento, combo, benefício, indicação | sim | ❌ | Regras de desconto na mensalidade | M |
| Vendedores e comissão | sim | ❌ | Cadastro, regra de comissão e relatório | M |
| Pré-cadastro público e viabilidade por endereço | sim | 🟡 | Hoje só prospecto interno; falta formulário público e consulta de viabilidade | M |
| Assinatura eletrônica de contrato | sim (gateways) | ❌ | Depende de provedor de assinatura | M |
| Plano com política de rede completa (burst, pools, franquia, redução) | sim | 🟡 | Campos do plano e tradução para perfil PPP/atributos RADIUS | G |

### 3.2 Cobrança e financeiro

| Domínio | SGP | NexoISP | Falta | Porte |
|---|---|---|---|---|
| Mensalidade, avulso, parcial, estorno, acordo, promessa | sim | ✅ (13/10) | Entrada separada no acordo; cancelar cobrança no gateway | P |
| Três degraus por plano (aviso, reduzir, bloquear) | sim | 🟡 | Hoje: um limite único por provedor, e suspensão por perfil. Falta o degrau de velocidade reduzida e a configuração por plano | M |
| Comunicação de cobrança (SMS, WhatsApp, e-mail, carta) com agenda e filtros | sim | ❌ | Motor de avisos ao assinante, modelos, janelas, intervalo, histórico, consentimento | G |
| Página de aviso/bloqueio hospedada | sim | ❌ | Servir a página para o IP de bloqueio; redirecionamento é do concentrador | M |
| Gateways de pagamento, PIX, cartão, recorrência, conta digital | vários | ❌ (só simulado) | **Pelo menos um gateway real** (bloqueio do piloto, item 0.2) | G |
| Boleto próprio: remessa/retorno CNAB, carnê, protocolos | sim | ❌ | Só se o provedor emitir boleto próprio | G |
| Caixa, repasse, OFX, contas a pagar/receber, plano de contas, DRE | sim | ❌ (só exportação CSV) | Back-office completo | G |
| Relatórios financeiros (aging, liquidez, inadimplência, comparativos) | ~30 relatórios | 🟡 | Resumo e recebido por mês; faltam aging, inadimplência por faixa, recebimento por plano | M |

### 3.3 Fiscal e regulatório

| Domínio | SGP | NexoISP | Falta | Porte |
|---|---|---|---|---|
| NFCom, NFS-e, NF 21/22, NF-e, CT-e, nota de débito, SPED, Sintegra | sim | ❌ | Escolha do documento do piloto e do emissor; é decisão do provedor | G |
| Relatórios ANATEL (DICI, SICI etc.) | sim | ❌ | Extração a partir de contrato, plano, endereço e tecnologia | M |
| Grupos fiscais, CFOP, impostos por plano | sim | ❌ | Depende do item acima | G |

### 3.4 Atendimento e campo

| Domínio | SGP | NexoISP | Falta | Porte |
|---|---|---|---|---|
| Ocorrência com tipo, setor, SLA, classificação, causa-raiz, origem, método | sim | 🟡 | Catálogos, SLA (prazo e escalonamento), classificações obrigatórias | M |
| OS com agenda, check-in, motivos, técnicos auxiliares, pontuação, mapa | sim | 🟡 | Agenda visual, check-in, motivos/cores, auxiliares, pontuação, mapa | M |
| OS com fotos, assinatura e checklist | sim | 🟡 | Checklist feito; fotos (armazenamento + LGPD) e assinatura | M |
| Notificar cliente ("a caminho", encerramento) | sim | ❌ | Depende do motor de avisos | P (após 3.2) |
| Central do assinante: contratos, 2ª via, PIX, chamado, uso, promessa | sim | ✅ (parte) | Cartão, termo de aceite, aplicativo móvel | M |
| Aplicativo móvel do técnico e do assinante | sim | 🟡 | A tela de campo é web em celular; sem aplicativo nem uso offline | G |
| Estoque: compra, NFe de compra, comodato, venda, kit, NCM, transferência, veículo | sim | 🟡 | Fornecedor, compra, kit, NCM/fiscal, entrada por NFe | M |

### 3.5 Rede

| Domínio | SGP | NexoISP | Falta | Porte |
|---|---|---|---|---|
| PPPoE com RADIUS | sim | ✅ | Homologação em equipamento físico | — |
| IPoE, DHCP, hotspot, estático, por switch | sim | ❌ | Outros métodos de autorização; só se o piloto os usar | G |
| OLT multifabricante | 6+ | 🟡 (Huawei, não homologado) | Um driver por fabricante e uma OLT de verdade para homologar | G cada |
| Templates de ONU, perfis de banda, modo (bridge/PPPoE/DHCP) | sim | 🟡 | Perfil e VLAN digitados; sem template nem modo | M |
| CPE/ACS (TR-069): Wi-Fi, WAN, reboot, ping | sim | ❌ | Servidor de gerência de CPE e modelos | G |
| CGNAT | sim | 🟡 | Gera e confere; não aplica (decisão consciente) | — |
| Mapas (conectados, FTTH, calor de OS, técnicos) | sim | 🟡 | Mapa esquemático FTTH; falta mapa geográfico | M |
| Monitoramento (gateways de monitor, sinal de ONU) | sim | 🟡 | NOC por regras e sinal; sem integração com monitor externo | M |
| Torre, poste, AP, fonte, switch como inventário | sim | ❌ | Cadastro de ativos de rede | M |

### 3.6 Plataforma

| Domínio | SGP | NexoISP | Falta | Porte |
|---|---|---|---|---|
| Usuários, grupos, cargos, setores | sim | 🟡 | Seis papéis fixos; sem grupos/setores configuráveis | M |
| Campos personalizados (variáveis) | sim | ❌ | Campos definidos pelo provedor em cliente/contrato | M |
| Formulários com gatilhos | sim | ❌ | Questionários vinculados a eventos | G |
| Painéis e widgets configuráveis | sim | 🟡 | Painéis fixos | M |
| API pública com tokens | sim | ❌ | API interna por sessão; falta a de integração | M |
| Alteração em lote, envio em lote | sim | 🟡 | Provisionamento em lote existe; faltam suspensão, troca de plano e envio em lote | P |
| Auditoria, 2FA | sim | ✅ | — | — |
| Backup, restauração | sim | ✅ | Restauração exercitada só no ambiente de homologação local | — |
| Multi-empresa por instalação | sim | ✅ | O NexoISP é multi-provedor por desenho | — |

### 3.7 Fora do escopo de provedor de internet "puro" (visto no menu)

Frota (veículos, condutores, rastreamento, despesas), rede neutra, TV/multimídia/telefonia com dezenas de integrações de SVA, clube de benefícios e centrais de
ligação. Ver a seção 5.

## 4. Roteiro sugerido

A regra do plano de sete dias continua valendo: **nada abaixo antecede o piloto**. Ordem por dependência e valor, não por prazo.

### Onda 0 — o que trava o primeiro provedor (já listado em `docs/05`)

Gateway real, homologação em equipamento físico, exportação do SGP/MK-Auth, servidor de produção, política de cobrança e processo fiscal definido.

### Onda 1 — cobrança e comunicação (o maior ganho operacional)

1. **Motor de avisos ao assinante** (SMS/WhatsApp/e-mail) com modelos, janelas, intervalo, histórico e consentimento. Habilita avisos de cobrança, "a caminho" da OS,
   manutenção e portal. É o item de que mais coisas dependem. Precisa escolher **um** provedor de envio (os mais de 60 do SGP vêm depois, como conectores).
2. **Degraus de inadimplência por plano** (aviso, velocidade reduzida, bloqueio) e a página de aviso servida ao IP de bloqueio.
3. **Relatórios de cobrança**: aging, inadimplência por faixa, recebimento por plano e por forma.
4. **Campos faltantes de cliente e contrato**, situações de contrato com motivo, fidelidade e multa rescisória.

### Onda 2 — atendimento e campo

5. Catálogos de ocorrência (tipo, setor, classificação, causa-raiz, origem) e **SLA** com prazo e escalonamento.
6. Agenda de OS, check-in, motivos com cores, técnicos auxiliares e fotos (com decisão de LGPD e de armazenamento).
7. Compras e fornecedores no estoque; kit de instalação.
8. Aplicativo do técnico com uso sem sinal (item 2.10 de `docs/05`).

### Onda 3 — comercial

9. Vendedores e comissão; indicação; desconto temporário e combos.
10. Pré-cadastro público e consulta de viabilidade por endereço.
11. Aditivos e mudanças agendadas de plano/status.

### Onda 4 — rede e plataforma (dependem de equipamento ou de decisão)

12. Segundo e terceiro fabricantes de OLT, um por vez, **cada um com uma OLT para homologar**.
13. CPE/ACS (TR-069), se o provedor do piloto o usar.
14. Campos personalizados, grupos/setores configuráveis, painéis configuráveis, API pública com tokens.
15. Relatórios ANATEL, depois do documento fiscal definido.

## 5. O que recomendo **não** perseguir

| Item | Por quê |
|---|---|
| Frota, rastreamento, despesas de veículo | Não é CRM de provedor; há sistemas melhores e o ganho é baixo |
| Rede neutra | Só faz sentido para um modelo de negócio específico |
| Dezenas de integrações de TV, telefonia e multimídia | Cada uma é um contrato com terceiro; entram por demanda de um provedor concreto |
| Paridade de catálogo de gateways de SMS/WhatsApp | Um bom conector + um conector HTTP genérico cobre a maioria; o resto é por demanda |
| Emitir todos os documentos fiscais | Só o que o provedor do piloto usa; o resto é custo de manutenção permanente (a legislação muda) |
| Back-office completo (caixa, DRE, contas a pagar) | É outro produto; integrar com o sistema contábil do provedor custa menos |
| Console SSH/comandos livres no painel | Contraria a garantia central do NexoISP (catálogo fechado de operações assinadas) |

Este último é uma **diferença de projeto**, não uma lacuna: o SGP oferece comandos MikroTik e console SSH pelo painel; o NexoISP só executa operações do catálogo,
assinadas, versionadas e verificadas. Vale manter.

## 6. Resumo em uma página

- **Já temos, no nível de simulação/cenário virtual:** acesso PPPoE e suspensão com garantias fortes, cobrança básica e avançada, portal, OS, estoque por série,
  rede óptica esquemática, NOC por regras, IPAM/CGNAT, CRM simples, auditoria e módulos por provedor.
- **O que mais pesa para "parecer SGP" para o operador:** comunicação de cobrança, degraus por plano, SLA e catálogos de atendimento, agenda de OS, relatórios.
- **O que mais pesa para "ser SGP" para o negócio:** gateway real, fiscal, homologação em equipamento, e a migração dos dados do provedor.
- **O que não precisa existir:** frota, rede neutra, catálogo de TV/telefonia, console livre.
- **Ordem recomendada depois do piloto:** avisos ao assinante → degraus por plano e página de aviso → relatórios de cobrança → catálogos e SLA → agenda e fotos da OS →
  comercial (vendedor, indicação, viabilidade) → novos fabricantes de OLT.
