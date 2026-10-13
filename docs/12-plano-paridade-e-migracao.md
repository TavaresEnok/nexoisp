# NexoISP — o que já dá para fazer e o que falta para atender quem sai do SGP e do IXC

> **Decisão de produto (13/10/2026): o NexoISP não é um sistema de chat.** Não há atendimento por conversa. O atendimento é feito por **ocorrência e ordem de serviço**
> (abertura, acompanhamento, SLA, agenda, execução). Mensagens ao assinante existem **só de saída** (cobrança, manutenção, OS): sem caixa de entrada, sem respostas.
> Onde este documento citar "chat", "URA" ou "WhatsApp" como origem de atendimento, leia como **integração externa que abre ocorrência por API**, nunca como canal nosso.

**Criado em:** 13 de outubro de 2026
**Base:** todo o material enviado: API e espelho da interface do SGP, 71 capturas de tela (44 SGP, 27 IXC; vi 24 delas, as demais por nome e menu), menu e seções da wiki
da API do IXC, e o backup cifrado do SGP (**não foi aberto**). Sem dados de cliente neste documento.
**Complementa:** `docs/07`, `docs/08`, `docs/10`, `docs/11`.
**Leia assim:** a seção 2 é o que **dá para começar agora, sem depender de ninguém**; a seção 3 é a **lista de paridade para migração**, item a item; a seção 4 é o que
**está bloqueado** e por quê; a seção 5 é a ordem.

## 1. O que o NexoISP tem hoje

Nível de maturidade: **implementado e testado**; o que toca rede foi **validado no cenário virtual** do PNETLab (CHR 7.17). **Nada foi homologado em equipamento físico** e
**nenhum provedor opera nele**.

| Área | Temos |
|---|---|
| Plataforma | Vários provedores isolados no banco, 6 papéis, MFA, auditoria, módulos liberados por provedor, backup e restauração verificados |
| Cadastro | Assinantes (dados da pessoa), planos versionados, contratos com histórico, etiquetas, importação por CSV com prévia e reimportação sem duplicar |
| Acesso PPPoE | RADIUS local (FreeRADIUS) + agente; provisionar, suspender (por rejeição **ou por perfil de bloqueio**), reativar, trocar plano, IP fixo, **vínculo de MAC**, troca de senha; operação assinada, versionada e verificada; divergência detectada; incerteza tratada |
| Financeiro | Mensalidade (com primeiro mês proporcional), avulso, baixa manual (parcial, desconto, multa e juros), estorno, **acordo**, **liberação por confiança**, conciliação, suspensão automática por política, exportação contábil CSV |
| Portal do assinante | Faturas, chamados, liberação por confiança, consumo mensal, avisos de manutenção |
| Rede | OLT/ONU Huawei (não homologado), IPAM, CGNAT (gera script), IPv6, rede óptica esquemática (CTO/portas), NOC por regras e diagnóstico |
| Campo | OS com checklist, estoque por série e por técnico, comodato/venda, tela de campo no celular |
| CRM | Prospectos e funil, atendimentos, relatórios simples, avisos ao provedor por webhook |

## 2. O que dá para fazer agora (sem terceiro, sem equipamento)

Cada item tem **ID**, o que entrega, de onde veio a necessidade e o **porte** relativo (P, M, G). Nenhum exige dado do SGP ou do IXC.

### 2.1 Atendimento no dia a dia (o que mais pesa para quem opera)

| ID | Entrega | Evidência | Porte |
|---|---|---|---|
| D1 | **Busca única com contexto**: login, IP, MAC, serial de ONU, telefone, nº de OS, nº de título; resultado já com situação da rede e do financeiro | SGP (23 critérios), IXC (cartões com IP, MAC e plano) | M |
| D2 | **Linha do tempo do cliente**: ocorrências, anotações, financeiro, sessões e OS juntos | SGP (13 abas), IXC | M |
| D3 | **Histórico de sessões com motivo de encerramento** (perda de portadora, pedido do usuário, reset), IP, MAC, volume | SGP e IXC (os dois mostram); já temos o `radacct` no RADIUS local | P |
| D4 | **Extrato de tráfego por período**, com tempo conectado/desconectado, totais e exportação CSV | SGP (tela própria) | P |
| D5 | **Gráficos de consumo** por dia, semana, mês e ano por serviço | SGP (hora/dia/semana/mês/ano e RRD) | M |
| D6 | **Estados separados do contrato**: situação comercial × situação de acesso × velocidade (normal/reduzida) | IXC (pré-contrato, ativo, inativo, negativado, desistiu; acesso: ativo, desativado, bloqueio manual/automático, financeiro em atraso, aguardando assinatura) | M |
| D7 | **Motivo cadastrado** para mudança de situação, com data e modo (manual/automático) | SGP (motivo, modo, data na lista de contratos) | P |
| D8 | **Anotações estruturadas** (tipo, contrato, alerta ao abrir) além do texto livre | SGP (tipos de anotação com alerta) | P |
| D9 | **Contatos múltiplos por tipo** (cobrança, WhatsApp, responsável) e canal preferido | SGP e IXC | P |
| D10 | **Lista de usuários online** com desconexão em lote confirmada e auditada e exportação | SGP e IXC | P |
| D11 | **Permissão por POP e por setor** | SGP (usuários por POP) | M |
| D12 | **POP** como entidade: contagem de contratos por situação, ativo/inativo | SGP | P |

### 2.2 Cobrança e comunicação

| ID | Entrega | Evidência | Porte |
|---|---|---|---|
| C1 | **Motor de avisos ao assinante** (SMS/WhatsApp/e-mail): canal, modelos, janela, intervalo, consentimento, histórico | SGP e IXC (cobrança, OS, pesquisa) | G |
| C2 | **Régua de cobrança** sobre C1: dias relativos ao vencimento, filtros por plano/POP/etiqueta, feriado | SGP (lembrador, avisos) | M |
| C3 | **Degraus por plano**: avisar, reduzir velocidade, bloquear (hoje a política é única) | SGP e IXC | M |
| C4 | **Velocidade reduzida** como estado de rede (perfil reduzido, por inadimplência e por franquia) | SGP e IXC | M |
| C5 | **Página de aviso** para o assinante bloqueado ou com velocidade reduzida | SGP (páginas configuráveis) | M |
| C6 | **Relatórios de cobrança**: aging, inadimplência por faixa, recebido por plano e forma, contratos a cancelar, clientes sem fatura | SGP e IXC | P |
| C7 | **Pesquisa de satisfação** depois da OS e do atendimento (enviada, respondida, expirada) | IXC | P (após C1) |
| C8 | **Fidelidade** com carência e multa rescisória, calculadora no cancelamento | SGP e IXC | M |
| C9 | **Aditivos** e **mudança agendada** de plano/situação | SGP | M |
| C10 | **Desconto temporário**, combos, indicação | SGP e IXC (indicado por) | M |

### 2.3 Campo e atendimento

| ID | Entrega | Evidência | Porte |
|---|---|---|---|
| F1 | **Fluxo de status da OS** com análise, encaminhada, assumida, agendada, **deslocamento**, execução, finalizada, aguardando agendamento | IXC | M |
| F2 | **Catálogos de ocorrência**: tipo, classificação, causa-raiz, origem, método, motivo de OS | SGP | M |
| F3 | **SLA** por tipo e prioridade, com escalonamento | SGP (grupos de SLA) | M |
| F4 | **Agenda de OS** por técnico e dia, melhor horário, prioridade, setor | IXC e SGP | M |
| F5 | **Check-in/check-out**, técnicos auxiliares, kit de instalação | SGP | P |
| F6 | **Origem do endereço da OS** (cliente, serviço, manual) e **endereço de instalação por serviço** | IXC | P |
| F7 | **Comissão** de OS e de venda (vendedor/técnico) | SGP e IXC | M |

### 2.4 Plataforma

| ID | Entrega | Evidência | Porte |
|---|---|---|---|
| P1 | **API pública** com token por aplicação, escopo e limite, e **webhooks** | SGP (tokens por integração), IXC (hub) | M |
| P2 | **Painéis**: conexões offline por faixa de tempo, sinal de ONU por faixa, contratos por mês (ativações, churn), caixa do dia, últimas operações | SGP e IXC | M |
| P3 | **Campos personalizados** em cliente e contrato | SGP (variáveis) | M |
| P4 | **Documentos do cliente** (anexos) | SGP | M — antes, decisão de armazenamento e LGPD |
| P5 | **Exportação para planilha** nas listas principais | SGP (Excel) | P |

### 2.5 Rede, com driver já existente ou simples

| ID | Entrega | Evidência | Porte |
|---|---|---|---|
| R1 | **Parâmetros de rede por plano** (perfil, pool, burst, prioridade) com validação | SGP e IXC | M |
| R2 | **Configurações do NAS** (verificar login/MAC, uso simultâneo por login, intervalo de accounting) | SGP | P |
| R3 | **Consulta por IP público, porta e hora** (CGNAT) | SGP (IP público e faixa por sessão) | P |
| R4 | **Disponibilidade por cliente** (tempo online/offline nos últimos 7 dias) | IXC | P |

### 2.6 Situação das entregas (atualizada em 13/10/2026)

Entregue = implementado e coberto por teste automatizado. Nada aqui foi homologado em equipamento físico nem com gateway/fiscal real.

| Situação | Itens |
|---|---|
| ✅ Entregue | D1, D2, D3, D4, D6, D7, D8, D9, D10, D11, D12, C1, C2, C3, C4, C5, C6, C7, C8, C9, F1, F2, F3, F4, F6, F7, P1, P2, P3, P4, P5, R1, R2, R3, R4 |
| 🟡 Parcial | F5 (kit e auxiliares prontos; check-in com localização não: dado pessoal do técnico), C10 (desconto e indicação prontos; combos de produtos não), D5 (consumo por dia; faltam hora, semana e ano), C1 (canal HTTP genérico; sem operadora real testada) |
| ⏳ Pendente | nada que dependa só de nós nesta lista; ver seção 4 (terceiros e equipamento) |

**Lote 9 em detalhe (agente 0.5.0, escopo, aviso e documentos):**
- **D10 desconexão:** ação assinada `subscriber.disconnect` (individual na ficha e em lote em "Online agora", até 200, com motivo). Não muda a autorização, o motivo nem a data da situação; só cai a sessão que existia antes do pedido. Exige agente 0.5.0.
- **R1 rede por plano:** velocidade no formato MikroTik (com rajada) e pool de endereços enviados pelo RADIUS, opcionais, além do perfil do NAS; "reaplicar" explícito para as contas já provisionadas. Suspensa por perfil, valem a velocidade e o pool do perfil de bloqueio.
- **R2 NAS:** uso simultâneo por login e intervalo de accounting por equipamento. O uso simultâneo depende da seção `session` do FreeRADIUS consultando o accounting.
- **D11 permissão por POP:** usuário (não administrador) restrito a POPs vê só contratos desses POPs e os sem POP, com assinantes, faturas, contas de acesso, OS, atendimentos e documentos. A regra está no **banco** (políticas restritivas), então busca, relatórios, exportação e rotas novas já saem filtrados. Limite: tabelas sem vínculo direto com contrato/assinante (estoque, catálogos, POPs, equipamentos) continuam comuns.
- **C5 página de aviso:** página pública por provedor (`/aviso/<provedor>`, `?m=reduzida`), configurável, **sem identificar o assinante nem mostrar valores**; leva ao portal. O redirecionamento no concentrador está descrito em `docs/operacao.md` e **não foi validado em equipamento**.
- **P4 documentos:** PDF/JPEG/PNG/WebP até 5 MB, tipo conferido pelo conteúdo, guardados no banco (entram no backup e no isolamento por provedor); listar com leitura do cadastro, **baixar só com edição** e com auditoria; excluir apaga o conteúdo e mantém o registro.
- **Validação:** 134 testes da API e 50 do agente. Nada disso foi exercitado no CHR do cenário nem em equipamento físico.

**Lote 8 em detalhe:**
- **P3 campos personalizados:** definidos por provedor para assinante e contrato (texto, número, data, sim/não, seleção; obrigatório opcional); valor guardado na ficha com validação por tipo; campo não se apaga, desativa-se. Não entram no CSV de importação.
- **F5:** *kit de instalação* (itens de estoque sem série, aplicados de uma vez na OS; sem saldo desfaz tudo) e *técnicos auxiliares* por OS.
- **F7 comissão:** regra por natureza de OS (responsável e auxiliar) e por venda (prospecto ganho); apuração por pessoa e período.
- **R3:** o rastreio por IP público + porta + horário agora devolve o **titular na data** a partir das sessões relatadas pelo agente (antes só a sessão atual).
- **R4:** disponibilidade por dia e total (7, 15 ou 30 dias), a partir das sessões; dias anteriores à conta não contam.

**Lote 7 em detalhe (condições do contrato):**
- **C8 fidelidade:** o plano define a carência e a multa (valor único ou por mês restante) e o contrato copia ao ser criado; dá para ajustar por contrato. A **cotação de encerramento** mostra multa e faturas em aberto; encerrar dentro da carência **exige decidir**: cobrar (gera fatura avulsa e cobrança no gateway) ou dispensar com motivo (fica na história).
- **C9 mudança agendada:** troca de plano, de vencimento ou encerramento em data futura; a rotina aplica na data, em nome do sistema, pelo mesmo caminho da alteração manual (a rede reage igual); falha fica registrada com o motivo. **Aditivos** são registros documentais com vigência: não são assinatura eletrônica.
- **C10 desconto:** percentual ou valor, por N meses ou até cancelar, aparece como item negativo na fatura; mês totalmente descontado **não gera fatura**. **Indicação:** vínculo "indicado por" e relatório; a recompensa é um desconto comum.

**Lote 6 em detalhe:**
- **D6/D7 estados:** três eixos separados na ficha do contrato — *comercial* (vigente, restrição de crédito, encerrado, com motivo do catálogo e observação), *acesso* (liberado, bloqueado, não provisionado; modo manual/automático, motivo, data e se o equipamento já confirmou) e *velocidade* (normal, reduzida). Restrição de crédito (negativado) é informação comercial e não bloqueia o acesso.
- **D8 anotações:** tipo do catálogo, vínculo opcional a contrato, **alerta** em destaque ao abrir a ficha, arquivamento, e aparecem na linha do tempo.
- **P5 exportação:** `?format=csv` nas listas de assinantes, contratos, faturas, OS, atendimentos, prospectos, estoque e auditoria, com a mesma permissão e filtro da tela; até 5.000 linhas por arquivo; texto que começaria fórmula é neutralizado; cada exportação vai para a auditoria.

**P1 em detalhe (API pública e webhooks):** módulo `api`; token por aplicação com escopo e limite por minuto (no banco), repetição segura por `Idempotency-Key`,
revogação imediata; leitura de assinantes/contratos/faturas e **abertura** de atendimento e OS (sem escolher responsável); webhooks assinados com HMAC-SHA256 e
timestamp, 6 tentativas com espera crescente, reenvio manual. Eventos: fatura paga, acesso suspenso/reativado, atendimento e OS criados, mudança de estado da OS,
SLA vencido, pesquisa respondida. Documentação em `docs/api-publica.md`. **Não** é camada de compatibilidade com a API de outro sistema.

**C1 em detalhe (avisos ao assinante, somente de saída):** o provedor cadastra um *canal* (endereço HTTPS do serviço de envio que ele contratou, com cabeçalho secreto cifrado),
*modelos* (variáveis `{nome}`, `{valor}`, `{vencimento}`, `{plano}`, `{link}`) e *regras* (dias em relação ao vencimento, plano/POP/etiqueta, janela de horas e dias da semana,
intervalo). Só envia para contato com consentimento registrado; uma vez por título e regra; até 3 tentativas; tudo no histórico. **Não** recebe resposta. Módulo `messages`,
liberado por provedor. O NexoISP não embute provedor de SMS/WhatsApp: a ponte é um POST JSON, validado contra endereços internos.

## 3. Lista de paridade para quem vem do SGP ou do IXC

O que um provedor precisa **no primeiro dia**, **na primeira semana** e **no primeiro mês** para largar o sistema antigo. Marca: ✅ temos · 🟡 parcial · ❌ não temos.

### 3.1 Dados (o que precisa entrar)

| Dado | Origem | NexoISP | O que fazer |
|---|---|---|---|
| Assinantes (PF/PJ, contatos, endereço) | SGP, IXC | ✅ (CSV v2: pessoa, celular/WhatsApp com consentimento, POP, fidelidade, indicação) | Adaptador por origem (depende do formato real) |
| Contratos e serviços (mais de um por cliente) | SGP, IXC | 🟡 (um por linha) | Modelo canônico com N serviços por contrato |
| Planos com política de rede | SGP, IXC | 🟡 | R1 e C3/C4 |
| Login PPPoE e **senha** | SGP, IXC | 🟡 (CSV tem senha) | **Confirmar que a origem entrega a senha** (ver seção 4) |
| IP fixo, MAC, etiquetas | SGP, IXC | ✅ no destino; ✅ MAC e etiquetas no CSV v2; ❌ IP fixo | IP fixo depende de pool no IPAM |
| Títulos em aberto | SGP, IXC | ✅ (CSV; parcialmente pagos ficam em aberto pelo saldo) | Acordos: importar as parcelas como títulos |
| **Histórico financeiro** (pagos, cancelados) | SGP, IXC | ✅ (CSV v2: situação, pago_em, valor_pago, forma) | Gerar o CSV a partir do backup quando o formato for conhecido |
| Equipamento em comodato por cliente | SGP, IXC | 🟡 | Vincular série ao contrato na importação |
| NAS, pools, VLAN, OLT, PON, CTO, ONU | SGP, IXC | 🟡 | Importar o inventário (hoje cadastro manual) |
| Ocorrências, OS, anotações (histórico) | SGP, IXC | ❌ | Importar como linha do tempo (D2) |
| Documentos anexos | SGP | ❌ | P4 |
| Usuários e permissões | SGP, IXC | ❌ | Convite por e-mail com papel sugerido |

### 3.2 Operação (o que o operador faz todo dia)

| Função | SGP | IXC | NexoISP | Falta |
|---|---|---|---|---|
| Autenticar PPPoE com RADIUS local | ✅ | ✅ | ✅ | Homologar em equipamento físico |
| IPoE, DHCP, hotspot, estático | ✅ | ✅ | ❌ | Só se o provedor usar; muda o motor de acesso |
| Suspender, reativar, trocar plano | ✅ | ✅ | ✅ | — |
| Suspensão por perfil/velocidade reduzida | ✅ | ✅ | ✅/🟡 | C3, C4, C5 |
| Desbloqueio temporário | ✅ | ✅ | ✅ | — |
| Desconectar cliente, ping, log do RADIUS | ✅ | ✅ | 🟡 | Ferramentas assinadas e auditadas |
| Autorizar ONU, reset, wifi, acesso externo, remover/reautorizar | ✅ | ✅ | 🟡 (Huawei) | Comandos por fabricante |
| Cobrar: boleto, carnê, PIX, cartão, recorrência | ✅ | ✅ | ❌ | **Gateway real** |
| Emitir nota (NFCom, NFS-e, NF 21/22) | ✅ | ✅ | ❌ | Documento do provedor e emissor |
| Régua de cobrança e avisos | ✅ | ✅ | ❌ | C1, C2 |
| Relatórios ANATEL (DICI, SICI) | ✅ | ✅ | ❌ | Extração a partir de contrato, plano e endereço |
| Mapas (conectados, OS, técnicos) | ✅ | ✅ | 🟡 | Mapa geográfico |
| Multi-empresa/filial | ✅ | ✅ | 🟡 | Filial como atributo do contrato e do financeiro |

### 3.3 Integrações (o que já existe em volta do sistema antigo)

| Integração | Situação no SGP/IXC | NexoISP | O que fazer |
|---|---|---|---|
| Sistema externo (chat, URA) abrindo ocorrência e OS | Via API com token | ❌ | P1: rotas de criação de ocorrência/OS. **O NexoISP não tem chat próprio** |
| Automação de notificações (n8n etc.) | Via API | ❌ | P1 + webhooks de saída |
| Sistema externo de OS, monitor | Via API | ❌ | P1 |
| Provedores de SMS/WhatsApp | 60+ no SGP | ❌ | C1 com um conector + conector HTTP genérico |
| Assinatura eletrônica | Gateway | ❌ | Conector externo |
| Consulta de crédito, negativação | Gateway | ❌ | Conector externo |
| ACS/TR-069 | ✅ | ❌ | Servidor de gerência e modelos reais |

### 3.4 Migração em si

| Passo | Estado | O que falta |
|---|---|---|
| Ler o backup do SGP | ❌ | **O arquivo é cifrado e não abriu** (seção 4) |
| Ler o backup do IXC | ❌ | Sem amostra e sem formato |
| Exportação por CSV pela tela | 🟡 | O SGP só mostra exportação de lista de usuários online e de configuração de OLT |
| Importador com prévia e relatório de perdas | ✅ (CSV) | Adaptadores por origem, N serviços, histórico |
| Conector pela API do SGP | ✅ (ferramenta somente leitura) | Fora do plano do produto; contingência |
| Procedimento de corte e reversão | ✅ (`docs/importacao-csv.md`) | Ensaiar com um provedor real |
| Convivência durante a transição (RADIUS apontado por grupo) | ✅ no desenho | Ensaiar |

## 4. O que está bloqueado, e por quê

| Bloqueio | Efeito | O que destrava |
|---|---|---|
| **Backup do SGP cifrado**: a "chave" tem 256 bytes aleatórios e não funciona como senha em nenhuma forma testada (cerca de 1.080 candidatos × 7 cifras, só acertos por acaso) | Não há como escrever o importador de backup | O procedimento de decifragem do SGP, ou um export em claro, ou só o esquema do banco |
| **Formato do backup/exportação do IXC** | Mesmo efeito para o IXC | Como o IXC exporta; um export de teste anonimizado |
| **Respostas da API do SGP e do IXC** (a documentação traz só os parâmetros) | Sem camada de compatibilidade e sem mapeamento fiel | Texto das páginas "Recursos da API" e "Gerar token" do IXC; uma amostragem de formato do SGP (`tools/sgp-migracao`) |
| **Gateway de pagamento real** | Sem cobrança automática | Escolha do gateway e credenciais de sandbox |
| **Fiscal** | Sem emissão | Documento do provedor e emissor |
| **Equipamento físico** | Nada de rede é "homologado" | O MikroTik que você vai comprar e, para OLT, um equipamento de verdade |
| **Telas do IXC de financeiro, fiscal, contratos, estoque e relatórios** | Matriz do IXC incompleta | Mais capturas |
| **Termos de uso do SGP e do IXC** | Risco jurídico de uso da API e do espelho | Conferência pelo provedor/advogado |

## 5. Ordem recomendada

**Caminho crítico para o primeiro provedor que sai do SGP ou do IXC** (cada item destrava o seguinte):

1. **Decifrar ou obter o backup (ou o esquema)** do SGP, e a forma de exportar do IXC. Sem isso, a migração é manual.
2. **Modelo canônico ampliado** + adaptador por origem + prévia com **relatório de perdas** (o que não tem destino é listado).
3. **Gateway real (PIX)** e **conciliação** com ele.
4. **D1, D2, D3** (busca, linha do tempo, sessões): o atendente não aceita perder isso.
5. **C1, C2, C3** (avisos, régua, degraus): é o que o provedor usa para não perder dinheiro.
6. **P1** (API pública com token): mantém as automações dele funcionando.
7. **Homologação em equipamento físico** do PPPoE e, se houver, da OLT.
8. **Fiscal** do documento que o provedor emite.

**Em paralelo, sem depender de nada:** D4 a D12, C6, F1 a F6, P2, P5, R2 a R4.

**Só quando houver demanda concreta:** IPoE/DHCP/hotspot, mais fabricantes de OLT, ACS, assinatura eletrônica, conectores de SMS adicionais, comissões, campos personalizados.

## 6. O que não fazer

- **Folha de pagamento, contabilidade, frota, telefonia e MVNO próprios.** Integrar com o sistema do provedor; construir é outro produto.
- **Console de comandos livre no painel.** Contraria a garantia central do NexoISP (operação assinada, versionada e verificada).
- **Dizer "compatível com SGP/IXC" em material comercial.** Compatibilidade de dados e de integrações é uma entrega nossa; as marcas são deles.

## 7. Diferenciais que sustentam "superior"

| Diferencial | Hoje |
|---|---|
| Operação de rede assinada, versionada e verificada; operação obsoleta não executa | ✅ |
| Divergência entre o pedido e o equipamento, sem correção silenciosa | ✅ |
| Autenticação local que continua com a nuvem fora do ar | ✅ |
| Isolamento por provedor no banco | ✅ |
| Diagnóstico por regras com evidência | ✅ |
| Prévia de efeito antes de aplicar (simulador de inadimplência, prévia de importação) | 🟡 |
| Linha do tempo única do cliente | ❌ (D2) |
| API aberta com webhooks desde o início | ❌ (P1) |
| Aviso proativo de problema coletivo ao assinante, ligado ao NOC | ❌ (C1 + NOC) |
