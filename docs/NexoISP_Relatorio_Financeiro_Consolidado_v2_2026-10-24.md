---
title: "NexoISP — Relatório técnico financeiro consolidado (versão 2)"
subtitle: "Arquitetura, open-source, Pix, boleto, carteiras digitais, operação de provedores, SaaS, segurança e plano de lançamento"
author: "Análise técnica e planejamento — NexoISP"
date: "24 de outubro de 2026"
lang: pt-BR
geometry: margin=2cm
fontsize: 10pt
colorlinks: true
---

# NEXOISP — RELATÓRIO FINANCEIRO CONSOLIDADO

**Versão:** 2.0 — consolidação integral de 23 e 24 de outubro de 2026  
**Repositório:** <https://github.com/TavaresEnok/nexoisp>  
**Fontes internas consolidadas:** relatório financeiro original (26 seções, 23/10/2026) + adendo operacional e bancário (20 recomendações, 24/10/2026).  
**Objetivo:** orientar produto, arquitetura, código, operações e homologação de uma camada financeira bancária para NexoISP compartilhado e dedicado.  
**Natureza:** planejamento; não é confirmação de homologação, pentest, parecer fiscal/jurídico ou evidência de que as propostas já estejam implementadas.

> **Decisão de arquitetura mantida:** preservar o financeiro e as telas já existentes em Go e React/Vite; acrescentar um motor de integrações bancárias por adaptadores, credenciais segregadas e conciliação verificável. O banco/PSP do próprio provedor recebe o dinheiro de seus assinantes. Pequenos ISPs usam células compartilhadas com banco PostgreSQL e RLS; grandes ISPs usam instalações dedicadas do mesmo código. A primeira entrega deve ser vertical, com um PSP real homologado, fluxo de cobrança completo, onboarding, operação assistida e proteção contra duplicações.

## Guia de leitura desta versão consolidada

Este documento **não simplesmente anexa dois textos**: os 20 acréscimos identificados por `A01` a `A20` foram inseridos nos capítulos existentes e localizados em matriz de rastreabilidade na seção 24.1. A estrutura das 26 seções originais permanece para facilitar comparação com tickets, APIs, páginas e ADRs já elaborados. Em situações de aparente conflito, a especificação mais recente do PSP, a documentação normativa e a evidência do código prevalecem sobre propostas anteriores.

**Leitura dos estados:** `existente/documentado` significa registro no material de projeto, não teste independente; `proposto` significa decisão ainda a implementar; `homologado` só após execução comprovada em conta, banco e infraestrutura autorizados. Informações de tarifas, capacidade bancária e requisitos de acesso dependem da instituição e da contratação específica de cada provedor.

### Regras que não podem ser negociadas

1. Não misturar o dinheiro da assinatura NexoISP com mensalidades dos consumidores dos provedores.
2. Não permitir que tenants compartilhem credenciais, certificados, acesso a títulos, jobs ou identidade de webhooks.
3. Não registrar recebimento real apenas com base em PDF, comprovante WhatsApp ou sucesso HTTP de emissão.
4. Não processar o mesmo evento ou liquidação em duplicidade; preservar reconciliação de divergências e operações com resultado desconhecido.
5. Não prometer que um gateway, carteira ou convênio está homologado sem teste com o produto bancário realmente contratado.
6. Não deixar o cliente piloto migrar do ERP anterior sem plano para títulos e eventos que continuam em circulação.
7. Não exigir microserviço financeiro individual por tenant: compartilhar código/processos de forma segura na célula, e separar infraestrutura só quando necessário.
8. Não interromper PPPoE/RADIUS dos assinantes finais como efeito automático de inadimplência da assinatura SaaS do provedor.

---

## SUMÁRIO DE NAVEGAÇÃO

| Capítulos 1–13 | Capítulos 14–26 |
|:--|:--|
| [1. Estado atual e lacunas](#cap01) | [14. Páginas e operação](#cap14) |
| [2. Modelo SaaS e isolamento](#cap02) | [15. Etapas de implementação](#cap15) |
| [3. Construir ou reutilizar](#cap03) | [16. Critérios de aceite](#cap16) |
| [4. Cinco bibliotecas e bancos](#cap04) | [17. Riscos e mitigação](#cap17) |
| [5. Arquitetura e adaptadores](#cap05) | [18. Custos e tarifários](#cap18) |
| [6. Webhooks e simulador](#cap06) | [19. Seleção de fornecedores](#cap19) |
| [7. Pix, BolePix e recorrência](#cap07) | [20. Releases F0–F3](#cap20) |
| [8. Boletos, CNAB, carnês](#cap08) | [21. Gate de produção](#cap21) |
| [9. Segurança e permissões](#cap09) | [22. Perguntas em aberto](#cap22) |
| [10. Conciliação e Pix estático](#cap10) | [23. ADRs e decisões](#cap23) |
| [11. Financeiro e rede](#cap11) | [24. Execução via IA e rastreio](#cap24) |
| [12. Modelo de dados](#cap12) | [25. Limites da auditoria](#cap25) |
| [13. APIs e contratos](#cap13) | [26. Fontes oficiais e projetos](#cap26) |

**Nota:** além dos 26 capítulos, as propostas A01–A20 estão indexadas na seção 24.1.

---

## 1. Leitura correta do estado atual {#cap01}

O NexoISP NÃO começa do zero. Sua arquitetura documentada usa frontend React/TypeScript/Vite, API Go/Chi/Huma, PostgreSQL com `tenant_id` e RLS, pgx e tarefas River. O ADR-010 registra entidades separadas de fatura, pagamento e evento, idempotência de recorrência/eventos e conciliação; o único gateway real não está implementado: existe apenas a integração demonstrativa. [F1][F2]

A matriz funcional do repositório registra as seguintes capacidades como implementadas e integradas à interface: listagem financeira, geração idempotente de faturas, consulta de saldo, recebimento integral/parcial, taxas e desconto, estorno de baixa manual, cancelamento com motivo, decisão de divergência, extrato por contrato, renegociação, concessão de prazo, regras de cobrança, tela pública de bloqueio/redução, CSV contábil e relatórios. Já `FI-15` (conciliação automática com gateway de demonstração) e `FI-16` (simulação de pagamento/cobrança) são **demonstrativas**; `FI-17` (Pix/boleto bancário real) está **não confirmado**. Essas qualificações importam: a presença de tela não equivale a pagamento efetivo. [F3]

A documentação oficial de pendências exige homologar emissão, recebimento de evento duplicado/perdido, baixa, cancelamento e conciliação antes de ativar o gateway em produção. Ela alerta para não operar dois financeiros independentes sobre os mesmos títulos durante uma migração. [F2]

### 1.1 O que não seria sensato refazer

- Cadastros de assinantes, contratos, vencimentos, competência e títulos que já tenham comportamento correto.
- Regras comerciais de atraso, renegociação e geração idempotente já implementadas, salvo bugs encontrados por teste específico.
- Estrutura atual de autenticação, permissões, módulos e RLS; é necessário reforçá-la para provedores financeiros, não duplicá-la.
- Interface React oficial já integrada ao backend, salvo pontos que precisam receber ações operacionais reais.
- Tarefas River/outbox, que podem receber os novos jobs, evitando criar uma fila redundante.

### 1.2 O que realmente falta decidir e comprovar

- Provedor de pagamentos do primeiro piloto; tarifas e convênio compatíveis com o perfil do ISP.
- Credenciais por tenant, ambientes sandbox/produção e responsabilidade pela guarda/rotação de certificados.
- Modelo de contas recebedoras: cada ISP deve receber em sua conta própria; exceções de marketplace/split exigiriam contrato e análise regulatória específicos.
- Tratamento rigoroso de eventos duplicados, perdidos, atrasados, fora de ordem e adulterados.
- Protocolo de conciliação que não confunda 'cobrança emitida' com 'pagamento confirmado' ou 'dinheiro disponível'.
- Política de cancelamento, vencimento, juros, multas, descontos, estornos e devoluções por provedor.
- Separação de recebedor, tomador, empresa faturadora e proprietário da conta quando o tenant possui filiais ou CNPJs distintos.
- Integração de cobrança com suspensão PPPoE/RADIUS e retorno do estado da rede; pagamento confirmado e sessão reativada são fatos diferentes.
- Política fiscal independente de pagamentos, especialmente NFCom modelo 62 quando aplicável.
- Critérios de migração e rastreabilidade na passagem do ERP anterior para o NexoISP.


## 2. Modelo de negócio e implantação do SaaS {#cap02}

A modalidade **compartilhada** atenderá diversos provedores pequenos, inicialmente até cerca de **1.000 assinantes por provedor**. Eles usam uma instância lógica de backend/filas/PostgreSQL compartilhada, com `tenant_id` e RLS, além de limites de uso e isolamento de recursos. A modalidade **dedicada** atenderá provedores grandes (ou com necessidades específicas) em stack e banco próprios. **O código-fonte e os modelos de negócio devem permanecer únicos**, com versões e migrações de schema compatíveis.

O patamar de 1.000 clientes é um critério inicial de oferta e operação, não uma garantia de capacidade: 1.000 contratos com poucas cobranças podem consumir menos recursos que 300 assinantes com alto volume de importações, cobranças recorrentes, agentes, notificações e reprocessamento.

### 2.1 Matriz de isolamento proposta

| Aspecto | Compartilhado | Dedicado |
|:--|:--|:--|
| Backend Go | Réplicas por célula compartilhada | Backend exclusivo |
| PostgreSQL | Mesmas tabelas, `tenant_id` e RLS | Banco/cluster próprio |
| Motor financeiro | Mesmo processo/versão para tenants | Mesmo código em processo dedicado |
| Jobs River | Fila compartilhada com justiça por tenant | Fila dedicada |
| Credenciais Pix/bancos | Segredos individuais por tenant | Segredos próprios do cliente |
| Certificados/mTLS | Isolados por tenant e conexão | Isolados na instalação |
| Webhook público | Endpoint roteado e autenticado por conexão | Endpoint da instalação |
| Documentos/arquivos CNAB | Armazenamento segregado e políticas de acesso | Bucket/volume dedicado |
| Painel de auditoria | Acesso delegado sob trilha auditável | Auditoria própria + acesso delegado opcional |
| Atualização | Por célula, com canary | Por instalação e janela contratada |
| Limites/quotas | Por tenant e por banco | Por ambiente/contrato |

### 2.2 Nunca misturar isolamento de software com liquidação financeira

O fato de dezenas de provedores compartilharem o PostgreSQL **não significa** que possam compartilhar conta Efí/Asaas/Inter, carteira bancária, chave Pix, webhook token, convênio ou certificado. O dinheiro do assinante deve liquidar na conta financeira do provedor correspondente, salvo uma arquitetura de intermediação formalmente contratada e analisada. Portanto:

1. Cada `payment_connection` pertence a um `tenant_id` e a um `billing_entity_id`/CNPJ recebedor.
2. Cada `external_charge_id` deve ser único dentro da conexão financeira, e não globalmente tratado como se fosse um título de todos.
3. Cada evento entra associado à conexão correta por chave/rota assinada/token do fornecedor, sem confiar no `tenant_id` do JSON recebido.
4. Toda requisição ao PSP usa exclusivamente as credenciais dessa conexão, sem fallback para outro tenant.
5. Logs, alertas, suporte técnico e exportações mascaram documentos e não revelam certificados ou segredos.
6. No modo dedicado, a mesma regra de domínio continua válida e prepara o sistema para grupos empresariais e filiais.

### 2.3 Células SaaS e plano de controle

É recomendável um **control plane** enxuto que mapeie tenant → célula → modalidade → versão do schema → limite de assinantes → estado comercial → recursos contratados. Ele não deve conhecer saldos, faturas nem chaves privadas de bancos. O data plane de cada célula ou instalação processa operações financeiras. Distribuir tenants por células evita que um único banco compartilhado se torne ponto único de escala para toda a base SaaS.

Restrições essenciais: um tenant não pode rodar jobs infinitos e esgotar os trabalhadores; `retry` de uma conta com falha não pode bloquear as demais; relatórios longos necessitam paginação/limites; processamento financeiro deve ter cotas e prioridades por provedor; tokens de operação devem permanecer dentro de seu escopo.

### 2.4 Migração de compartilhado para dedicado

O mecanismo de migração deve identificar um ponto de corte, bloquear apenas operações mutáveis críticas, drenar filas do tenant, capturar dados e arquivos relacionados, copiar com validação de somas/contagem, mapear RLS e chaves criptográficas, reprovisionar endereços de webhook com coexistência controlada, preservar IDs externos dos gateways, verificar assinaturas e comparar saldos. Reabrir só depois de reconciliação. Eventos que chegarem à célula antiga durante o corte deverão ser encaminhados com autenticidade e idempotência, não descartados. **Não recriar cobranças no gateway durante migração** sem necessidade: a identidade externa precisa sobreviver ao movimento de infraestrutura.


### 2.5 — Cobrança SaaS do NexoISP, separada da cobrança do assinante (P1) [A13]

Usar os mesmos contratos de adaptadores de pagamento, mas separar domínios e dados: `platform_billing` (NexoISP cobra assinatura do ERP ao provedor) e `isp_billing` (provedor cobra cliente de internet). `platform_billing` não deve habitar uma tabela de tenant operacional como se fosse fatura do assinante. Cobrança do SaaS pertence à empresa operadora da plataforma, em conta própria. Inadimplência de um provedor não deve disparar corte de RADIUS dos assinantes finais; eventual bloqueio administrativo exige transição contratual, comunicação e plano de continuidade compatível com obrigações aplicáveis.

**Critério de aceite:** suporte da plataforma não altera movimentações financeiras do assinante sem delegação; cenários de inadimplência do SaaS não desligam equipamentos nem sessões de clientes automaticamente.


### 2.6 — ERP versus BaaS (P0 antes de parcerias) [A14]

A Resolução Conjunta 16/2025 disciplina serviços BaaS. O Asaas informa que subcontas podem existir nos formatos BaaS e não-BaaS, dependendo de quem administra o serviço, credenciais e experiência financeira. **Não assumir que o simples uso de conta própria do provedor ou um campo de CNPJ resolva qualquer questão regulatória.** O desenho preferencial é o ISP ter relação bancária/PSP direta, autorizar a conexão do ERP e receber diretamente os recursos. Evitar criar/controlar contas de terceiros pelo NexoISP sem contrato e revisão regulatória específica. Revisar termos concretos por PSP com assessoria jurídica especializada antes do lançamento.

**Critério de aceite:** documentação de papéis contratuais, recebedor e PSP; nenhum fluxo de abertura/gestão de subconta é implementado inadvertidamente; credenciais de um ISP nunca são controladas pela conta de outro.


### 2.7 — Concentração mensal de cobranças (P0) [A05]

Pequenos ISPs concentram vencimentos em determinados dias. Criar plano D-10 configurável, janelas, quota por PSP, quota por credencial e justiça entre tenants; utilizar workers River existentes com throttling, backoff com jitter, limites de concorrência e estado de resultados desconhecidos. Não presumir que duas contas da mesma instituição tenham quotas independentes: confirmar escopo documentado pelo PSP.

**Critério de aceite:** emissão em massa de diversos tenants preserva previsibilidade e não esgota a fila de outro provedor; 429 não provoca cobrança duplicada; painel mostra jobs pendentes, falhos e recuperáveis.


### 2.8 — Migração de títulos antigos de SGP/IXC/outro ERP (P0 para provedores migrados) [A12]

Importar títulos abertos sem gerar novas cobranças: `legacy_source`, ID anterior, conta/convênio, nosso número, txid, identificador externo e valor/vencimento. Conferir extrato/retorno CNAB/consulta API do banco, assunção de webhook se autorizada e compatível, transição de URLs e coexistência controlada entre ERP antigo e NexoISP. A mudança de proprietário de webhook **não é garantida** por todas as APIs; planejamento manual e conciliação de contingência podem ser necessários. Durante a janela de migração, definir um único sistema autorizado a produzir novas cobranças; os pagamentos dos legados ainda são reconhecidos e alocados pela nova camada. Preservar histórico e mapas de identidade.

**Critério de aceite:** lote migrado mantém contagem e somatório; pagamento posterior de título antigo quita a fatura sem duplicar emissão; falha na troca do callback não causa perda irreversível de recebimento; relatório de diferenças e rollback documentados.


### 2.9 — Migração assistida entre bancos e contingência (P1) [A18]

Permitir direcionar apenas novas cobranças ao banco novo, enquanto títulos antigos permanecem vinculados à instituição original; manter ambos conectados durante coexistência e conciliação. Em falha de API, conservar boletos/QR válidos já emitidos, enfileirar nova emissão ou permitir outro método com autorização explícita, nunca lançar segunda cobrança silenciosamente para a mesma obrigação.

**Critério de aceite:** mudança de banco não altera ID de cobrança existente; eventos atrasados do banco anterior ainda conciliam; contingência não emite cobrança duplicada.


### 2.10 — Execução compartilhada e dedicada: regras financeiras

**Compartilhado:** diversos ISPs com até ~1.000 assinantes por tenant em backend, River, PostgreSQL e storage compartilhados; RLS, cotas de fila, segredos criptografados por conexão/tenant, HTTP webhook resolvido por rota opaca + autenticação independente e recursos guardados no escopo correto. O mTLS ingress pode atender mais de um PSP, mas nunca deve aceitar client cert em headers não confiáveis da Internet. Realizar classificação por PSP e conexão sem misturar contextos de TLS e tenant.

**Dedicado:** mesmo código, workers e regras, banco próprio e segredos da instalação; possibilidade de domínio de callback e ingress próprios. Mesmo contrato de adaptadores, migrations e UI. O controle de plano/assinatura SaaS é camada distinta dos recebíveis de assinantes.

**Regras universais:** dinheiro direto na conta do ISP; nunca banco do NexoISP como recebedor involuntário; conciliação por conta; histórico imutável para eventos financeiros; consulta por PSP em caso de dúvida; estado de rede separado de estado de pagamento; logs com máscara; alertas por tenant/célula/PSP; rollback com IDs preservados.



## 3. Escolha estratégica: construir ou reutilizar? {#cap03}

### 3.1 O que precisa ser próprio

- Domínio de faturamento ISP: competências, pro-rata, contrato, plano, adicionais, fidelidade, atraso, negociação, bloqueio/redução/reativação.
- Registro interno de cobrança, pagamentos, alocações, devoluções, eventos, extratos e saldo por empresa.
- Regras por tenant, segregação de funções, auditoria, aprovação e execução de jobs.
- Máquina de estados interna e conciliação entre banco, PSP, cobrança e contrato.
- APIs e telas React, independentes da tecnologia usada no banco.

### 3.2 O que deve ser preferencialmente reutilizado

- Autenticação OAuth2, TLS/mTLS e contratos HTTP oficiais de cada banco/PSP via SDK oficial ou cliente gerado e auditado.
- Geração de boleto, dígitos verificadores, linha digitável, nosso número, carteira e remessa/retorno por bibliotecas maduras quando necessárias.
- Especificações Pix do Banco Central e manuais FEBRABAN como fonte normativa/técnica; bibliotecas não substituem a especificação.
- Conectores para emissão fiscal, assinatura eletrônica e conciliação de arquivos quando homologados.

### 3.3 O que NÃO escolheria como arquitetura inicial

- Substituir o financeiro Go por uma instalação de Odoo/ERPNext/ERP completo; duplicaria contratos, cadastros, regras e autenticação.
- Microserviço financeiro por tenant pequeno; multiplicaria deploy, certificados, migrations, logs e custo operacional.
- Cinco bibliotecas bancárias ativas ao mesmo tempo; dificulta diagnosticar falhas e aumenta superfícies de ataque.
- Reimplementar centenas de peculiaridades CNAB sem amostras reais, manuais atualizados e homologação por carteira.
- Colocar informações de cartão sensíveis na API do NexoISP sem necessidade; preferir checkout hospedado/tokenização sob contrato de PSP.


## 4. As cinco soluções priorizadas — exame técnico {#cap04}

### 4.1 Efí Pay: SDK Go oficial — primeira integração candidata

**Fonte:** <https://github.com/efipay/sdk-go-apis-efi> [F4]. **Licença declarada:** MIT. **Uso ideal:** primeiro fluxo real Pix e boleto; avaliação de assinatura/Pix Automático conforme produto contratual. O SDK possui exemplos e cobre APIs da Efí; isso reduz mapeamento, mas **não** elimina validação de certificado, webhooks, limites, versão do SDK ou termos comerciais. O README cita versões antigas do Go testadas e contém instruções históricas; antes de incluir em produção, verificar CI e compatibilidade com o Go usado pelo NexoISP.

**Vantagens:** mesma linguagem Go, fornecedor identificável, sandbox e documentação de APIs, cadastro por conta recebedora, capacidade de fazer PoC de ponta a ponta com menos superfície que um serviço genérico.

**Problemas:** lock-in nos recursos específicos da Efí, tarifa/conta/conveniamento, disponibilidade contratual por modalidade, risco de mudanças de API e de SDK desatualizado, configuração mTLS/certificado por tenant, callbacks associados ao recebedor. SDK oficial não significa que todos os métodos anunciados tenham a mesma prontidão.

**Ações:** adaptar o SDK por uma interface interna própria; implementar wrapper com contexto, timeouts, retries classificados, correlação e mascaramento; criar tratamento de notificações; comprovar criação/consulta/cancelamento/devolução e conciliação no sandbox; documentar diferenças entre cobrança, pagamento e repasse/liquidação.

**Aceite:** dois tenants sandbox emitindo títulos sem cruzar credenciais, evento duplicado sem segunda baixa, rede indisponível sem perder resultado, cancelamento e devolução registrados corretamente e reconciliação posterior consistente.

### 4.2 ACBrBoleto e ACBrLibBoleto — potencial base multibanco, com cuidado de distribuição

**Fonte:** <https://projetoacbr.com.br/pro/downloads/acbrlibboleto/> e <https://projetoacbr.com.br/> [F5]. O ACBr fornece componentes open-source sob licença LGPL; a oferta de **ACBrLibBoleto pronta**, segundo a página oficial, faz parte do ACBr Pro. Não confundir disponibilidade do código dos componentes com direito automático de distribuir qualquer binário, contratar suporte ou usar versões prontas sem observar licença/assinatura.

**Vocação:** campos de boleto, carteiras, impressão, remessa/retorno e alguns webservices de bancos. **Não é universalmente um gateway Pix nem solução automática de confirmação financeira**. Integração no Go pode ser feita por FFI/biblioteca nativa ou serviço interno encapsulado, mas exige atenção a ABI, plataforma, atualização e licenças; para minimizar risco, um serviço próprio isolado, se escolhido, é mais simples de observar que vincular libs não auditadas diretamente ao processo central.

**Vantagens:** conhecimento acumulado dos layouts brasileiros, ampla adoção histórica, muitos bancos, muitas situações de convênio/cartões/variações, boa referência para regras bancárias.

**Problemas:** custo e obrigações da distribuição ACBrLib; necessidade de compilação/empacotamento por arquitetura (amd64/arm64), dependências de SO, atualizações frequentes de bancos, homologação carteira por carteira, diferenças entre gerar PDF e efetivar registro na instituição, características de multi-tenant em uso concorrente. Confirmar thread safety e isolamento por conexão antes de expor serviço comum.

**Ações:** prototipar apenas UM layout CNAB e UMA carteira bancária exigida por cliente real; enviar/retornar arquivos fictícios de homologação; verificar teste de concorrência entre tenants; rever LGPL e termos do fornecedor com especialista jurídico antes de embutir ou distribuir.

### 4.3 BoletoNetCore — alternativa e referência para boletos/CNAB

**Fonte:** <https://github.com/BoletoNet/BoletoNetCore> [F6]. Projeto .NET/C# com bancos e carteiras publicados, distinguindo carteiras homologadas e implementadas sem homologação. Esse critério de evidência deve inspirar o catálogo do NexoISP.

**Vantagens:** layout organizado, verificações, motores de boleto e remessa/retorno, bons exemplos para testes de dígitos verificadores, nosso número e impressão de boleto. Empacotamento como serviço REST .NET é possível caso uma dependência seja mais adequada que portar regras para Go.

**Problemas:** runtime e serviço adicionais; escopo financeiro limitado; atualizar layout a cada mudança de banco; interoperabilidade REST, autenticação e custo de monitoramento; risco de duas fontes de verdade se alguém colocar estado de faturas no serviço C#.

**Decisão:** comparar com ACBr para o banco/carteira real desejado, escolher no máximo um motor CNAB por instalação/capacidade, mantendo títulos e liquidações somente no banco de dados principal Go.

### 4.4 go-asaas — alternativa comunitária para um segundo gateway

**Fonte:** <https://github.com/n0vdd/go-asaas> [F7]. SDK comunitário MIT que declara suporte a cobranças, assinaturas, links, webhooks e outros endpoints Asaas. O projeto deve ser revisado quanto à manutenção, autenticação, tipagem de valores, paginação, tratamento de erros e eventos atuais. A documentação oficial do Asaas é a referência de verdade para contratos e webhooks. [F8]

**Vantagens:** segundo provedor conhecido, demonstra que adaptadores não dependem da Efí, facilita testar matriz de capacidades e evoluções multi-tenant.

**Problemas:** não oficial; cobertura declarada pode atrasar mudanças do PSP; erros do SDK podem se refletir em baixas erradas, e recursos de emissão de NFS-e do Asaas não equivalem a NFCom de telecomunicação.

**Decisão:** só ativar depois da Efí homologada; preferir SDK após revisão ou cliente HTTP próprio fino para endpoints efetivamente usados. Não delegar regras de negócio de faturas a abstrações do SDK.

### 4.5 Cobranca-API — candidato experimental a adaptador de bancos brasileiros

**Fonte:** <https://github.com/Maxwbh/cobranca-api> [F9]. API REST em Python que declara integrações online para C6/Sicoob/Inter e Itaú em estágio condicionado, mais geração offline por uma engine própria, CNAB 240/400, OFX e webhook. A documentação contém grande variedade de funcionalidades e benchmarks/testes **declarados pelo mantenedor**; não há auditoria independente realizada neste relatório.

**Vantagens:** formato REST consumível diretamente de Go, empacotamento em container, ideias de matriz de bancos × funcionalidades, diferenciação entre online e offline, CNAB, validação de boleto e OFX.

**Problemas críticos:** projeto ainda pequeno, maturidade externa não comprovada, serviço adicional com dados pessoais sensíveis, cofre de credenciais e criptografia a serem auditados, mudanças de API, cobertura declarada variável, risco de validação insuficiente de entrada, concorrência e carteira, dependência do mantenedor. Um boleto gerado offline é **artefato para a remessa/homologação**, não prova de registro bancário e não deve ser tratado automaticamente como pagável ou conciliável.

**Decisão:** ambiente isolado sem dinheiro real, dados sintéticos e testes de segurança; se aprovado, usar como serviço auxiliar privado para capacidades sem bom cliente Go. **Não** torná-lo fonte primária de faturas/pagamentos nem permitir acesso externo direto aos seus endpoints.

### 4.6 Projetos adicionais para comparação e inspiração

- **Laravel Boleto** (<https://github.com/eduardokum/laravel-boleto>): PHP, MIT, geração de boletos/remessas/retornos; estudar convenções bancárias e testar antes de tratar como runtime permanente. [F10]
- **BoletoNetCore.PDF/QuestPdf:** bibliotecas complementares de apresentação e PDFs, sem substituir registro/recebimento bancário.
- **API Pix BACEN** (<https://github.com/bacen/pix-api>): referência de especificação e semântica, **não** um gateway de pagamento instalável. [F11]
- **APIs oficiais Inter, Sicoob, Sicredi, Bradesco, Santander etc.:** quando existirem contrato e homologação, preferir integração direta ou clientes específicos. A API de Cobrança do Inter atual é V3; a V2 foi descontinuada em 4/5/2026. [F12]
- **OCA `l10n-brazil`/Odoo:** referência para processos fiscais e contábeis, sujeito a licença; não é um backend financeiro plug-and-play em Go.

### 4.7 Matriz de decisão por finalidade

| Necessidade | Primeira opção | Reserva | O que precisa ser provado |
|:--|:--|:--|:--|
| Primeiro Pix/boleto real | Efí SDK oficial/API | Asaas API oficial + cliente Go | Sandbox, cobrança, webhooks, reconciliação |
| Segundo PSP | Asaas API | Outra API direta | Independência real do primeiro PSP |
| Boletos e remessa CNAB | ACBr ou BoletoNetCore (escolher UM) | Implementação controlada por banco | Banco, carteira, homologação, retorno |
| Banco Inter direto | Inter Cobranças V3 | Serviço bancário auditado | mTLS, convênio, endpoints vigentes |
| APIs multi-banco Python | Cobranca-API após auditoria | Adaptadores Go finos | Segurança, maturidade, consistência |
| Documentação normativa Pix | BACEN Pix API | Documentos oficiais do PSP | Versões e suporte contratual |
| NFCom/fiscal | Conector fiscal específico e homologado | Motor próprio somente com justificativa | Certificados, contingência, legislação |

**Linguagem não é o critério soberano.** A escolha deve maximizar conformidade, cobertura dos bancos que os ISPs usam, rastreabilidade, facilidade de atualização, compatibilidade do licenciamento e confiabilidade. Uma biblioteca Go conveniente, mas sem testes, pode ser inferior a uma solução .NET/Pascal madura; um serviço auxiliar só se justifica quando seu ganho supera a complexidade operacional.


### 4.8 — Seleção das instituições do primeiro ciclo (P1 comercial) [A20]

**Não há ranking universal de "mais fácil".** Avaliar por prova de conceito e custo: tempo de cadastro PJ, habilitação de produção, documentação, OAuth versus chave, necessidade de certificado, exigência de convênio, disponibilidade de boleto registrado, QR dinâmico, `cobv`, Pix Automático, webhooks, endpoints de recebidos, histórico/extrato, APIs de cancelamento, limites, taxas efetivas e suporte. Candidatos iniciais: Efí (primeira integração), Asaas (cobranças e recorrência), Mercado Pago (autorização OAuth), PagBank (Connect e homologação), Woovi/OpenPix (Pix especializado). Inter/Sicredi/Sicoob passam à frente quando o piloto tiver conta e convênio ali. Não presumir que a integração PagBank esteja imediatamente ativa: a documentação exige homologação para integrações diretas, salvo exceções para plataformas/módulos.

**Critério de aceite:** matriz por PSP com evidências de sandbox e de produção, produtos realmente habilitados e custo por cenário; nenhum resultado baseado exclusivamente em marketing.



## 5. Arquitetura recomendada em camadas {#cap05}

```text
Portal assinante / Painel React
          |
       API Go (identidade, autorização, tenant e empresa faturadora)
          |
   Domínio financeiro NexoISP (fonte da verdade)
   | contratos | competências | faturas | cobranças |
   | pagamentos | alocações | devoluções | conciliação |
          |
    River/outbox/inbox/observabilidade
          |
  Payment Orchestrator (Go, adaptadores com capacidades)
  | Efí | Asaas | Inter V3 | CNAB (via serviço opcional) |
          |
     PSP / banco da conta do provedor
          |
      Webhook autenticado -> inbox durável -> reconciliador
          |
     Baixa confirmada -> evento comercial -> serviço de rede
          |
       (suspensão/reativação confirmada, ou pendência)
```

**Fonte da verdade interna** não significa que o NexoISP inventa liquidação; o banco/PSP é fonte externa autoritativa sobre pagamentos efetivamente recebidos. O sistema mantém seu estado local e resolve divergências a partir de evidência autenticada. Nunca transformar 'HTTP 200 emissão' em 'pago'.

### 5.1 Contratos de adaptadores e matriz de capacidades

Um `PaymentProvider` precisa oferecer criação, consulta e normalização de cobranças e pagamentos. Funcionalidades opcionais devem ser anunciadas por capacidades. Não obrigar todos os bancos a suportar cancelamento, devolução, emissão de boleto, Pix Automático, conciliação ou CNAB pelo mesmo método genérico. Tipos monetários devem usar centavos inteiros ou decimal explícito, **nunca float binário para valores persistentes**.

```go
// Exemplo conceitual: não é código extraído do repositório.
type Capabilities struct {
    PixCharge       bool
    Boleto          bool
    HybridBoletoPix bool
    PixAutomatico   bool
    Refund          bool
    Statement       bool
    CNAB240         bool
    CNAB400         bool
}

type CreateChargeInput struct {
    TenantID        string
    ConnectionID    string
    InvoiceID       string
    IdempotencyKey  string
    AmountCents     int64
    Currency        string // "BRL"
    DueDate         string // AAAA-MM-DD: fuso do contrato
    Method          string // PIX, BOLETO ou HYBRID
}

type PaymentProvider interface {
    Name() string
    Capabilities() Capabilities
    CreateCharge(context.Context, CreateChargeInput) (ChargeResult, error)
    GetCharge(context.Context, string) (ChargeResult, error)
    NormalizeEvent(context.Context, []byte, EventHeaders) (ProviderEvent, error)
}
```

`CancelCharge`, `RefundPayment`, `GetStatement`, `CreateAutomaticAuthorization` etc. entram em interfaces complementares e somente nos conectores que as implementarem. O adaptador não deve executar SQL no banco do cliente nem decidir bloqueio PPPoE; é uma tradução entre domínio do NexoISP e fornecedor financeiro.

### 5.2 Por que separar fatura, cobrança, pagamento e liquidação

- **Fatura:** direito de cobrar pelo serviço, baseado no contrato e na competência.
- **Cobrança:** instrumento de pagamento emitido, por exemplo boleto, Pix ou link. Uma fatura pode ter mais de uma tentativa, mas controles devem impedir cobrança indevida duplicada.
- **Pagamento:** fato externo confirmado, sujeito a confirmação, estorno/devolução e alocação.
- **Alocação:** quanto daquele pagamento quita quais títulos, considerando antecipação/parcialidade.
- **Liquidação/disponibilidade:** quando e quanto foi efetivamente creditado, após tarifas/descontos quando aplicáveis; nem sempre coincide com confirmação do pagamento.
- **Evento:** informação auditável recebida/consultada que sustentou a mudança de estado.
- **Estorno/devolução:** operação específica com efeito financeiro contrário; não apagar o registro do pagamento original.

### 5.3 Estados internos recomendados

**Fatura:** `DRAFT -> OPEN -> PARTIALLY_PAID -> PAID`, com ramos `OVERDUE`, `CANCELLED`, `DISPUTED`. Atraso é uma projeção temporal, não necessariamente um evento bancário. Uma fatura `PAID` com devolução pode voltar a apresentar saldo devedor mediante evento contábil explícito; não editar silenciosamente o passado.

**Cobrança:** `REQUESTED -> SUBMITTED -> REGISTERED/AVAILABLE -> EXPIRED/CANCELLED/FAILED`, além de `UNKNOWN` para timeout incerto; consultar o PSP antes de repetir criação. Para Pix dinâmico, separar vencimento/exibição da existência do título.

**Pagamento:** `REPORTED -> VERIFIED -> ALLOCATED`; `REFUND_REQUESTED -> REFUNDED` se aplicável. `REPORTED` por webhook ainda não autenticado não habilita serviço. Modelar conciliação, contestação, recebimento em duplicidade e estorno conforme métodos.

### 5.4 Regras de idempotência

- Chave de criação de cobrança por `tenant_id + connection_id + invoice_id + tentativa lógica`, persistida antes da chamada externa.
- `UNIQUE(connection_id, external_charge_id)` e `UNIQUE(connection_id, external_event_id)` onde houver IDs estáveis.
- `UNIQUE(tenant_id, invoice_id, billing_cycle)` nos contextos em que a geração por competência deve ser única, respeitando o modelo existente.
- Inbox do webhook com status `received/validated/pending/processed/rejected`, hash do payload, timestamp e motivo do erro.
- Outbox transacional para eventos internos de negócio; efeitos externos reexecutáveis de forma idempotente.
- Estados e transições via transação, versão otimista/locks curtos e restrições SQL, nunca via `SELECT` seguido de `INSERT` desprotegido em concorrência.
- Processamento de eventos fora de ordem deve consultar estado atual e sequência do PSP quando disponível.


## 6. Webhooks: o ponto de maior risco de integridade {#cap06}

A documentação do Asaas define entrega **at least once**: o mesmo evento pode ser entregue repetidamente. Recomenda persistir o ID e não repetir efeitos, verificar o token do header `asaas-access-token`, responder HTTP **200** após persistência e processar depois em fila. Informa ainda a possibilidade de pausa após falhas consecutivas e janela limitada de retenção de eventos. [F8]

### 6.1 Pipeline de recepção obrigatório

1. Resolver a conexão financeira via identificador opaco na rota/assinatura; não por tenant informado no corpo.
2. Validar método, tamanho, Content-Type, origem lógica e credencial conforme capacidade do PSP (assinatura, token, mTLS, allowlist apenas complementar).
3. Checar se a conexão pertence ao tenant e está habilitada.
4. Gravar o payload bruto de forma criptografada ou com retenção e acesso restritos, hash, cabeçalhos permitidos, IDs e hora de recebimento.
5. Garantir unicidade do identificador de evento dentro da conexão; ao receber repetição, confirmar sem reaplicar.
6. Responder imediatamente de acordo com o contrato de cada fornecedor (Asaas exige HTTP 200; não assumir que todos funcionem igual).
7. Worker River processa inbox; normaliza evento, vincula cobrança, confirma valores/moeda/destinatário.
8. Se houver dúvida, consultar endpoint do PSP, registrar divergência e aguardar tratamento; não dar baixa por heurística de CPF, nome ou valor isolado.
9. Aplicar alocação transacional, emitir evento comercial e auditar causa/correlação.
10. Reconciliar periodicamente títulos e pagamentos sem evento; ter ferramenta segura de replay e fila morta (DLQ operacional).

### 6.2 Cenários adversos que precisam ser testados

- O mesmo webhook chega 10 vezes.
- O pagamento é confirmado antes de recebermos a resposta de criação da cobrança.
- Webhook do provedor A usa ID igual ao webhook do provedor B.
- Evento confirmado chega após o cancelamento local de uma cobrança.
- Evento antigo chega depois de um evento de devolução.
- Falha ao gravar evento, falha após gravar e antes do ACK, falha após commit antes do job.
- PSP fica fora do ar; criação resulta em timeout, mas o banco registrou o título.
- Certificado é revogado ou expirado.
- Webhook de tenant A é endereçado à URL de tenant B.
- Valor, moeda, conta recebedora ou `txid` não conferem.
- Dois workers processam o mesmo evento em paralelo.
- Reprocessamento manual tenta alterar uma fatura quitada.
- PSP anuncia estado que conflita com histórico local ou com a conciliação.
- Depois de migração de célula, um PSP ainda chama o endpoint antigo.


### 6.3 — Entrada de webhooks Pix: mTLS, origem e roteamento (P0) [A03]

**Correção:** TLS com autenticação de cliente ocorre antes de o servidor conhecer o caminho HTTP; assim, definir terminação de mTLS no ingress com hosts/certificados/CA de clientes adequados, ou CA pool e identificação segura por perfil, e depois verificar a conexão financeira a que o evento pertence. Não confiar em headers de certificado fornecidos por clientes externos. Caso o fornecedor permita `skip-mTLS`, isso é exceção configurada com controles alternativos documentados, preferindo autenticação de mensagem robusta quando disponível, allowlist como defesa adicional, identificador segredo de rota e consulta independente da API autenticada para confirmar os efeitos financeiros. **Um segredo/HMAC incluído apenas na URL não é uma assinatura criptográfica do corpo da mensagem.**

**Critério de aceite:** callback sem origem autenticada não quita título; callback com rota de um tenant e identificador de outro é rejeitado; falhas de ingestão são recuperáveis por polling/reconciliação.


### 6.4 — Simulador determinístico de PSP (P0) [A04]

Aproveitar o modo demonstrativo já documentado no NexoISP como *driver de testes*, mantendo-o absolutamente separado do ambiente produtivo. Cenários: evento duplicado 10 vezes, evento fora de ordem, webhook atrasado, API com timeout após cobrança realmente criada, API 429, queda do banco, expiração de token, inversão de baixa e estorno, notificações cruzadas entre tenants, diferença entre valor pago e valor devido e PSP fora do ar.

**Critério de aceite:** cenários reproduzíveis por seed/fixtures, execução rápida em CI, invariantes de nenhuma duplicação de emissão/baixa e nenhum vazamento de tenants; testes sandbox reais separados do CI diário.



## 7. Pix: cobrança, vencimento, confirmação e devolução {#cap07}

Pix é um **arranjo de pagamento**, não um equivalente genérico de 'transferência instantânea sem tarifas'. A API Pix do Banco Central é especificação OpenAPI e remete regras de segurança a manuais próprios. A oferta de funcionalidades depende do contrato com o PSP recebedor. [F11]

### 7.1 Funcionalidades para o primeiro lançamento

- Criar cobrança Pix dinâmica com referência de fatura e `txid` rastreável, respeitando limite e regras do PSP.
- Apresentar QR Code e Pix copia-e-cola em portal e painel.
- Consultar cobrança, acompanhar pagamento e saldo devido.
- Reconhecer pagamento parcial/maior somente se a modalidade e o PSP suportarem; não inventar comportamento uniforme.
- Associar `endToEndId`, `txid`, ID externo, montante, recebedor e data a registros de pagamento com acesso restrito.
- Tratar vencimento, expiração da apresentação e possibilidade de segunda via.
- Registrar devolução, cancelamento, ajustes e eventual mecanismo especial de devolução dentro dos fluxos e normas aplicáveis.
- Implementar tela de divergência, conciliação e trilha de auditoria.

### 7.2 Pix Automático é outro produto

O Pix Automático exige autorização prévia do pagador e gestão do mandato/recorrência. O Banco Central descreve jornada de contratação com instituição participante, configuração da recorrência, obtenção de autorização do pagador e programação de cobranças. Não basta gerar Pix mensal com o mesmo QR Code. O recebedor pode ser tarifado. [F13][F14]

Modelar `authorization_id`, estado da autorização, limites autorizados, periodicidade, data de vigência, suspensão, cancelamento, tentativas e histórico de cobranças da recorrência. Uma cobrança individual por ciclo ainda precisa de competência e idempotência. Prever cancelamento da autorização pelo pagador no banco, inclusive sem comunicação imediata ao NexoISP. Módulo P1/P2, após Pix comum homologado.


### 7.3 — Adaptador genérico da API Pix BCB (P1) [A01]

**Concordância com ajuste:** a especificação OpenAPI do BCB deve ser usada não apenas como leitura: criar um cliente Go tipado e um *perfil de PSP* para os provedores de serviços de pagamento que de fato exponham endpoints compatíveis. O BCB publica o contrato, mas não é um servidor que emite cobranças nem garante que todos os bancos ofereçam todos os métodos, versões e opções. Os perfis diferenciam URL, OAuth/mTLS, certificados, escopos, idempotência, limites, campos extras, cobranças com vencimento, webhooks e paginação.

**Critério de aceite:** mesma interface interna integra dois PSPs com API Pix compatível usando perfis separados, sem branches bancários nos handlers de faturas. Comandos não suportados retornam `UnsupportedCapability` e não simulam êxito. Usar OpenAPI versionada e pinada; geração de cliente não substitui validação dos dados recebidos e diferenças do PSP.


### 7.4 — `cobv`, `cob`, BolePix e recorrência (P0) [A02]

**Regra proposta:** para mensalidades com vencimento, preferir Pix `cobv` quando disponível; `cob` permanece disponível para pagamentos imediatos, segunda via e situações sem suporte a `cobv`. BolePix deve ser tratado como *uma dívida com alternativas de liquidação*, não como duas faturas independentes. O motor deve coordenar a baixa e a indisponibilidade/cancelamento da outra modalidade quando uma for paga, conforme contrato do fornecedor e regras Pix aplicáveis. Registrar pagamento duplicado de fato, inclusive se uma instituição não efetivar o cancelamento tempestivamente.

**Regulação nova:** a atualização do Pix anunciada pelo BCB em setembro de 2026 trata da cobrança híbrida e de mecanismos contra dupla liquidação. Validar cronograma e suporte específico do PSP antes de marcar um BolePix como homologado. Não presumir cálculo universal de juros/multa ou pagamento pós-vencimento idêntico em cada fornecedor.

**Critério de aceite:** o mesmo título pode ser pago por Pix ou boleto e chega a quitado apenas uma vez; o segundo recebimento, caso ocorra, vira pagamento excedente a conciliar ou devolver conforme política, com auditoria completa.


### 7.5 — Pix por Open Finance e Pix Automático (P2; modelo de dados antecipado) [A19]

Adotar pagamento com redirecionamento bancário quando o PSP oferecer o produto e o provedor contratar a funcionalidade. O NexoISP recebe o status por callback + consulta, sem armazenar credenciais bancárias do assinante. Para Pix Automático, preparar autorizações, regras de valor máximo, periodicidade, estados de revogação, contratos vinculados e eventos de recorrência. **Pix Automático é produto separado de Pix com vencimento**, depende de prestador habilitado e consentimento válido. O BCB descreve a autorização única para recorrência, com gestão pelo pagador.

**Critério de aceite:** modalidade ausente fica oculta/indisponível sem quebrar o pagamento convencional; autorização revogada impede novas cobranças sob aquele mandato.



## 8. Boleto registrado, boleto híbrido, CNAB e OFX {#cap08}

### 8.1 O que 'gerar boleto' significa

Há pelo menos quatro etapas diferentes: (a) gerar dados e layout de boleto; (b) registrar a cobrança no banco via API ou remessa; (c) disponibilizar documento/linha digitável pagável conforme regras do banco; (d) receber confirmação/retorno bancário e conciliar. **Gerar um PDF não substitui registro obrigatório nem confirmação de pagamento.** O status 'registrado' só pode surgir de confirmação aceita pelo banco/PSP.

### 8.2 Particularidades a modelar

Banco, agência, conta, convênio, carteira, modalidade, código do cedente, nosso número, fator vencimento conforme regras vigentes, dígito verificador, protesto, negativação, desconto, juros, multa, instruções, alteração/cancelamento, identificação do pagador, endereço e retorno. Nunca presumir que um layout CNAB 240 de um banco é compatível com CNAB 240 de outro sem homologação.

### 8.3 Fluxo CNAB seguro

1. Gerar lote determinístico para `tenant_id + conta/carteira + data + sequência`.
2. Selecionar somente cobranças aptas e bloquear duplicação de remessa.
3. Produzir arquivo com hash, contagem, soma total, versão do layout, banco/carteira e registro de quem aprovou.
4. Submeter por canal autorizado (portal/SFTP/API, de acordo com banco).
5. Registrar protocolo/recibo, não presumir aceitação com envio.
6. Importar retorno original em área segregada e guardar hash/versão.
7. Parsear e validar tipo de registro, sequências, soma, carteira e vínculo com cobrança.
8. Reconciliar ocorrências rejeitadas, registradas, liquidadas, canceladas e alterações com tratamento específico.
9. Não baixar por coincidência de valor, pagador ou número de documento sem identidade bancária suficiente.
10. Permitir reimportação idempotente e auditoria de registros rejeitados.

### 8.4 OFX/extrato

OFX é entrada útil para investigar recebimentos, tarifas e transferências, mas não deve servir isoladamente como prova de liquidação de uma cobrança quando faltam identificadores confiáveis. Conciliação exige cruzamento com cobranças, retorno, extrato bancário e regras do prestador. Movimentos sem correspondência devem aparecer como 'não conciliados'. Exportar extratos de forma controlada, com proteção LGPD e retenção limitada.

### 8.5 Quando usar ACBr, BoletoNet ou Python

Se o primeiro gateway cobre Pix e boleto registrado em API, **não adicionar CNAB antes da demanda real**. Quando surgir carteira bancária sem boa API, comparar um banco específico em ACBr, BoletoNetCore e Cobranca-API; escolher a implementação com teste/carteira homologados, licença operacional compatível, manutenção previsível, formato de deploy e evidência de retorno. Não implantar três motores de boleto concorrentes só para possuir 'mais opções'.


### 8.6 — Carnê anual (P1) [A08]

Gerar lote de 6/12 competências com calendário e vencimentos configurados, opção boleto/BolePix conforme PSP, versões individuais e arquivo de impressão; emissão antecipada deve respeitar renegociações, descontos, cancelamentos, alteração de contrato e custo por emissão. PDF não equivale a título registrado.

**Critério de aceite:** nenhum boleto aparece como registrado sem confirmação externa; alteração do contrato apresenta títulos já emitidos que exigem tratamento específico; importação/geração em lote é recuperável.



## 9. Segurança SaaS e controles internos do financeiro {#cap09}

### 9.1 Tenant/RLS não basta por si só

RLS protege consultas SQL quando papel, política e contexto transacional são corretamente aplicados. Mas segredos em cache, jobs sem tenant, webhooks, buckets, URL assinada, logs, traces, métricas, arquivos CNAB e chamadas HTTP externas podem vazar dados mesmo que SQL esteja correto. Todos precisam de identidade forte de conexão financeira e segregação transversal.

### 9.2 Segredos e certificados

- Guardar `client_secret`, API token, chave privada PFX/PEM e webhook token criptografados com envelope por ambiente/tenant, idealmente via KMS/Vault quando justificável.
- Chave de criptografia nunca no mesmo backup simples do banco; reter política de rotação, versões e recuperação.
- Decriptar somente no momento de chamada, no escopo da conta autorizada, e eliminar referência em logs/erros.
- Não permitir que suporte SaaS visualize segredos em texto, nem copie a chave do tenant sem processo explícito e auditado.
- Certificados devem ter expiração monitorada e janela de renovação; sandbox e produção sempre separados.
- Evitar conversão de PFX para PEM com senha vazia em caminhos permanentes sem controles compensatórios; exemplos públicos não são política de produção.
- HTTPS/mTLS para PSP, backends auxiliares privados e serviços CNAB expostos internamente quando cabível.

### 9.3 Permissões granulares

Separar funções: configurar conexão bancária, cadastrar recebedor, visualizar cobranças, emitir, baixar manualmente, importar CNAB, aprovar estorno, devolver Pix, alterar regras comerciais, reprocessar webhooks e acessar auditoria. Em valores elevados, exigir duas aprovações e trilha de justificativa. Não deixar um operador criar conta bancária, emitir cobranças e aprovar transferência/estorno sem controles.

### 9.4 Auditoria imutável e observabilidade

Capturar `actor`, `tenant_id`, `billing_entity_id`, `connection_id`, `request_id`, ação, estado anterior/novo, data, origem, hash e justificativa — sem CPF integral, token ou certificado em logs comuns. Usar trilha append-only para fatos financeiros e revisão de permissões de suporte. Métricas úteis: idade de webhooks não processados, pagamentos sem alocação, cobranças em estado desconhecido, divergência de saldos, erros por banco, expiracão de certificados e fila por tenant.

### 9.5 LGPD e responsabilidades

Os ISPs que determinam finalidades e meios de cobrança tenderão a ser controladores e a plataforma, em muitos fluxos, operadora, conforme papéis efetivos e contratos. Essa é análise contratual específica: o fato de usar SaaS não define automaticamente o papel jurídico em todos os tratamentos. Política de retenção, logs de suporte, suboperadores PSP/hosting, base legal, incidentes, exportação e exclusão/anônimização precisam de revisão jurídica. [F15]


## 10. Contabilidade, extrato e integridade monetária {#cap10}

### 10.1 Decimal e rounding

Adotar `BIGINT amount_cents` para BRL ou decimal de precisão fixa quando necessário; jamais `float32/float64` para saldo persistido. Definir arredondamento em cálculo pró-rata, descontos, multa e juros por item e por documento. Usar SQL `numeric` quando couber, com funções testadas e reconciliação de totais. Tempo e fuso: vencimento jurídico geralmente é data local; webhooks têm timestamps com fuso; não transformar data de vencimento em instante UTC arbitrário.

### 10.2 Livro de movimentos e event sourcing parcial

Não é obrigatório reescrever todo o NexoISP em event sourcing. Para operações financeiras novas, vale preservar um **livro de movimentações append-only** com ajustes compensatórios, vínculo ao evento origem e reconciliação; o saldo das faturas deve ser projeção ou resultado derivado verificável. Não sobrescrever `paid_amount` sem evidência de quem/como mudou. Diferenciar recebimento bruto, tarifa, taxa bancária, desconto e valor líquido creditado.

### 10.3 Diferença entre integração de cobrança e contabilidade

Gerar CSV não é contabilidade fiscal completa. DRE, contas a pagar, baixa contábil, centro de custos e fechamento precisam de modelagem separada. Emissão de NFCom não é boleto e boleto não é nota fiscal. A NFCom modelo 62 tem regras próprias; em Pernambuco, o decreto estadual prevê obrigatoriedade a partir de 1/11/2025 nas condições aplicáveis. Validar legislação de cada UF e regime tributário com contador/especialista, sem derivar fiscal diretamente do status bancário. [F16]


### 10.4 — Pix recebido em chave estática e comprovantes pelo WhatsApp (P1) [A06]

Criar a **caixa de conciliação assistida**: listar recebimentos efetivos pelo endpoint de Pix recebidos ou extrato quando a conta/PSP permitir, cruzar referências, valor, intervalo de data, identificação do pagador disponível e faturas candidatas. Apresentar score e motivo da sugestão sem executar baixa automática por heurística. O comprovante enviado pelo cliente é um elemento de atendimento, **não prova suficiente** de liquidação; pode ser falso ou de outra conta. Preferir consulta autenticada ao PSP e conciliação por identificador/valor.

**Critério de aceite:** operador consegue aplicar vínculo confirmado com um clique e justificativa; pagamento ambíguo não quita automaticamente; recebimento sem correspondência fica em pendência e não desaparece.



## 11. Acoplamento financeiro e rede: ISP não é e-commerce comum {#cap11}

Um ERP ISP precisa ligar dívida à política de acesso sem confundir estados comerciais, financeiros e técnicos. A arquitetura do NexoISP já separa intenção de operação e estado observado da rede. [F1]

**Fluxo recomendado:** banco confirma pagamento → evento é autenticado/conciliado → fatura recebe alocação → política comercial reavalia atraso do contrato → estado desejado de acesso muda → operação de rede é enfileirada → equipamento confirma (ou fica pendente/incerto) → interface mostra ambos os fatos.

Falhas relevantes: pagamento confirmado, mas RADIUS offline; notificação de pagamento tardia após suspensão; recebimento parcial insuficiente para desbloqueio; renegociação com exceção comercial; assinante com múltiplos contratos e diferentes títulos; falha de autenticação técnica sem dívida; pagamento revertido após reativação; bloqueio indevido por atualização duplicada. Nunca reexecutar comandos de equipamento porque um webhook financeiro foi reenviado. Uma operação comercial deve ter identidade e versão próprias.


### 11.1 — Desbloqueio em confiança (P1) [A10]

Permitir benefício opcional por provedor, contrato e critérios: prazo máximo, quantidade em janela móvel, histórico, elegibilidade, fraude/abuso, termos e autorização. Implementar por **intenção de rede** com confirmação posterior do concentrador, não por simples troca de booleano. Caso a rede não confirme, exibir pendência ao assinante e ao NOC. Após expiração, reavaliar inadimplência antes de qualquer alteração.

**Critério de aceite:** um contrato não aciona desbloqueios ilimitados por chamadas concorrentes; ações são auditáveis; recusa/erro da rede não aparece como desbloqueio efetivo.



## 12. Modelo de dados sugerido {#cap12}

As tabelas abaixo são **propostas de modelagem**; devem ser reconciliadas com migrations e tabelas existentes antes de escrever novas migrations. Evitar nomes duplicados e duas fontes de verdade.

| Entidade/tabela conceitual | Chaves principais e finalidade |
|:--|:--|
| `billing_entities` | CNPJ/empresa faturadora, domicílio fiscal e configuração por tenant |
| `payment_connections` | tenant, empresa, PSP/banco, ambiente, estado, capacidades, referência segura a segredo |
| `bank_accounts` | conta recebedora, agência, carteira/convênio, validade, sem guardar credenciais no texto |
| `invoice_charges` | fatura, método, tentativa, chave idempotente, ID externo, valor, vencimento, status |
| `external_payment_events` | conexão, ID evento, tipo, hash, recebido/processado, payload com retenção |
| `payment_receipts` | pagamento externo confirmado, E2E/TXID quando aplicável, valor, data, fonte |
| `payment_allocations` | distribuição do recebimento por fatura/parcela e saldo residual |
| `refunds` | pedido/resultado de devolução, referência externa, motivo, estado, valor |
| `bank_statements` | extratos por conta e competência, origens API/OFX/CNAB |
| `statement_lines` | linha de extrato, id banco, bruto/líquido/tarifas, conciliação |
| `reconciliation_cases` | divergência, regra, evidência, responsável, decisão e histórico |
| `cnab_batches` | tenant, banco/carteira, layout, hash, total, sequência, estado, arquivo |
| `cnab_return_records` | retorno, ocorrência, vinculação, idempotência e erro |
| `pix_automatic_authorizations` | mandato, cliente, limites, periodicidade, autorização, cancelamento |
| `financial_audit` | eventos auditáveis append-only e operações manuais sensíveis |

### 12.1 Restrições imprescindíveis

`FOREIGN KEY` composto com tenant ou políticas equivalentes para impedir que cobrança A referencie fatura B. `UNIQUE` por tenant/conexão nos IDs externos. Checks de montantes não negativos onde fizer sentido, respeitando ajustes contábeis. Índices para vencimento/competência/status/conexão. RLS em todas as tabelas novas, inclusive histórico/auditoria e jobs correlatos. Registros financeiros não devem ser apagados fisicamente para 'corrigir' saldo; usar operações compensatórias.


## 13. API HTTP e contratos internos propostos {#cap13}

**Não são rotas confirmadas do repositório; são contratos candidatos**, a serem adaptados ao padrão Go já usado e ao inventário de endpoints existente.

| Método e rota conceitual | Ação | Permissão |
|:--|:--|:--|
| `GET /api/financeiro/conexoes` | Listar gateways/contas do tenant | finance:read |
| `POST /api/financeiro/conexoes` | Criar credencial por provedor/empresa | finance:connection:manage |
| `POST /api/financeiro/conexoes/{id}/testar` | Testar autenticação sem emitir cobrança | finance:connection:manage |
| `POST /api/faturas/{id}/cobrancas` | Solicitar emissão idempotente | finance:charges:create |
| `GET /api/cobrancas/{id}` | Estado, dados, QR/linha digitável | finance:read |
| `POST /api/cobrancas/{id}/cancelamento` | Cancelar onde permitido | finance:charges:cancel |
| `GET /api/pagamentos` | Pesquisar recebimentos | finance:read |
| `GET /api/conciliacao/casos` | Divergências | finance:reconcile:read |
| `POST /api/conciliacao/casos/{id}/resolver` | Resolver com justificativa | finance:reconcile:approve |
| `POST /api/financeiro/cnab/remessas` | Gerar arquivo para aprovação | finance:cnab:create |
| `POST /api/financeiro/cnab/retornos` | Importar e validar retorno | finance:cnab:import |
| `GET /api/financeiro/webhooks` | Saúde/falhas de eventos | finance:webhooks:read |
| `POST /api/financeiro/webhooks/{id}/reprocessar` | Replay auditado | finance:webhooks:retry |
| `POST /api/financeiro/pix-automatico/autorizacoes` | Iniciar autorização futura | finance:recurring:manage |
| `POST /webhooks/financeiro/{opaque_connection}` | Recepção externa do PSP | Credencial/assinatura do PSP |

### 13.1 Erros de API

Distinguir entrada inválida (`400/422`), sem permissão (`403`), conflito idempotente (`409`), fornecedor temporariamente indisponível (`503` ou erro interno com retry seguro), estado externo desconhecido (`202/pending` ou estado próprio sem perda) e evento rejeitado (`4xx`). Não vazar mensagem sensível do banco, CPF, token ou JSON bruto em resposta ao frontend. Padronizar `correlation_id` para suporte e auditoria.


## 14. Páginas e experiências do usuário {#cap14}

**Não criar todas como telas novas.** Primeiro mapear cada item abaixo à rota/componente v0 existente; completar ações operacionais e estados antes de duplicar UI. As páginas são um inventário-alvo, com listas, detalhes, permissões e critérios de funcionamento.

### 14.1 Administração do provedor

1. **Financeiro / Visão geral:** receitas, títulos abertos, atrasos, recebidos, a conciliar, repasses e alertas.
2. **Financeiro / Configurações:** política por empresa, competência, juros, multa, desconto, comunicação e conciliação.
3. **Contas e gateways:** lista de bancos, saúde, contas recebedoras, prioridade/padrão e ambiente.
4. **Adicionar conexão bancária:** assistente por fornecedor (Efí/Asaas/Inter/CNAB), credenciais e certificado protegidos, teste de conexão.
5. **Detalhe da conexão:** capacidade do banco, webhook, validade de certificado, último sucesso e última falha.
6. **Empresas faturadoras e carteiras:** relacionamento CNPJ-contrato-conta-carteira, sem mistura involuntária.
7. **Faturas:** filtros, competências, parcelamento, estado bancário e histórico.
8. **Detalhe da fatura:** itens, competência, cobranças emitidas, pagamentos alocados, divergências, notas e contrato.
9. **Emitir/reenviar cobrança:** método Pix/boleto/híbrido, valores, juros/multa e documento do PSP.
10. **Cobranças:** listas por registro, vencimento, tentativa, banco, retorno, falha e estado incerto.
11. **Detalhe de cobrança:** ID externo, tentativa idempotente, payload mascarado, QR e linha digitável, histórico de consulta.
12. **Recebimentos:** bruto, líquido, taxas, datas, método e origem.
13. **Conciliação:** automáticas conciliadas, a conciliar, divergentes, não identificadas e alocações parciais.
14. **Casos de divergência:** evidências internas/externas, comparação e decisão autorizada.
15. **Renegociação e acordos:** títulos vinculados, descontos, datas, riscos e histórico.
16. **Estornos/devoluções:** análise, motivo, aprovação, confirmação bancária e reabertura de saldo.
17. **Extratos e contas:** importação OFX/CNAB, consultas APIs, tarifas, exportação.
18. **CNAB remessas:** geração, prévia, totais, aprovação, download, envio e recibo.
19. **CNAB retornos:** upload, parser, conferência, erros e reprocessamento seguro.
20. **Pix Automático:** autorização, situação, recorrência e rastreabilidade, apenas quando contratado.
21. **Webhooks e integrações:** saúde, latência, histórico, tentativas, replay e filas pausadas.
22. **Relatórios:** inadimplência por período/POP, recebimentos por banco, aging, MRR, churn financeiro e conciliação.
23. **Auditoria financeira:** usuário, alteração, instituição, transição, justificativa e evidência.
24. **Fechamento de competência:** corte, totais, lançamentos pendentes, reabertura autorizada e trilha de alterações.
25. **Central de migração financeira:** importação de saldos/ID externo, equivalência com SGP/IXC e reconciliação pós-corte.

### 14.2 Portal do assinante

26. **Minhas faturas:** abertas, vencidas, quitadas e acordos válidos.
27. **Pagar agora:** Pix QR/cola, boleto PDF/linha digitável, atualização sem cobrança repetida.
28. **Histórico de pagamentos:** comprovantes e estado de conciliação, sem expor dados de terceiros.
29. **Gerenciar Pix Automático:** autorização e status, cancelamento orientado pelo PSP quando disponível.
30. **Negociar débito:** proposta comercial autorizada, simulação de valores e aceite.
31. **Comunicações:** segunda via, comprovante, aviso de vencimento, confirmação de pagamento e acessibilidade.

### 14.3 Operador SaaS

32. **Saúde financeira das células:** volumes, filas, taxa de falha por integração, capacidade e erros, sem acesso habitual a valores pessoais.
33. **Matriz de conectores:** versão, capacidade habilitada por banco, incidentes, changelogs e certificados prestes a vencer.
34. **Migração shared/dedicated:** plano, estado de corte, verificação pós-migração e webhook antigo.
35. **Limites/cotas por tenant:** requisições, jobs, relatórios, eventos e armazenamento.
36. **Acesso de suporte:** privilégio temporário, consentimento/base contratual, auditoria e mascaramento.

### 14.4 UX em cada tela

Cada tela deve cobrir estado vazio, carregando, erro, sem permissão, demo, sandbox, produção, operação em andamento, timeout incerto, sucesso autenticado, retry permitido, divergência e ação destrutiva com confirmação adequada. Não mostrar 'Pago' com base somente em retorno do botão ou em demo. Diferenciar explicitamente **registrado**, **pago**, **creditado**, **conciliado** e **reativação técnica pendente**.


### 14.5 — Caixa físico, caixa por operador e cobrador externo (P1) [A07]

Entidades sugeridas, condicionadas à migração existente: sessão de caixa, abertura/fechamento, terminal, operador, recebimento em dinheiro, sangria, reforço, divergência, transferência de posse, prestação de contas e trilha de aprovação. Um recebimento de caixa é diferente de um Pix liquidado e de dinheiro depositado no banco. Criar permissões para gestor conferir o fechamento sem permitir ao operador aprovar a própria divergência.

**Critério de aceite:** fechamento reproduz movimentação e saldo esperado; lançamento cancelado gera contrapartida auditável, nunca exclusão invisível; cobrador não acessa carteira de outros operadores sem permissão.


### 14.6 — Régua de cobrança (P0) [A09]

Motor configurável por tenant para D-3, D0, D+1, D+5, pré-bloqueio e outros marcos. Usar templates aprovados e integrações legítimas de WhatsApp Business, SMS e e-mail; registrar consentimento/base legal, horário de envio, opt-out quando aplicável, custo e falhas. Verificar o estado mais atual do título no instante do envio, cancelar ações pendentes após pagamento e respeitar renegociação/prazo concedido. Integrar mensagens e segunda via ao atendimento/ISPAgent somente por API autenticada com permissões e trilha de auditoria.

**Critério de aceite:** cliente já quitado não recebe cobrança agendada depois da confirmação; falha do canal não suspende o financeiro; réguas separadas por tenant e sem envio cruzado.


### 14.7 — Negativação, SPC/Serasa e protesto (P2) [A11]

Criar módulo de integração e acordos, incluindo validação da dívida, contestação, comunicação, inclusão, retirada, baixa após regularização, arquivos e evidências, observando normas legais e contratos com fornecedores. Não confundir parâmetro 'protestar boleto' com adesão a uma integração específica de negativação.

**Critério de aceite:** inclusão/baixa têm estado externo confirmado, autorização e logs; título contestado segue política que impede ação indevida; cobranças renegociadas são conciliadas antes de enviar informações ao bureau.


### 14.8 — Central de ativação bancária (P0 com primeiro PSP) [A15]

Oferecer wizard visível ao ISP: escolher instituição → requisitos PJ → solicitação de convênio/carteira quando houver → concessão de autorização/chave/certificado → teste autenticado → confirmação de titularidade e recebedor → emissão teste → webhook/polling → homologação/ativação. Estados separados para `conta pendente`, `API não habilitada`, `credenciais inválidas`, `convênio pendente`, `sandbox OK`, `produção bloqueada`, `webhook pendente`, `homologado`, `suspenso`. Transparência sobre qual parte depende do NexoISP ou do banco.

**Critério de aceite:** um provedor consegue compreender por que a conexão não está ativa sem abrir chamado; credenciais não aparecem em logs ou interface; titularidade e CNPJ recebedor são confirmados por evidência disponível no PSP ou por procedimento manual quando API não expõe confirmação suficiente.


### 14.9 — OAuth, API key e certificados (P1 conforme segundo PSP) [A16]

Perfis de ativação: (1) OAuth com `state`, scopes mínimos, PKCE quando suportado, callback e rotação/revogação de tokens; (2) API key colada uma única vez no cofre e teste de permissão; (3) certificado+convênio para bancos. O Mercado Pago documenta OAuth para autorizar acesso a recursos de vendedores; o PagBank possui o Connect Authorization, que também concede autorização por redirecionamento. OAuth não garante que boleto, Pix, extratos e recorrência estejam disponíveis ao mesmo tempo: cada módulo exige ensaio por escopo e produto.

**Critério de aceite:** autorizador da conexão vê instituição e permissões; tokens podem ser revogados/renovados e não atravessam tenants; erro de acesso é reportado sem bloquear o financeiro de outros provedores.


### 14.10 — F1 enxuto: oito fluxos de interface (sem perder o inventário completo)

Tratar as áreas a seguir como *fluxos/telas*, não necessariamente oito URLs novas. Reusar UI oficial v0 e formulários atuais. Não recriar telas integradas que já existem.

| Área | Primeira entrega concreta | Critério de aceite |
|---|---|---|
| Conexões/Ativação | cadastro, credenciais, estado da homologação, teste e titularidade | a conta ativa em produção recebe em empresa correta |
| Fatura e cobrança | boleto, Pix/BolePix, segunda via, histórico e estado | um título ↔ cobranças externas sem duplicação |
| Recebimentos | eventos, alocação em faturas e estornos | pagamento confirmado gera baixa única |
| Conciliação e divergências | consulta PSP, Pix estático suspeito, saldo e aprovações | operador trata pendências, sem baixa heurística |
| Webhooks e operações | eventos, autenticação, falhas, replay e polling | eventos repetidos não geram efeitos repetidos |
| Régua de cobrança | regras por tenant, templates, canais e suspensão de envio | não cobrar após baixa confirmada |
| Portal pagar agora | Pix, boleto, status e prova de pagamento | assinante vê estado real, nunca êxito presumido |
| Caixa | dinheiro, operador, sangria, fechamento e auditoria | saldo apurado confere e divergência é explicável |

Na migração de um provedor existente, **a importação/controle de legados é um processo P0 transversal**, mesmo que não tenha tela independente no F1; pode ser realizada inicialmente em painel administrativo restrito com relatório importador.



## 15. Plano de trabalho completo e ordenação por dependências {#cap15}

### Etapa 0 — Auditoria de aderência no repositório

- [ ] Fixar SHA do repositório e versão de documentação de início da tarefa.
- [ ] Localizar migrations/tabelas existentes de fatura, pagamento, evento, gateway e conciliação.
- [ ] Identificar handlers, jobs River, permissões e telas correspondentes (sem duplicar módulos).
- [ ] Descrever contrato atual de gateway `none/demo` e extensão mínima necessária.
- [ ] Identificar padrão de `tenant_id` e RLS no SQL e no trabalho assíncrono.
- [ ] Documentar estrutura atual de auditoria, criptografia e notificações.
- [ ] Registrar gaps reais em `docs/financeiro/` e uma matriz funcional código↔UI↔persistência.

### Etapa 1 — Contratos e dados financeiros

- [ ] Definir interface comum e matriz de capacidades por fornecedor.
- [ ] Criar `payment_connections` e associação obrigatória ao tenant/empresa.
- [ ] Definir segredos/certificados com cofre e rotação segura.
- [ ] Implementar tentativa de cobrança e ID externo sem dois registros lógicos.
- [ ] Modelar recebimento/alocação/devolução sem sobrescrever fatos antigos.
- [ ] Usar montantes inteiros em centavos e timezone explícito.
- [ ] Acrescentar RLS, FK compostas e unicidades no escopo certo.
- [ ] Estender auditoria financeira e aprovações sem acoplamento ao PSP.

### Etapa 2 — Primeiro gateway em sandbox

- [ ] Homologar tipo de conta e credenciais do cliente piloto.
- [ ] Integrar Efí SDK/API em cliente isolado por conexão.
- [ ] Criar Pix, consultar Pix, recuperar BR Code/QR com segurança.
- [ ] Criar boleto registrado, consultar e disponibilizar o documento.
- [ ] Configurar webhook do PSP e canal de teste seguro.
- [ ] Normalizar erros, disponibilidade, timeout e `unknown`.
- [ ] Registrar confirmação externa e conciliação com a fatura original.
- [ ] Bloquear recursos não habilitados pela instituição/conta.
- [ ] Não ativar cobrança/reativação automática no tenant fora do piloto.

### Etapa 3 — Segurança e confiabilidade dos eventos

- [ ] Inbox durável, idempotência por conexão/evento, payload protegido.
- [ ] Autenticação/assinatura/token específicos do PSP.
- [ ] ACK rápido conforme fornecedor e trabalho em fila River.
- [ ] Reprocessamento de evento e DLQ operacionais.
- [ ] Reconciliação por consulta periódica, não só webhook.
- [ ] Alarmes de fila parada, falha de banco e certificate expiration.
- [ ] Testes de injeção cruzada tenant e permissão.
- [ ] Backup + restauração contendo estado de inbox/jobs e referências de segredos.

### Etapa 4 — Conectar ao ciclo completo do ISP

- [ ] Exibir Pix/boleto real no painel e portal React.
- [ ] Aplicar baixa parcial/total e tarifas sem confusão de saldo.
- [ ] Recalcular política comercial na confirmação verificada.
- [ ] Gerar intenção de reativação de rede auditável.
- [ ] Mostrar pagamento recebido mesmo quando rede ainda está pendente.
- [ ] Lidar com segundo pagamento, estorno, suspensão, renegociação e múltiplos contratos.
- [ ] Relatórios por empresa, tenant, método, banco e período.

### Etapa 5 — Segundo gateway e concorrência real

- [ ] Revisar SDK Asaas ou implementar cliente mínimo seguindo API oficial.
- [ ] Provar emissão e recebimento dos mesmos casos de negócio via segundo provedor.
- [ ] Testar duas contas do mesmo PSP em tenants distintos.
- [ ] Testar dois PSPs no mesmo tenant, com escolha explícita da conexão.
- [ ] Impedir fallback automático inseguro que gere cobranças em dois bancos.
- [ ] Formalizar versionamento de conectores e contrato estável de eventos.

### Etapa 6 — Bancos tradicionais e CNAB, quando demandado

- [ ] Escolher carteira e banco prioritários com provedor piloto.
- [ ] Auditar licenciamento ACBr/alternativa BoletoNetCore.
- [ ] Fazer PoC de remessa e retorno sem dados pessoais reais inicialmente.
- [ ] Homologar layout e ocorrências com o banco/convênio.
- [ ] Operar aprovação, entrega e retorno com hash e número de remessa.
- [ ] Exportar logs e trilhas sem anexar arquivos com dados pessoais em chamados abertos.
- [ ] Acrescentar bancos sequencialmente, por matriz formal de homologação.

### Etapa 7 — Recursos avançados

- [ ] Pix Automático autorizado e cancelamento do mandato.
- [ ] Conciliação de extratos API/OFX/custos bancários.
- [ ] Cobrança com múltiplas empresas faturadoras no mesmo tenant.
- [ ] Métricas financeiras de ISP, relatórios salvos, aging e inadimplência por POP.
- [ ] Fechamento de competência e exportação contábil aprimorada.
- [ ] Conector fiscal NFCom com homologação específica.
- [ ] Migrar tenant compartilhado para dedicado sem perder eventos.
- [ ] Benchmark em célula com múltiplos tenants e cotas reais.


## 16. Critérios de aceite por fluxo {#cap16}

### 16.1 Criação

A criação idempotente não gera duas cobranças bancárias após timeout; o ID externo é recuperável; se não for recuperável, o sistema sinaliza `UNKNOWN` e requer consulta/ação segura. O documento entregue ao assinante é registrado e válido segundo consulta do banco quando aplicável.

### 16.2 Pagamento

Evento autenticado cria no máximo uma aplicação do mesmo recebimento, mesmo com repetição, duas réplicas Go, worker reiniciado ou job reentregue. Valor alocado corresponde ao recebido e às regras contratuais; não há baixa se a origem não foi verificada.

### 16.3 Cancelamento e devolução

Cancelamento de cobrança não cancela fatura automaticamente; devolução não apaga pagamento antigo; ambas preservam histórico e saldo coerente. Tentativas e respostas de banco ficam auditadas.

### 16.4 SaaS compartilhado

Tenant A não consegue usar credenciais, webhook, faturas, PDFs, CNAB, relatórios, logs ou IDs externos de tenant B, mesmo se for admin do próprio tenant. Um tenant lento não pode bloquear os trabalhadores indefinidamente. Testar com banco, API, jobs, objeto e dados mascarados.

### 16.5 SaaS dedicado

Build funcionalmente idêntico, credenciais e segredos exclusivos, rota de webhook própria e processo de migração reversível dentro das condições contratadas, com prova de que não houve segunda cobrança.

### 16.6 Operação

Alertas de certificado, 5xx por banco, fila pausada, divergence aging, cobrança incerta, webhook atrasado, taxa de rejeição, backup e restauração existem e são exercitados. Existe runbook com causa, impacto, comunicação, workaround e responsável.


### 16.7 — Testes de invariantes revisados e determinísticos

- Cobrança criada no PSP com timeout antes de o NexoISP receber a resposta; consulta posterior não cria outra.
- Dez notificações da mesma liquidação geram uma única alocação.
- Ordem `paid → pending` não reabre título liquidado.
- Evento de outro provedor não pode usar nenhuma cobrança, segredo, valor ou conexão do tenant atual.
- Pix e boleto híbridos pagos em momentos próximos não geram duas quitações; excedente vira divergência tratável.
- Comprovante WhatsApp falso não libera acesso.
- Título importado do sistema anterior é conciliado mesmo após o webhook antigo deixar de funcionar, por extrato/retorno quando disponível.
- PSP sem resposta não provoca mudança da rede para estado 'reativado' sem confirmação da liquidação/política autorizada.
- Três dezenas de tenants tentando faturar no mesmo minuto são distribuídos pelo scheduler sem fome da fila.
- Identidade do recebedor não pode divergir da empresa autorizada a cobrar.
- Token revogado e certificado expirado degradam apenas a conexão afetada.
- Desbloqueio em confiança concorrente não concede múltiplos períodos.
- Inadimplência de assinatura SaaS não suspende automaticamente sessões de assinantes de internet.



## 17. Registros de risco e soluções concretas {#cap17}

| ID | Risco | Consequência | Mitigação operacional e técnica |
|:--|:--|:--|:--|
| R01 | Webhook repetido | Baixa em duplicidade | Unique por conexão+evento; processamento idempotente |
| R02 | Webhook perdido | Assinante fica indevidamente em atraso | Polling/consulta e reconciliação periódica |
| R03 | Timeout na emissão | Boleto emitido duas vezes | ID determinístico; estado incerto; consulta antes do retry |
| R04 | Banco/tenant errado | Vazamento e recebimento incorreto | Vínculo conexão-tenant-empresa validado antes de chamar PSP |
| R05 | Certificado expirado | Cobranças e consultas param | Monitorar expiração, alerta e rotação programada |
| R06 | SDK desatualizado | Integração quebra após alteração de API | Cliente encapsulado, testes de contrato e política de atualização |
| R07 | Boleto não registrado | Documento pode não ser pagável | Exigir confirmação do banco/retorno adequado |
| R08 | Carteira CNAB errada | Arquivo rejeitado ou título incorreto | Homologar banco/carteira/convênio e sequência |
| R09 | Valor com `float` | Diferença de centavos | Centavos int64 / decimal, testes de arredondamento |
| R10 | Conciliação por heurística | Baixa no título errado | Identificação bancária forte + decisão manual em divergência |
| R11 | Falta de liquidação | Recebido ≠ disponível | Modelar taxas, crédito, disponibilidade e reconciliação |
| R12 | Anexos de CNAB sem controle | Vazamento LGPD | Criptografia, segregação, retenção e acesso auditável |
| R13 | Cache sem tenant | Vazamento entre ISPs | Prefixos/escopo obrigatórios por conexão, testes cruzados |
| R14 | Jobs sem fairness | Um tenant congestiona a célula | Quotas, filas e priorização por tenant |
| R15 | Réplicas processam em paralelo | Efeito financeiro duplicado | Unicidades SQL, transações, idempotência/outbox |
| R16 | Migração shared→dedicated | Evento perdido ou cobrança duplicada | Drenagem, corte, forwarding temporário e reconciliação |
| R17 | Suporte vê segredos | Comprometimento de contas | Cofre, RBAC mínimo, sessões auditadas e mascaramento |
| R18 | Parser CNAB inseguro | Erro/corrupção/dados maliciosos | Limites, validações, fuzzing e arquivos sintéticos |
| R19 | Webhook forjado | Pagamento falso | Assinatura/token + conferência externa em divergência |
| R20 | Cancelar título quitado | Saldo e vínculo inconsistentes | Máquinas de estados e revisão de regras |
| R21 | Falha do PSP | Cobranças e confirmações atrasam | Retry classificado e operação degradada transparente |
| R22 | QR expirado exibido como válido | Má experiência e falha de pagamento | Estado consultado e segunda via controlada |
| R23 | Bloqueio automático precipitado | Cliente pagante perde serviço | Grace period, conciliação e intenção de rede independente |
| R24 | RADIUS/OLT offline na reativação | 'Pago' sem conexão | Mostrar estado técnico separado e retry autorizado |
| R25 | Tarifa bancária desconhecida | Relatório/demonstrativo incorreto | Bruto/líquido/tarifa separados |
| R26 | Fiscal confundido com boleto | Descumprimento fiscal | Motor/conector NFCom próprio e parecer fiscal |
| R27 | Licença incompatível | Distribuição irregular | Revisão de licença LGPL/AGPL/ACBr Pro, SBOM e aviso |
| R28 | Serviço auxiliar vulnerável | Vazamento ou alteração | Isolamento de rede, revisão de código, pins, pentest |
| R29 | Dependência de um mantenedor | Quebra sem correção | Encapsular, manter alternativa e fork controlado |
| R30 | Falta de restore real | Perda financeira histórica | Testes de restauração e política de RPO/RTO |
| R31 | IDs externos colidem entre PSPS | Recebimento atribuído à pessoa errada | Unique por conexão + tipo de recurso |
| R32 | Resposta HTTP confundida com pagamento | Baixa indevida | Estados separados, fonte de evidência bancária |
| R33 | Mudança de convênio/carteira | Arquivos rejeitados | Versionamento de capacidades e homologação |
| R34 | Acesso administrativo excessivo | Fraude/erro humano | Dupla aprovação, auditoria, segregação de funções |
| R35 | Contabilização fiscal incorreta | Multa e retrabalho | Especialista fiscal, testes por UF/CNPJ e motor separado |
| R36 | Falta de observabilidade | Incidentes longos | Métricas por conexão/tenant, correlação e runbooks |


## 18. Custo, operação e negociação bancária {#cap18}

Open-source elimina ou reduz custos de **licença de software de determinada biblioteca**, mas não elimina cobrança por transação, mensalidade, convênio, taxas Pix PJ, boleto liquidado, infraestrutura, compliance, certificados, suporte, manutenção e homologação. O Banco Central confirma que empresas podem ser tarifadas por recebimentos Pix em determinadas modalidades, incluindo Pix Automático. [F14]

Comparar prestadores pelo **custo total por 1.000 títulos**, não apenas por boleto emitido. Modelar:

- tarifa de emissão, registro, liquidação e alteração/cancelamento;
- Pix recebido, Pix Automático autorizado, devolução e eventuais tarifas extras;
- tempo de crédito, custo de antecipação, limites, bloqueio de conta e SLA de suporte;
- custo de implantação, aprovação de credenciais, certificados, webhook e homologação;
- custo de operação de CNAB, erros, intervenção humana e arquivo rejeitado;
- limite de API, rate limiting, custo de assinatura/infra das bibliotecas comerciais complementares;
- custo de suporte NexoISP e retrabalho financeiro por incidente;
- possibilidade de cada tenant manter conta e contrato próprio e requisitos mínimos de faturamento.

Não há, neste relatório, valores de preço/tarifa atribuídos a bancos. Isso exige proposta comercial vigente e perfil de volume de cada provedor; números genéricos seriam enganosos.


### 18.1 — Comparação de custos de cobrança (P2) [A17]

Simular custo para base de assinantes, distribuição Pix/boleto, adimplência, emissão antecipada, registro, liquidação, baixa, protesto, mensalidade, custos de mensagem e tarifa negociada. Apresentar cenário otimista/esperado/pessimista; custos exemplificativos nunca como tarifário real. Se não houver tarifas informadas, **não inventar resultado financeiro**.

**Critério de aceite:** totais e unidades são reprodutíveis; nenhum valor de tarifa sem fonte é apresentado como preço vigente.



## 19. Seleção de fornecedor: scorecard e prova de conceito {#cap19}

Matriz a preencher para cada candidato, com 'sim/não/parcial/não verificado' e anexo de evidência:

1. Conta própria por provedor e CNPJ; 2. sandbox efetivo; 3. Pix dinâmico; 4. Pix com vencimento; 5. boleto registrado; 6. boleto com Pix; 7. Pix Automático; 8. juros/multa; 9. desconto; 10. cancelamento; 11. devolução; 12. recebimento parcial; 13. webhooks autenticáveis; 14. API de consulta; 15. extrato; 16. conciliação; 17. ID externo estável; 18. mecanismo de idempotência na criação; 19. limites de taxa; 20. certificados e rotação; 21. suporte comercial; 22. custo por operação; 23. prazo de crédito; 24. isolamento de conta/CNPJ; 25. documentação vigente; 26. biblioteca/licença; 27. runtime Linux; 28. observabilidade; 29. política de versionamento; 30. documentação para homologação.

Uma biblioteca sem muitas estrelas pode passar numa PoC limitada; não deve automaticamente ser aprovada para operar contas de dezenas de ISPs. Uma biblioteca com milhares de downloads tampouco substitui auditoria de segurança, regressão de layouts e teste de liquidação real.


## 20. Proposta de releases {#cap20}

**Release F0 — Inventário:** mapear o domínio atual, schema, rotas e demo; documentação de lacunas e riscos, sem alterar execução financeira.

**Release F1 — Primeiro recebimento real:** uma conexão Efí, Pix e boleto no sandbox/piloto, banco de verdade, isolamento por tenant, webhook, conciliação, baixa e portal com dados reais; desbloqueio assistido.

**Release F2 — Resiliência:** divergências, replay seguro, certificados, monitoramento, tolerância a falhas, dois tenants na mesma célula e duas réplicas API, testes de recuperação e suporte operacional.

**Release F3 — Multiprovedor:** segundo gateway (Asaas ou outro) usando a mesma interface; seleção por empresa faturadora, regras e relatórios, com pilotos diferentes.

**Release F4 — Multibanco tradicional:** demanda real de CNAB e banco tradicional (ex.: Inter V3 ou Sicoob/Sicredi/Bradesco), com homologação por carteira e extração de arquivo.

**Release F5 — Recorrência avançada:** Pix Automático, processos de devolução, conciliação por extrato, relatórios bancários gerenciais e fiscal.

**Release F6 — Escala SaaS:** automação de provisionamento de contas, quota por tenant, múltiplas células, migração shared/dedicated e serviço opcional CNAB auditado.

A ordenação pode mudar conforme parceiro-piloto e convênio disponível; **não** fixar cronogramas sem acesso à equipe, requisitos e contas de homologação.


### 20.1 — Releases revisados com dependências de migração e homologação

| Release | Implementar | Só liberar quando |
|---|---|---|
| F0 — Fundamentos | revisão do código financeiro existente, interface de PSP, cofre de segredos, BaaS/conta própria, simulador, modelos Pix/BolePix | fluxo demonstrativo não é confundido com cobrança real; isolamento comprovado |
| F1 — Piloto com novo ISP | Efí, onboarding, Pix/boleto, webhook, conciliação, painel mínimo, régua e portal; caixa se o piloto receber em espécie | cobrança paga no mundo real gera baixa exata, sem cross-tenant; retorno de erro claro |
| F1-M — Piloto migrando IXC/SGP | tudo de F1 + importação de títulos legados, coexistência e conciliação de recebimentos antigos | zero cobrança duplicada; mapa de legados, relatório de divergências e rollback |
| F1.1 — Operação local | Pix estático assistido, caixa completo, carnê, desbloqueio em confiança, filas em escala | suporte, caixa e RADIUS funcionam em dias de pico |
| F2 — Expansão bancária | Asaas/Mercado Pago/PagBank ou instituição demandada, OAuth, troca assistida de banco | mudança de provedor e de gateway sem perda de identidade financeira |
| F3 — Avançado | Pix Automático, Open Finance, custos, CNAB multibanco, protesto/negativação e relatórios contábeis avançados | homologação específica de cada modalidade externa |

**Exceção:** o que define obrigatoriedade não é apenas a ordem de releases: se o primeiro piloto estiver migrando do SGP/IXC com carteira ativa, `F1-M` é parte do primeiro piloto e não pode ser adiado.



## 21. Gate de produção: condições que NÃO podem ser negociadas {#cap21}

1. Um PSP real homologado e uma conta recebedora configurada para o piloto.
2. Conexão com escopo inequívoco de tenant/empresa e segredo criptografado.
3. Fatura e pagamento não misturados com cobranca emitida.
4. Idempotência em emissão, webhook, reconciliação e evento comercial.
5. Recebimento parcial, devolução e cancelamento com saldo e histórico íntegros.
6. Conciliação independente que detecta perda de webhook.
7. Sandbox e produção isolados; certificados rotacionáveis.
8. Testes cruzados com ao menos dois tenants e duas contas, incluindo mesmo ID externo fictício.
9. Perfis/permissões, RLS e arquivos privados conferidos.
10. Painel mostra falha, `UNKNOWN`, divergência e reativação técnica pendente.
11. Backup/restore, relatórios de divergência e runbook de incidentes executados.
12. Migração comercial com uma única fonte de verdade no corte.
13. Política fiscal aplicável e NFCom/contábil separadas da baixa bancária.
14. Contratos/termos dos serviços, licenças de bibliotecas e LGPD revisados.
15. Profissionais de operação e financeiro do ISP piloto validam os casos reais.


## 22. Perguntas em aberto para a decisão de implementação {#cap22}

**Comerciais:** Quais bancos reais usam os primeiros clientes? Precisam de cobrança direta em conta ou aceitam PSP? Quantos títulos mensais por tenant? Há múltiplos CNPJs recebedores? Quais tarifas são aceitáveis? O ERP anterior permanece ativo no piloto? Quantas parcelas em atraso e quais multas normalmente aplicam?

**Técnicas:** Existe RLS nas tabelas auxiliares novas e nos jobs? Qual modelo de segredos está disponível para certificados bancários? Qual versão do Go e pgx? Quais APIs do frontend v0 já expõem gateway/fatura? Como o tenant migra de célula? A assinatura/HMAC de cada PSP é verificável? O volume da API suporta centenas de milhares de eventos sem monopolizar o worker?

**Legais/tributárias:** Quem é o recebedor contratual? Há necessidade de split/marketplace (e possível intermediação regulada)? Qual emissor NFCom contratado e como estados fiscais se relacionam com títulos? Prazos legais de retenção? Qual a base legal para acesso do suporte SaaS a dados financeiros?

**Operacionais:** Quem responde quando o PSP está fora? Como avisar ao ISP sobre webhook parado? Quais RTO/RPO por modalidade? Qual janela de pagamento e bloqueio? Quem autoriza reprocessar uma devolução? Como conciliar títulos migrados sem IDs bancários? Quem acompanha carteira CNAB rejeitada?


## 23. Decisões recomendadas a registrar como ADR {#cap23}

- **ADR-FIN-001:** Um único domínio financeiro Go e adaptadores por capacidade; sem ERP secundário.
- **ADR-FIN-002:** Pagamento real verificado e eventos financeiros append-only; sem confiar em webhook isolado quando inconsistente.
- **ADR-FIN-003:** Conexões financeiras por tenant + CNPJ, com cofre, sandbox e produção isolados.
- **ADR-FIN-004:** Unicidade/estados transacionais e inbox/outbox para retry seguro.
- **ADR-FIN-005:** Efí como primeiro piloto técnico condicionado a contrato/conta real; segundo gateway após homologação.
- **ADR-FIN-006:** ACBr/BoletoNetCore/Cobranca-API são candidatos não incorporados automaticamente; avaliação por banco, carteira e licença.
- **ADR-FIN-007:** Shared e dedicated usam mesmo código, mas dados/segredos/recursos isolados.
- **ADR-FIN-008:** Autorização de reativação comercial separada da execução/confirmacão de rede.
- **ADR-FIN-009:** NFCom e obrigações fiscais em domínio fiscal independente.
- **ADR-FIN-010:** Migração de tenant deve preservar IDs externos, eventos e saldo.


### 23.1 — Adições deliberadas ao ADR-FIN-001

1. O PSP é sempre um adaptador de uma interface Go interna: cliente Pix padrão BCB + perfil por PSP quando possível, SDK oficial quando oferece vantagem comprovada.
2. BolePix é uma única obrigação econômica com formas alternativas de liquidação e prevenção de pagamento duplicado.
3. `cobv` preferido para mensalidade quando suportado; `cob` para casos imediatos; Pix Automático como recurso separado e autorizado.
4. Webhook é **indício a validar**, não autoridade única para liquidação/baixa. Autenticação conforme contrato PSP e reconciliação posterior.
5. Em modo compartilhado, quotas de worker por tenant e por conta/PSP, com emissão escalonada antecipadamente.
6. Cada provedor liga sua própria conta; NexoISP não inicia BaaS ou criação de subcontas controladas por plataforma sem decisão jurídica e parceria formal.
7. `platform_billing` e `isp_billing` são domínios separados; a mesma biblioteca de gateway pode ser reutilizada.
8. Piloto com migração legada só inicia após processo de importação de IDs externos e coexistência de retornos estar homologado.
9. No F1, reutilizar oito áreas de UI e priorizar processos completos em vez de multiplicar rotas.



## 24. Diretriz para implementação via Codex/Claude, com economia de tokens {#cap24}

Implementar por **fatias verticais pequenas** sobre o código real, sem refatorar módulos já homologados ou reescrever o frontend v0. Para cada fatia: localizar handler/SQL/UI existentes, declarar os contratos e migrations mínimas, integrar um caso real e executar poucos testes focados em perda de dinheiro ou quebra de isolamento. Não criar dezenas de snapshots ou suites cosméticas. Priorizar testes de regras invariantes (um pagamento não quita duas vezes, tenant não cruza, segredo não vaza, reversão mantém trilha, timeout não emite em duplicidade, faturamento não dispara duas intenções conflitantes de rede). Fazer a validação visual apenas das telas alteradas e preservar seu design original.

Um prompt de execução deve conter: objetivo exato, caminhos reais descobertos, o que preservar, critérios de sucesso, como validar um sandbox e o que não executar em produção. Não incluir segredos nem publicar credenciais em prompts/commits/prints.


### 24.1 — Matriz de rastreabilidade das 20 propostas incorporadas

Todos os itens do adendo de 24/10/2026 foram inseridos no assunto correspondente, preservando descrição e critério de aceite. Os identificadores abaixo são estáveis para tickets e revisão por IA.

| ID | Tema incorporado | Nova seção | Tipo de entrega |
|:--|:--|:--|:--|
| A01 | API Pix padrão BCB | 7.3 | Adaptador opcional com perfis por PSP |
| A02 | Pix `cobv`, `cob`, BolePix | 7.4 | Regras de títulos híbridos |
| A03 | Webhook e mTLS | 6.3 | Segurança de entrada |
| A04 | Simulador determinístico | 6.4 | Testes de confiabilidade |
| A05 | Picos mensais de emissão | 2.7 | Escalonamento por tenant/PSP |
| A06 | Pix estático assistido | 10.4 | Conciliação operacional |
| A07 | Caixa de balcão/cobrador | 14.5 | Atendimento presencial |
| A08 | Carnê | 8.6 | Boleto/BolePix em lote |
| A09 | Régua de cobrança | 14.6 | Automação multicanal |
| A10 | Desbloqueio em confiança | 11.1 | Rede/assinante |
| A11 | Negativação/protesto | 14.7 | Integração futura |
| A12 | Títulos legados de outros ERPs | 2.8 | Migração de entrada |
| A13 | Cobrança SaaS × ISP | 2.5 | Separação de domínios |
| A14 | ERP × BaaS | 2.6 | Marco contratual/regulatório |
| A15 | Central de ativação bancária | 14.8 | Onboarding do PSP |
| A16 | OAuth/chave/certificados | 14.9 | Autorização sem fricção |
| A17 | Simulador de tarifas | 18.1 | Inteligência de custos |
| A18 | Troca assistida de banco | 2.9 | Migração e contingência |
| A19 | Open Finance / Pix Automático | 7.5 | Modalidades futuras |
| A20 | Priorização de PSPs | 4.8 | Escolha por evidência |

**Controle de mudança:** 20/20 propostas integradas; a matriz não indica implementações já concluídas no código.



## 25. Limitações e grau de confiança do relatório {#cap25}

Esta análise combina (a) documentação pública atual do NexoISP, (b) especificações oficiais do BACEN e de PSPs, e (c) documentação pública das bibliotecas. A rede do container de trabalho não permitiu clonar o repositório; por isso **não foi possível confirmar linha por linha nem executar testes**, inspecionar todas as migrations ou fazer auditoria independente dos projetos de terceiros. O relatório **não** afirma que as páginas sugeridas já existem, que a Cobranca-API é segura para dinheiro real, que as carteiras ACBr/BoletoNet atendem qualquer convênio, nem que requisitos regulatórios podem ser resolvidos apenas com código. Conferir o SHA da branch `main` antes de executar o backlog.


## 26. Referências e fontes consultadas {#cap26}

[F1] NexoISP — arquitetura, ADR-010, isolamento, fluxo financeiro e rede: <https://github.com/TavaresEnok/nexoisp/blob/main/docs/arquitetura.md> (consultado em 23/10/2026).

[F2] NexoISP — pendências de produção e financeiras: <https://github.com/TavaresEnok/nexoisp/blob/main/docs/pendencias.md> (consultado em 23/10/2026).

[F3] NexoISP — matriz funcional, itens FI-01 a FI-17: <https://github.com/TavaresEnok/nexoisp/blob/main/docs/integracao-v0/MATRIZ_FUNCIONAL.md> (consultado em 23/10/2026).

[F4] Efí — SDK oficial Go: <https://github.com/efipay/sdk-go-apis-efi> (consultado em 23/10/2026).

[F5] Projeto ACBr — ACBrLibBoleto: <https://projetoacbr.com.br/pro/downloads/acbrlibboleto/>; licenciamento dos componentes: <https://projetoacbr.com.br/> (consultado em 23/10/2026).

[F6] BoletoNetCore — carteiras homologadas/implementadas: <https://github.com/BoletoNet/BoletoNetCore> (consultado em 23/10/2026).

[F7] go-asaas — SDK comunitário Go: <https://github.com/n0vdd/go-asaas> (consultado em 23/10/2026).

[F8] Asaas — webhooks e entrega ao menos uma vez: <https://docs.asaas.com/docs/sobre-os-webhooks> e <https://docs.asaas.com/docs/webhooks-e-eventos> (consultado em 23/10/2026).

[F9] Cobranca-API — README e matriz de recursos declarada: <https://github.com/Maxwbh/cobranca-api> (consultado em 23/10/2026).

[F10] Laravel Boleto: <https://github.com/eduardokum/laravel-boleto> (consultado em 23/10/2026).

[F11] BACEN — especificação Pix API: <https://github.com/bacen/pix-api> (consultado em 23/10/2026).

[F12] Banco Inter — APIs, cobrança V3 e V2 descontinuada: <https://developers.inter.co/docs/introducao/nossas-apis> (consultado em 23/10/2026).

[F13] BACEN — Pix Automático para recebedores: <https://www.bcb.gov.br/estabilidadefinanceira/pix-automatico-recebedores> (consultado em 23/10/2026).

[F14] BACEN — tarifas PJ e Pix Automático: <https://www.bcb.gov.br/meubc/faqs/p/quanto-a-pessoa-juridica-paga-para-usar-o-pix>; FAQ Pix Automático: <https://www.bcb.gov.br/meubc/faqs/p/pix-automatico> (consultado em 23/10/2026).

[F15] LGPD — controlador e operador (referência institucional): <https://www.gov.br/incra/pt-br/acesso-a-informacao/tratamento-de-dados-pessoais/agentes-de-tratamento-lgpd> (consultado em 23/10/2026).

[F16] Pernambuco — Decreto 58.724/2025, NFCom: <https://www.sefaz.pe.gov.br/Legislacao/Tributaria/Documents/Legislacao/Decretos/2025/Dec58724_2025.htm> (consultado em 23/10/2026).

---

**Síntese da decisão arquitetural final:** manter o sistema financeiro Go já existente, implementar a camada de integração real com pelo menos um fornecedor homologado, usar bibliotecas especializadas somente por necessidade comprovada, operar SaaS híbrido sem misturar contas bancárias, e medir conclusão por processos bancários, comerciais e de rede executados com rastreabilidade — jamais apenas pelo número de telas ou SDKs integrados.


### 26.1 — Referências adicionais e verificações de 24/10/2026

- [API Pix OpenAPI do Banco Central](https://github.com/bacen/pix-api) — cobranças imediatas, com vencimento, lotes, Pix recebidos e recorrências.
- [BCB — Pix Automático](https://www.bcb.gov.br/estabilidadefinanceira/pix-automatico) e [Pix Automático para recebedores](https://www.bcb.gov.br/estabilidadefinanceira/pix-automatico-recebedores).
- [BCB — atualização regulatória e cobrança híbrida, setembro/2026](https://www.bcb.gov.br/detalhenoticia/21278/noticia).
- [BCB — regulação BaaS](https://www.bcb.gov.br/detalhenoticia/20950/nota).
- [Asaas — regras BaaS](https://central.ajuda.asaas.com/hc/pt-br/articles/55725893727899-Quais-s%C3%A3o-as-regras-e-condi%C3%A7%C3%B5es-para-operar-BaaS-no-Asaas), [subcontas](https://docs.asaas.com/docs/subaccounts) e [subcontas sem BaaS](https://central.ajuda.asaas.com/hc/pt-br/articles/50236083294619-Quero-criar-subcontas-mas-elas-podem-acessar-a-interface-do-Asaas-Quais-s%C3%A3o-as-regras).
- [Efí — webhooks Pix, mTLS e skip-mTLS](https://dev.efipay.com.br/docs/api-pix/webhooks/).
- [Mercado Pago — OAuth](https://www.mercadopago.com.br/developers/pt/docs/security/oauth/creation).
- [PagBank — Connect Authorization](https://developer.pagbank.com.br/docs/connect-authorization) e [homologação](https://developer.pagbank.com.br/docs/solicitar-homologacao).

**Nota de revisão:** propostas de regras de negócio, filas, banco de dados e interface neste adendo não foram verificadas linha a linha no commit atual do NexoISP e devem passar por diff e inspeção de migrations antes de implementação. Não usar valores de tarifas hipotéticas como tarifas praticadas nem declarar capacidades de PSP homologadas sem documentação e teste em conta real autorizada.

- [Asaas — introdução oficial aos webhooks](https://docs.asaas.com/docs/about-webhooks): entrega `at least once`, idempotência pelo ID, persistir antes de responder e processamento assíncrono; confirmação revalidada em 24/10/2026.
- [Asaas — token do webhook e campos de configuração](https://central.ajuda.asaas.com/hc/pt-br/articles/55669339031835-Quais-s%C3%A3o-as-op%C3%A7%C3%B5es-de-configura%C3%A7%C3%A3o-de-um-Webhook-no-Asaas): token específico enviado em `asaas-access-token`; não é chave de API da conta.
- [BCB — regulamentação BaaS](https://www.bcb.gov.br/detalhenoticia/20950/nota): verificar também contratos e adequações da Resolução Conjunta nº 16/2025, com atenção à data-limite de contratos preexistentes.
- [PagBank — Connect](https://developer.pagbank.com.br/docs/connect) e [Connect Authorization](https://developer.pagbank.com.br/docs/connect-authorization): autorização da conta do vendedor, permissões e fluxo de token.


---

## Fechamento consolidado da versão 2.0

A estratégia não é instalar cinco motores financeiros em paralelo. O núcleo Go do NexoISP continua sendo a única fonte de verdade das obrigações, lançamentos e autorizações internas, enquanto os bancos e PSPs são a fonte verificável dos movimentos externos. Efí é candidata técnica inicial para F1, Asaas a segunda integração e Mercado Pago/PagBank alternativas para facilitar conexões de pequenos ISPs. A ordem final depende do contrato bancário dos primeiros clientes, da validação do fluxo em produção e das exigências de homologação. ACBr e BoletoNetCore ficam sob análise para CNAB e bancos tradicionais, e a Cobranca-API permanece experimental até revisão de segurança e maturidade.

O sucesso não é medido pela contagem de integrações, e sim por um ciclo completo, audível e recuperável: cliente recebe cobrança, paga em sua modalidade autorizada, sistema registra uma única liquidação, concilia valor e conta, informa o assinante e coordena eventuais alterações técnicas sem confundir intenção com execução. Os 20 pontos adicionais asseguram que esse ciclo funcione também na realidade de provedores de 100 a 1.000 clientes: caixa presencial, Pix estático, carnê, régua, desbloqueio em confiança, cartões e bancos de acesso simplificado, coexistência de títulos legados e ativação bancária autossuficiente.
