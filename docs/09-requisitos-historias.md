# NexoISP — requisitos em histórias (ondas 1 a 3 do roteiro)

> **Decisão de produto (13/10/2026): o NexoISP não é um sistema de chat.** Não há atendimento por conversa. O atendimento é feito por **ocorrência e ordem de serviço**
> (abertura, acompanhamento, SLA, agenda, execução). Mensagens ao assinante existem **só de saída** (cobrança, manutenção, OS): sem caixa de entrada, sem respostas.
> Onde este documento citar "chat", "URA" ou "WhatsApp" como origem de atendimento, leia como **integração externa que abre ocorrência por API**, nunca como canal nosso.

**Criado em:** 13 de outubro de 2026
**Origem:** `docs/08-roadmap-crm-completo.md`. Escrito com a linguagem do NexoISP e do setor; nenhum texto, tela ou desenho do SGP foi reaproveitado.
**Regra:** nada aqui entra antes do piloto sem decisão do proprietário. Cada história diz o que a **fecha** (critério de aceite) e o que fica **de fora**.
**Porte** é relativo (P, M, G), não prazo.

## Convenções

- "Provedor" é o cliente do NexoISP; "assinante" é o cliente final do provedor.
- Tudo é **opt-in por provedor** e usa as garantias que já existem: isolamento por provedor no banco, auditoria, operação de rede assinada e verificada.
- **Mensagem ao assinante é efeito externo.** Toda história que envia algo exige consentimento registrado, janela de envio e histórico, e nunca repete cegamente
  (mesma regra de "consultar antes de repetir" do motor de rede).

## Onda 1 — comunicação e inadimplência

### Épico A — Avisos ao assinante

| ID | História | Critérios de aceite | Porte |
|---|---|---|---|
| A1 | Como provedor, quero cadastrar **um canal de envio** (SMS ou WhatsApp, via conector) para o NexoISP falar com o assinante | Credencial guardada cifrada; teste de envio; canal pode ser desligado; **sem credencial no log e na auditoria**; falha de envio visível | M |
| A2 | Como provedor, quero **modelos de mensagem** com variáveis (nome, valor, vencimento, link da fatura) | Pré-visualização com dados de exemplo; variável inexistente é recusada ao salvar; limite de tamanho do canal respeitado | P |
| A3 | Como provedor, quero **regras de aviso de cobrança** por dias relativos ao vencimento, dia da semana, horário limite e feriado | Regra liga e desliga; filtra por plano, etiqueta e situação; **não envia fora da janela**; nunca envia duas vezes o mesmo aviso para o mesmo título; intervalo mínimo entre avisos | G |
| A4 | Como assinante, quero **não receber** mensagens que não pedi | Registro de consentimento e de saída (parar/sair); respeitado antes de qualquer envio; consultável por contrato | M |
| A5 | Como atendente, quero ver o **histórico de mensagens** de um assinante | Quem, quando, canal, modelo, resultado (entregue, falhou, sem canal); filtro por período | P |
| A6 | Como operador, quero que o NexoISP **avise o assinante da manutenção programada** | Reaproveita o aviso do portal; só atinge quem está no escopo; mensagem única por janela | P (após A1–A5) |

**Fora de escopo:** campanha de marketing em massa, conversa bidirecional, chatbot.
**Depende de:** escolha de **um** provedor de envio (os demais entram como conectores, por demanda).

### Épico B — Degraus de inadimplência por plano

| ID | História | Critérios de aceite | Porte |
|---|---|---|---|
| B1 | Como provedor, quero **por plano** dias para **avisar**, **reduzir a velocidade** e **bloquear** | Valores por plano; sem valor, vale a política do provedor (comportamento de hoje); validação (avisar ≤ reduzir ≤ bloquear) | M |
| B2 | Como provedor, quero o degrau de **velocidade reduzida** na rede | Perfil reduzido configurado por plano; aplicado pela mesma operação assinada; **verificado por leitura**; volta ao plano no pagamento | M |
| B3 | Como assinante bloqueado ou com velocidade reduzida, quero ver **um aviso** que explique o motivo | Página servida ao endereço do pool de bloqueio, com valor, vencimento e meio de pagamento; **sem dados de outros assinantes**; o redirecionamento continua sendo do concentrador do provedor | M |
| B4 | Como atendente, quero ver **em que degrau** cada contrato está | Coluna e filtro na lista de contratos e na ficha; mostra a data do próximo degrau | P |

**Fora de escopo:** redirecionamento configurado automaticamente no concentrador (é decisão do provedor, e o NexoISP não escreve no firewall dele).

### Épico C — Relatórios de cobrança

| ID | História | Critérios de aceite | Porte |
|---|---|---|---|
| C1 | Como financeiro, quero o **aging** da carteira (a vencer, 1–30, 31–60, 61–90, mais de 90 dias) | Soma bate com a lista de faturas; filtro por plano, etiqueta e POP; exportação CSV | P |
| C2 | Como financeiro, quero **recebido por plano e por forma** em um período | Estornos descontados; bate com a exportação contábil | P |
| C3 | Como gestor, quero **inadimplência por faixa e por mês** | Definição escrita na tela (o que conta como inadimplente); comparação com o mês anterior | P |
| C4 | Como gestor, quero a **lista de contratos a cancelar** (muitos meses em atraso) | Critério configurável; não cancela nada sozinho | P |

## Onda 2 — atendimento e campo

### Épico D — Catálogos de atendimento e SLA

| ID | História | Critérios de aceite | Porte |
|---|---|---|---|
| D1 | Como provedor, quero **tipos de atendimento** com setor responsável e opção de gerar OS | Tipo define setor, se gera OS e se aparece no portal; tipo desativado some da abertura mas fica no histórico | M |
| D2 | Como provedor, quero **classificação, origem e causa-raiz** | Catálogos editáveis; obrigatoriedade por tipo; relatório por causa-raiz | M |
| D3 | Como provedor, quero **SLA** por tipo e prioridade com prazo de atendimento e de solução | Contagem só em horário comercial configurável; **vence** muda a cor e notifica o responsável; histórico de quem estourou | M |
| D4 | Como atendente, quero **escalonar** o atendimento que vai estourar | Regra: X% do prazo → avisa; 100% → reatribui ao setor; registrado na linha do tempo | P |

### Épico E — Agenda e execução de OS

| ID | História | Critérios de aceite | Porte |
|---|---|---|---|
| E1 | Como despachante, quero a **agenda** por técnico e por dia | Arrastar e soltar muda o agendamento; conflito de horário avisa; respeita a permissão de OS | M |
| E2 | Como técnico, quero **check-in e check-out** na OS | Horário e coordenada (se o técnico permitir); sem check-in não encerra a OS (configurável) | P |
| E3 | Como técnico, quero **anexar fotos** e coletar **assinatura** do assinante | Armazenamento definido (decisão de LGPD antes); tamanho e tipo limitados; foto não aparece no portal | M |
| E4 | Como técnico, quero **auxiliares** e **materiais por kit** | Kit de instalação baixa itens do estoque em uma ação; auxiliar recebe a OS na tela dele | P |
| E5 | Como técnico, quero trabalhar **sem sinal** e sincronizar depois | Fila local; conflito resolvido pela regra "o servidor vence, o técnico é avisado"; nunca perde registro | G |

## Onda 3 — comercial

| ID | História | Critérios de aceite | Porte |
|---|---|---|---|
| F1 | Como provedor, quero **vendedores** com comissão por plano ou por título | Regra (percentual ou fixo, parcelas); relatório por período; **estorno desfaz a comissão** | M |
| F2 | Como provedor, quero **indicação** com desconto para quem indica | Vínculo entre contratos; desconto por regra e prazo; sem autoindicação | P |
| F3 | Como provedor, quero **desconto temporário** e **combos** | Período e quantidade de meses; aparece como item da fatura; não reduz abaixo de zero | M |
| F4 | Como prospecto, quero **consultar viabilidade** pelo meu endereço | Resposta "atende / não atende / consultar"; não revela mapa interno; limite de consultas por origem | M |
| F5 | Como provedor, quero **fidelidade** com multa de rescisão | Carência, valor ou percentual, **conferido contra o cálculo manual do provedor** (ver `docs/10`, caso 6) | M |
| F6 | Como provedor, quero **aditivos** e **mudanças agendadas** de plano ou situação | Data de efeito; cancelável antes; aplicado pela mesma rotina de mudança de contrato | M |

## Critérios gerais (valem para todas as histórias)

1. **Isolamento:** teste automático de que um provedor não vê nem altera dados de outro.
2. **Auditoria:** quem fez, o quê e o resultado; segredo nunca no registro.
3. **Idempotência:** repetir a mesma ação (reenvio, reexecução da rotina) não duplica efeito financeiro nem mensagem.
4. **Padrão desligado:** sem configuração, o comportamento é o de antes.
5. **Documentado em `docs/operacao.md`** o que o provedor precisa configurar fora do NexoISP.

## O que preservar como diferencial (não "igualar para baixo")

| Diferencial | Por que vale |
|---|---|
| Operação de rede **assinada, versionada e verificada**; operação obsoleta não executa | Nenhum comando livre; suspensão antiga não derruba cliente que já pagou |
| **Divergência** entre o pedido e o equipamento, sem correção silenciosa | O provedor vê o que mudou fora do sistema |
| **Autenticação local** continua com a nuvem fora do ar | O assinante não sente a falha do SaaS |
| **Isolamento por provedor** garantido no banco | Multi-provedor de verdade, não só filtro de tela |
| **Módulos por provedor** recusados no servidor | Vender por pacote sem expor o que não foi contratado |
| Diagnóstico por **regras com evidência**, sem IA escrevendo na rede | Explicável e auditável |
