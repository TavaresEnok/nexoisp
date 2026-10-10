# Expansões 2 a 5 — IPAM/CGNAT, OS/estoque/FTTH, CRM e NOC

Construídas em 10/10/2026 por instrução do proprietário, de uma vez, pulando o que depende de terceiros
(documento 04, seção 10, previa uma por vez). O que foi pulado está em `docs/05-prioridades-pos-projeto.md`.

**Situação comum às quatro:** implementadas e **validadas localmente** com dados sintéticos. Nenhuma foi usada por um provedor.
Todas respeitam o que o MVP já garantia: isolamento por provedor no banco (RLS), permissão verificada no servidor, auditoria das escritas
e sessão do portal restrita ao próprio assinante.

| Expansão | Migration | API | Telas | Testes |
|---|---|---|---|---|
| 2 — IPAM e CGNAT | `010_ipam_cgnat.sql` | `routes/ipam.ts`, `network/cgnat.ts` | Rede → Endereços IP e CGNAT | `test/ipam.test.ts` (6) + `./nexo lab cgnat` |
| 3 — OS, estoque, FTTH | `011_os_estoque_ftth.sql` | `routes/field.ts` | Atendimento → Ordens de serviço, Estoque; Rede → Rede óptica | `test/campo.test.ts` (4) |
| 4 — CRM | `012_crm_atendimento.sql` | `routes/crm.ts`, exportação em `routes/finance.ts` | Atendimento → Atendimentos, Prospectos; portal; Faturas | `test/crm.test.ts` (3) |
| 5 — NOC | `013_noc.sql` | `routes/noc.ts` | Rede → NOC; “Diagnosticar acesso” no contrato | `test/noc.test.ts` (4) |

Permissões novas: `os:read/write`, `stock:read/write`, `crm:read/write`. Administrador tem todas; Atendimento opera OS e CRM e consulta estoque;
Técnico/NOC opera OS, estoque e CRM; Financeiro opera CRM. IPAM, FTTH e NOC usam as permissões de rede já existentes.

## 2 — IPAM e CGNAT

| Função | Como funciona |
|---|---|
| Blocos | IPv4 ou IPv6, com tipo (público, CGNAT, privado, gerência). Dois blocos do mesmo provedor não podem se sobrepor: a regra está no banco |
| Endereços | Reserva ou IP fixo de um contrato. Sem informar o endereço, o sistema escolhe o primeiro livre (IPv4 até /16, pulando rede e broadcast) |
| Plano de CGNAT | Determinístico: cada IP privado recebe um bloco fixo de portas em um IP público. A capacidade é validada antes de gravar |
| Script | RouterOS v7, **para revisão humana**. O download fica na auditoria |
| Rastreio | IP público + porta + data → IP privado, plano vigente na data e, se houver, o contrato com aquele IP fixo. A consulta fica na auditoria |

Decisões e limites:

- **O sistema não aplica CGNAT em equipamento.** Gera o script; a equipe de rede revisa e importa. O ERP continua sem encaminhar pacotes (documento 01).
- **O plano é imutável.** Para mudar, encerra-se e cria-se outro. Assim uma consulta sobre uma data passada responde pelo plano daquela data.
- **O IP fixo é entregue pelo RADIUS local** (`Framed-IP-Address`, agente 0.3.0+). Alocar ou liberar reenvia a intenção atual pela fila normal de operações, preservando a suspensão; a sessão em uso é derrubada para reconectar com o endereço novo. Um IPv4 fixo por contrato. Provado no laboratório com cliente PPPoE real (`docs/lab-pppoe.md`). O sistema não confere se o endereço está fora da faixa dinâmica do NAS: isso é responsabilidade de quem aloca.
- **Rastreio de IP dinâmico termina no IP privado.** Quem usava aquele IP privado na data está no accounting do RADIUS local (`radacct`), que fica no site do provedor e não é copiado para a nuvem. A tela diz isso e não inventa um titular.
- **IPv6:** um bloco IPv6 pode ter um tamanho de prefixo por assinante (ex.: /56); o sistema reserva o próximo prefixo livre para o contrato, sem sobreposição. É **registro e planejamento**: o prefixo não é entregue pelo RADIUS (o laboratório não tem IPv6 para provar a entrega).
- CGNAT e escolha automática de endereço valem para IPv4 em blocos de até /16.

**Laboratório (10/10/2026):** `./nexo lab cgnat` cria um plano sobre o pool PPPoE do laboratório (100.64.0.0/24 → 198.51.100.0/30, 960 portas),
aplica as 517 regras no MikroTik CHR 7.24.5 pela API, passa tráfego UDP e TCP dos 6 clientes PPPoE reais, lê as traduções na tabela de conexões
do roteador, compara com o cálculo do sistema e remove as regras. Três execuções seguidas: 95 traduções conferidas, nenhuma divergente; ICMP saiu
pelo IP público esperado. **Não provado:** importação do arquivo `.rsc` pelo terminal, interface de saída real, volume de produção.
Observação: numa tentativa manual, dois pacotes UDP enviados no mesmo segundo em que as regras foram inseridas saíram sem tradução
(o rastreamento de conexões do roteador tinha acabado de ser ativado); com 3 s de espera não se repetiu.

## 3 — Ordens de serviço, estoque e FTTH

| Função | Como funciona |
|---|---|
| Ordem de serviço | Numeração por provedor; tipo, responsável, agendamento; fluxo aberta → agendada → em execução → concluída/cancelada. Concluir exige descrever o que foi feito |
| Material | Lançado na OS, baixa o estoque na mesma transação. Devolução limitada ao que a própria OS consumiu |
| Estoque | O saldo é a soma dos movimentos. Movimento não é alterado nem apagado: corrige-se com ajuste justificado. O saldo nunca fica negativo, nem com duas saídas simultâneas |
| FTTH | Caixas (CTO/CEO) com N portas, caixa anterior, OLT e porta PON, endereço e coordenadas. Uma porta atende um contrato; um contrato usa uma porta |
| Meu trabalho | As OS do técnico em cartões grandes para o celular, com telefone e endereço clicáveis; o menu recolhe em telas pequenas |
| Mapa | Desenho esquemático das caixas pelas coordenadas, ligadas à caixa anterior, coloridas pela ocupação. Sem imagem de fundo: nenhum dado sai para serviços de mapas |
| Itens com número de série | Cada unidade (ONU, roteador) é rastreada: almoxarifado, com qual técnico, instalada em qual contrato por qual OS, com defeito ou baixada, com histórico. O saldo do item acompanha as unidades |

Limites: estoque só distingue almoxarifado e técnico (sem depósitos); o mapa não mostra ruas nem o trajeto dos cabos; a tela de campo precisa de conexão;
OS não dispara operação de rede (concluir uma instalação não provisiona nada sozinho).

## 4 — CRM

| Função | Como funciona |
|---|---|
| Prospectos | Funil novo → contatado → proposta → convertido/perdido, com histórico de contatos. Perda exige motivo |
| Conversão | Cria o assinante com os dados do prospecto. Se o CPF/CNPJ já existe, não duplica: o prospecto é vinculado ao assinante existente. Não cria contrato |
| Atendimentos | Protocolo numerado por provedor, categoria, prioridade, responsável, conversa. Responder deixa “aguardando o assinante”; a resposta dele devolve para a fila |
| Notas internas | Nunca chegam ao assinante: além do filtro na consulta, há política no banco para a sessão do portal |
| Portal | O assinante abre e acompanha os próprios chamados (limite de 5 em aberto) |
| OS a partir do atendimento | A ordem de serviço guarda o protocolo de origem |
| Exportação contábil | CSV de recebimentos (por data de pagamento) ou de faturas (por vencimento), no fuso do provedor, com proteção contra fórmulas de planilha |
| Relatórios | Por período: conversão de prospectos por origem; atendimentos por categoria com tempo médio até a primeira resposta e até encerrar; OS por tipo com tempo até concluir |
| Avisos ao provedor | Um webhook (canal de chat da equipe) recebe: chamado aberto ou respondido pelo portal, OS aberta ou atribuída. Fila durável com até 5 tentativas; fora do modo demonstração só aceita HTTPS e recusa endereços internos |

Limites: **não há emissão fiscal** (a exportação é planilha de conferência); nenhuma mensagem é enviada ao assinante (e-mail/WhatsApp/SMS); sem meta de prazo (SLA); sem chat.
“Multivendor” e “fiscal adicional”, que o roteiro agrupava nesta expansão, não foram feitos: dependem de escolha de fabricante e de processo fiscal.

## 5 — NOC e diagnóstico

Tudo nesta expansão é **leitura**. Nenhum alerta ou diagnóstico altera a rede.

| Função | Como funciona |
|---|---|
| Painel | Agentes offline, sessões PPPoE, ONUs sem sinal, OS e chamados técnicos em aberto, alertas por gravidade e situação de cada porta PON |
| Falha coletiva | ONUs sem sinal na mesma porta PON acima do mínimo configurado **e** pelo menos metade da porta. É heurística, e a tela diz que é |
| Sinal fraco | Só existe se o provedor definir o limite. Sem limite, o sistema mostra o valor e não o classifica |
| Diagnóstico do contrato | Regras fixas sobre as leituras já coletadas: contrato, intenção × observado, sessão, operação, ONU, vizinhas da PON, caixa, chamados. Cada conclusão traz a evidência e a data em que foi lida |
| Financeiro no diagnóstico | Faturas vencidas só aparecem para quem tem permissão de ver o financeiro |

Distinção que o diagnóstico faz: ONU offline com vizinhas normais → provável problema no endereço do assinante; ONU offline junto com
metade da porta → provável problema na rede óptica (não adianta visita individual).

Regra opcional do provedor (desligada por padrão): desautorizar a ONU na OLT quando o contrato é encerrado. Fica em NOC → “Limiares e regras”.

Limites: não testa a conexão em tempo real; não há histórico de alertas, reconhecimento nem plantão; os limiares saem vazios.
**IA assistiva não foi implementada**: exige chave de API de terceiro e decisão sobre enviar dados de assinantes para fora (prioridade 3.3).
O que existe é o diagnóstico por regras, que é a parte “com evidência” que o roteiro pedia.

## Demonstração

`admin@alfa.demo` já tem exemplos sintéticos: dois blocos IP (faixas de documentação), três itens de estoque, duas caixas e um prospecto.

- CGNAT: Rede → Endereços IP e CGNAT → “Novo plano de CGNAT” → “Conferir capacidade” → “Mapa” → “Rastrear conexão”.
- OS: Atendimento → Ordens de serviço → nova → iniciar → lançar material → concluir (o saldo cai em Estoque).
- Chamado: ficha do assinante → “Criar acesso ao portal” → entrar como o assinante → “Abrir chamado” → responder em Atendimentos.
- Diagnóstico: abrir um contrato → “Diagnosticar acesso”.

## Verificação (10/10/2026)

- `./nexo test`: 59 testes na API (32 anteriores + 27 destas expansões), todos com o papel real `nexo_app`. `./nexo agent-test`: 29 testes.
- Isolamento: outro provedor não lê nem altera blocos, planos de CGNAT, OS, estoque, caixas, prospectos, atendimentos nem diagnóstico; a sessão do portal,
  mesmo com SQL direto, vê só os próprios atendimentos, nunca notas internas, e nada de OS, prospectos ou endereços IP.
- Interface em navegador headless: todas as telas novas com quatro perfis e o portal, e os fluxos de CGNAT, estoque, OS, FTTH, prospecto, chamado e diagnóstico,
  sem erro de página ou de API (o único registro no console é o 401 esperado da checagem de sessão antes do login).
- `./nexo lab cgnat`: descrito acima.
- Não verificado: uso por um provedor, volume real, equipamento físico.
