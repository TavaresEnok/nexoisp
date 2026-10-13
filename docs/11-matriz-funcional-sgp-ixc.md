# Matriz funcional SGP × IXC × NexoISP

**Criado em:** 13 de outubro de 2026
**Fontes:** (1) 71 capturas de tela (44 do SGP, 27 do IXC) de instâncias de provedores; (2) o espelho da interface do SGP (`docs/sgp_mirror.zip`); (3) a documentação da API do SGP;
(4) o menu e as seções da wiki da API do IXC. Nada disso está no repositório, exceto este resumo.
**O que este documento contém:** estrutura, nomes de função e organização de tela. **Não contém** nenhum dado de cliente, endereço, login, IP, equipamento ou credencial
que apareça nas capturas.
**Complementa:** `docs/07` e `docs/08` (SGP pela API e pelo espelho). Aqui entra o IXC e o que as capturas mostram do **uso real**.

## 1. Limites desta leitura

- **Capturas mostram o que o operador vê, não o que o sistema faz.** Nenhuma regra de cálculo, nenhum fluxo de aprovação.
- **Do IXC só há 27 telas e o menu da wiki.** As páginas da wiki carregam por JavaScript e a leitura automática só trouxe o menu; **as páginas "Recursos da API" e
  "Gerar token de acesso" não foram lidas**. Qualquer afirmação sobre a API do IXC abaixo vem só do menu e dos títulos de seção.
- **Instâncias reais de provedores.** Algumas telas existem por módulo contratado (telefonia móvel, frota, folha de pagamento).
- Em "NexoISP hoje" está o que foi **implementado**, no nível de maturidade de `docs/05` (nada homologado em equipamento físico).

## 2. Como cada produto se organiza

| | SGP | IXC | NexoISP |
|---|---|---|---|
| Navegação | Menu superior por área (Clientes, Financeiro, Fiscal, Estoque, Relatórios, Administração, Sistema), busca de cliente sempre visível | Menu lateral com ~20 módulos (Cadastros, Planejamento, Entradas, Saídas, Pagar, Receber, Financeiro, Fiscal, Contabilidade, Folha, Estoque, Provedor, Suporte, CRM, Frota, VoIP, MVNO…) e busca global | Menu por área com busca; ficha do contrato em abas |
| Tela central | **Ficha do cliente** com 13 abas | **Cadastro em janelas** (cada função abre uma janela com abas) | Ficha do contrato (Acesso, Contrato, OS, Histórico) |
| Painel inicial | Dashboard de widgets fixos: radius, atendimento, caixa, últimas operações | Dashboards configuráveis (seletor), gráficos de contratos, prospects, backup, certificado A1 | Início com o que pede atenção |
| Escopo | ERP + CRM + fiscal + rede + frota + telefonia | ERP completo + contabilidade + folha + VoIP + MVNO + hub de integrações | Núcleo de provedor (cadastro, cobrança, rede, campo, CRM simples) |

## 3. Matriz por domínio

Legenda: ✅ existe · 🟡 parcial · ❌ não existe. **"Ganho possível"** é onde dá para fazer melhor, não só igual.

### 3.1 Cliente e contrato

| Função | SGP | IXC | NexoISP hoje | Ganho possível |
|---|---|---|---|---|
| Cadastro PF/PJ/estrangeiro, nome social, RG com emissor e data, inscrição estadual, contribuinte ICMS, código IBGE, lat/long, busca de CEP | ✅ | ✅ | 🟡 | Preencher endereço por CEP e IBGE automaticamente; validar documento ao digitar |
| Resumo no topo: contratos por situação e serviços online/offline | ✅ (sempre visível) | ✅ | 🟡 | Mostrar também inadimplência e a próxima ação (já existe no acesso) |
| Abas do cliente: contratos, financeiro, comodato/venda, ocorrências, extrato de tráfego, documentos, aditivos, anotações, variáveis, benefícios, assinaturas, histórico | 13 abas | janelas | 🟡 (5 áreas) | Linha do tempo única do cliente (tudo em ordem), em vez de abas separadas |
| Contatos múltiplos por tipo (celular cobrança, WhatsApp, responsável) | ✅ | ✅ | ❌ | Canal preferido por assunto (cobrança, técnico) |
| Blacklist de cliente e de endereço | ✅ | 🟡 | ❌ | Alerta no cadastro e na venda |
| Migrar para rede neutra, alterar PF/PJ | ✅ | 🟡 | ❌ | Só se o modelo de negócio exigir |
| Contratos unificados, vários serviços por contrato | ✅ | ✅ | ❌ | Modelar serviço como item do contrato desde o início |
| Busca que acha por login, IP, MAC, serial de ONU, telefone, nº de OS, nº de título | ✅ (23 tipos) | ✅ (cartões com status de conexão) | 🟡 (nome, documento) | **Busca única** com resultado já mostrando situação de rede e financeira |

### 3.2 Plano e serviço de internet

| Função | SGP | IXC | NexoISP hoje | Ganho possível |
|---|---|---|---|---|
| Velocidade, mínimo garantido, prioridade (1–8), *burst* | ✅ | ✅ (abas padrão, reduzido, turbinado) | 🟡 (velocidade + nome do perfil) | Validar contra o que o concentrador aceita antes de salvar |
| **Três degraus por plano**: avisar, reduzir velocidade, bloquear | ✅ | ✅ ("redução de velocidade") | 🟡 (bloqueio por perfil, política única) | Simulador: "se vencer hoje, o que acontece com este cliente e quando" |
| Velocidade reduzida por inadimplência **e** por franquia | ✅ | ✅ | ❌ | Mostrar ao assinante o motivo e o que fazer |
| Franquia mensal, ação ao exceder, duplicação noturna | ✅ | 🟡 | ❌ | Consumo em tempo real no portal |
| Pools IPv4/IPv6/PD por plano, políticas de entrada e saída, filter-id | ✅ | ✅ (perfis para roteadores e OLTs) | ❌ | Perfil de rede reutilizável, versionado |
| Sincronizar IP × MAC | 🟡 | ✅ | ✅ (vínculo de MAC) | — |
| Agendamento de mudança de plano em lote | ✅ | 🟡 | ❌ | Prévia do efeito financeiro antes de agendar |
| Combos, desconto temporário, fidelidade com multa | ✅ | ✅ | ❌ | Calculadora de multa mostrada ao atendente no cancelamento |

### 3.3 Operação de rede no dia a dia (o que o atendente faz na ficha)

| Função | SGP | IXC | NexoISP hoje | Ganho possível |
|---|---|---|---|---|
| Status da conexão: tempo, porta, IP, IPv6 PD, MAC, NAS, service name | ✅ | ✅ | ✅ | Explicar o estado em linguagem simples |
| Desconectar, encerrar sessão, ping com tamanho/contagem, log do Radius | ✅ | ✅ | 🟡 (suspender/reativar, sessão) | Ferramentas de diagnóstico **assinadas e auditadas** (ping, log) |
| Limpar MAC e **desbloqueio temporário** na própria ficha | 🟡 | ✅ | ✅ (MAC, liberação por confiança) | — |
| Histórico de sessões: início, fim, IP, MAC, **motivo de encerramento**, upload/download | ✅ (89 sessões no exemplo) | ✅ | ❌ | Linha do tempo de conexão com causa provável (queda de luz, perda de portadora) |
| IP público do CGNAT e faixa de portas por sessão | ✅ | 🟡 | 🟡 (plano e consulta) | Consultar por IP público, porta e hora (exigência de investigação) |
| Gráficos de tempo online/offline dos últimos 7 dias | 🟡 | ✅ | ❌ | Mostrar disponibilidade por cliente e por POP |
| Dados FTTH do cliente: projeto, caixa, porta, transmissor, PON, VLAN, ONU | ✅ | ✅ | ✅ (caixa/porta, ONU) | — |
| Usuários online com exportação para Excel e desconexão em lote | ✅ | ✅ | 🟡 | Exportação CSV; desconexão em lote com confirmação e auditoria |

### 3.4 Financeiro e cobrança

| Função | SGP | IXC | NexoISP hoje | Ganho possível |
|---|---|---|---|---|
| Títulos: gerar em lote, baixar, estornar, cancelar, acordo, promessa | ✅ | ✅ | ✅ (13/10) | — |
| Histórico de caixa em tempo real (ponto de recebimento, modo, plano de contas) | ✅ (widget) | ✅ | 🟡 (recebido por mês) | Conciliação visual: o que entrou hoje e o que falta casar |
| Plano de contas, centro de custo, caixa, repasse, contas a pagar e a receber, OFX | ✅ | ✅ (Pagar, Receber, Contabilidade, Folha) | ❌ | Integrar com o contábil do provedor em vez de refazer |
| Boleto, carnê, CNAB, PIX, cartão, débito automático, recorrência | ✅ | ✅ | ❌ (gateway simulado) | **Gateway real** com PIX primeiro |
| Cobrança: lembrador, SMS/WhatsApp/e-mail com agenda, carta, negativação | ✅ | ✅ | ❌ | Régua visível ao assinante e ao atendente |
| Pesquisa de satisfação enviada após o atendimento | 🟡 | ✅ (enviado, respondida, expirada) | ❌ | NPS ligado à OS e ao técnico |

### 3.5 Atendimento, OS e campo

| Função | SGP | IXC | NexoISP hoje | Ganho possível |
|---|---|---|---|---|
| Ocorrência com tipo, classificação, setor, SLA, origem (URA, chat) | ✅ | ✅ ("assunto", filial, setor) | 🟡 | Tipos guiados por regras (gera OS? notifica? exige foto?) |
| Ocorrência gerando OS vinculada, com número, impressão, agenda | ✅ | ✅ | 🟡 | OS com checklist, materiais e pagamento de comissão |
| **Fluxo de status da OS**: aberta, análise, encaminhada, assumida, agendada, **deslocamento**, execução, finalizada, aguardando agendamento | 🟡 | ✅ | 🟡 (menos estados) | Estado "deslocamento" alimenta o aviso "a caminho" |
| Prioridade, melhor horário (manhã/tarde/noite), setor, colaborador, "gera comissão" | 🟡 | ✅ | 🟡 | Capacidade por técnico e por região, não só horário |
| Mapas: OS por localização, calor, técnicos em tempo real | ✅ | ✅ (Inmap) | ❌ | Roteirização simples por proximidade |
| Origem do endereço da OS: cliente, login, contrato, manual | ❌ | ✅ | ❌ | Endereço de instalação como dado do **serviço**, não só do cliente |
| Integração com chat (abertura por URA/WhatsApp com protocolo) | ✅ | ✅ | ❌ | API de integração com token e escopo |
| Acesso por POP (usuário só vê os POPs dele) | ✅ | 🟡 | ❌ | Permissão por POP, setor e carteira |

### 3.6 Dashboards

| Widget | SGP | IXC | NexoISP hoje |
|---|---|---|---|
| Online agora e tráfego do dia | ✅ | 🟡 | 🟡 |
| Ocorrências abertas por tipo, com encerradas hoje, em execução e pendentes | ✅ | ✅ (por status) | 🟡 |
| Conexões offline por faixa de tempo (≥2 h … ≥30 dias) | ✅ | 🟡 | 🟡 (NOC) |
| Resumo do **sinal das ONUs** por faixa de RX | ✅ | 🟡 | 🟡 (por ONU) |
| Clientes **sem fatura** gerada | ✅ | 🟡 | ❌ |
| Últimas operações (feed com origem: URA, webhook, usuário) | ✅ | ❌ | ✅ (auditoria) |
| Evolução mensal de contratos: ativações, churn, crescimento | 🟡 | ✅ (365 dias) | ❌ |
| Funil de prospects | ❌ | ✅ | 🟡 |
| Status do backup e validade do certificado A1 | ❌ | ✅ | 🟡 (backup) |
| A receber e a pagar do mês | 🟡 | ✅ | 🟡 |
| Hosts monitorados | ❌ | ✅ | ❌ |

### 3.7 Rede (cadastros)

| Função | SGP | IXC | NexoISP hoje | Ganho possível |
|---|---|---|---|---|
| Concentradores/NAS, VLAN, VPN, CGNAT, pools | ✅ | ✅ | ✅/🟡 | Validar a configuração real antes de aceitar |
| OLTs multifabricante, PON, CTO/splitter, templates e tipos de ONU (31 tipos no exemplo) | ✅ | ✅ (autorização automática) | 🟡 (Huawei) | Catálogo de ONU compartilhado entre provedores |
| Autorização automática de ONU | 🟡 | ✅ | ❌ | Regra por serial/modelo, com aprovação para o desconhecido |
| ACS/TR-069, SpeedTest, monitoramento de ping | ✅ | ✅ | ❌ | Só com modelos reais para homologar |
| Torre, poste, AP, fonte, switch; KML | ✅ | ✅ | ❌ | Inventário simples com mapa |
| POP com contagem de contratos por situação | ✅ | 🟡 | ❌ | POP como eixo de permissão e de relatório |

### 3.8 Módulos que só um dos dois tem

| Módulo | SGP | IXC | Recomendação |
|---|---|---|---|
| Folha de pagamento, contabilidade, planejamento | ❌ | ✅ | **Não construir**: integrar com o contábil do provedor |
| VoIP (plataforma) e MVNO (telefonia móvel) | integra | ✅ (próprio) | Fora do núcleo; por demanda |
| Frota | ✅ | ✅ | Fora do núcleo |
| Hotsite / hub de integrações | ❌ | ✅ | O hub é o que mais interessa: **API pública com token e webhooks** |
| Assinatura eletrônica de contrato | ✅ | ✅ (IXC Assina) | Conector externo |
| ERP de terceiros / sistema de atendimento / IA | ✅ (gateways) | ✅ | Conector HTTP genérico |

## 4. O que as capturas mostraram e os documentos anteriores não tinham

1. **O cliente é o centro da tela.** Tudo (rede, financeiro, OS, anotações) cabe na ficha do cliente; o operador raramente sai dela. A ficha do NexoISP é do **contrato**.
2. **Busca com contexto.** O IXC mostra o resultado da busca já com login, IP, MAC e plano; o SGP tem 23 critérios de busca. A busca é a porta de entrada do atendimento.
3. **Anotações são o canal informal de operação.** Muitas informações críticas (promessa, combinação, senha do Wi-Fi) ficam em anotações de texto livre. Um sistema melhor
   transforma isso em campos estruturados (promessa, instalação combinada, equipamento) e ainda aceita texto.
4. **Ocorrência e OS andam juntas e vêm de fora.** Grande parte nasce de URA/chat, com protocolo do chat. A integração de atendimento é parte do fluxo, não um extra.
5. **"Desbloqueio temporário" e "limpar MAC" estão na ficha.** São as ações mais pedidas ao suporte; já temos as duas, mas sem o mesmo destaque na tela.
6. **Motivo de encerramento da sessão** (User-Request, Lost-Carrier, Admin-Reset, Port-Error) é a principal evidência de diagnóstico no atendimento. Já guardamos o accounting
   no RADIUS local; falta mostrá-lo.
7. **Circuit-id** (opção 82) aparece no IXC como dado do login: identifica o ponto físico do cliente.
8. **Acesso por POP** é uma permissão de primeira classe no SGP: cada usuário enxerga só os POPs dele.
9. **Sinal das ONUs agregado por faixa** é tão visto quanto o sinal individual: serve para achar problema de rede antes do cliente reclamar.

## 5. O que priorizar a partir daqui (atualiza `docs/08`)

| # | Item | Por quê | Porte |
|---|---|---|---|
| 1 | **Busca única com contexto** (login, IP, MAC, serial, telefone, nº de OS) | Porta de entrada do atendimento nos dois concorrentes | M |
| 2 | **Linha do tempo do cliente** (ocorrências, anotações, financeiro, sessões, OS) | Substitui 13 abas; é onde dá para ser melhor | M |
| 3 | **Histórico de sessões com motivo de encerramento** | Dado que já temos no RADIUS local; maior valor de diagnóstico | P |
| 4 | **Motor de avisos ao assinante** e régua de cobrança | Sem isso a inadimplência é só um interruptor | G |
| 5 | **Degraus por plano** (avisar, reduzir, bloquear) | Comportamento esperado por quem migra | M |
| 6 | **Dashboards**: conexões offline por faixa, sinal de ONU por faixa, clientes sem fatura, contratos por mês | Visto nos dois | M |
| 7 | **API pública com token e webhooks** | O "hub" do IXC e o que mantém as automações do provedor | M |
| 8 | **Permissão por POP/setor** | Provedores com várias equipes | M |
| 9 | **Fluxo de status da OS com deslocamento** + pesquisa de satisfação | Visto no IXC; liga OS, aviso e NPS | M |
| 10 | Gateway real (PIX), fiscal, mais fabricantes de OLT | Já listados; dependem de terceiro | G |

## 6. O que falta receber do IXC

| Material | Para quê |
|---|---|
| Texto das páginas **"Recursos da API"** e **"Gerar token de acesso"** da wiki (a leitura automática não alcança; copiar o texto ou salvar a página) | Saber os recursos, a autenticação e a paginação |
| Telas de **financeiro, fiscal e contratos** do IXC (não vieram nas 27 capturas) | Os módulos mais densos |
| Telas de **plano**, **OS**, **estoque** e **relatórios** | Completar a matriz |
| **Como o IXC exporta ou faz backup** (formato, e se é aberto) | A migração por arquivo de backup, que é o objetivo |
| Exemplo de **exportação de clientes/contratos/títulos** em CSV pela tela, com dados fictícios ou anonimizados | Mapeamento direto, sem API |
