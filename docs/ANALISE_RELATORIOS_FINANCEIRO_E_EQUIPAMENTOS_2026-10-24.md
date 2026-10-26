# Análise dos três relatórios recebidos pelo Google Drive

Data da análise: **24/10/2026**, America/Fortaleza. Escopo: conteúdo dos três arquivos, comparação entre as versões financeiras, inspeção estática do repositório local e conferência seletiva de fontes primárias externas.

**Resultado:** os documentos oferecem uma direção compatível com o NexoISP: ampliar o backend Go e o agente existente, preservar a interface oficial v0 e liberar integrações mediante evidência real. O consolidado financeiro v2 é a referência de planejamento mais recente entre os dois relatórios financeiros recebidos. O dossiê de equipamentos complementa esse planejamento no domínio de rede. A importação destes arquivos não altera decisões vigentes nem comprova implementação ou homologação.

## 1. Arquivos recebidos e integridade

Os três arquivos foram baixados em formato Markdown original, sem edição, conversão ou mudança de nome. O sufixo `(1)` foi preservado.

| Referência | Arquivo local | Origem | Bytes | Linhas |
|---|---|---|---:|---:|
| FIN-V2 | [Relatório financeiro consolidado v2](NexoISP_Relatorio_Financeiro_Consolidado_v2_2026-10-24.md) | [Google Drive](https://drive.google.com/file/d/1MUN-kdbIVE7MYtEg1N95VoWbozAKobeE/view) | 106771 | 1165 |
| FIN-V1 | [Arquitetura financeira original](NexoISP_Relatorio_Arquitetura_Financeira_Open_Source_2026-10-23%281%29.md) | [Google Drive](https://drive.google.com/file/d/1eHZl-ng9i77OHKxLLMcVFo249WojR1sp/view) | 73024 | 814 |
| REDE | [Dossiê de equipamentos v1.2](NexoISP_Dossie_Completo_Integracoes_Equipamentos_OpenSource_2026-10-24_v1.2.md) | [Google Drive](https://drive.google.com/file/d/1fo4IOLx4mQ0TbhGIR-ufsnHHGcbvTL0U/view) | 161206 | 2023 |

Total: **341001 bytes**. Os tamanhos locais conferem com os metadados do Drive. SHA-256 dos arquivos baixados:

```text
2a9855a8c086c3e6006d6ba9c81d6bb71d6a99aab9af5f55540eb66beaf13049  NexoISP_Relatorio_Financeiro_Consolidado_v2_2026-10-24.md
6895c9cfbbed9a209e12542a3f80e7c39b11a09da43303d8fe2b81233a6e72ce  NexoISP_Relatorio_Arquitetura_Financeira_Open_Source_2026-10-23(1).md
f2fc782ae8724506ccce487a2f5de670626f85b51a81bdadb92e9ec8f3ccaded  NexoISP_Dossie_Completo_Integracoes_Equipamentos_OpenSource_2026-10-24_v1.2.md
```

Os hashes são registros locais de integridade; não representam assinatura do autor nem comparação com hash publicado no Drive.

## 2. Avaliação individual

### FIN-V1 — arquitetura financeira de 23/10

Os 26 capítulos cobrem domínio financeiro, contratos de integração, segurança, experiência de operação, migração e critérios de produção. A contribuição central é distinguir **fatura, instrumento de cobrança, pagamento, alocação e disponibilidade financeira**. Essa separação permite evoluir a integração sem substituir os contratos e títulos já existentes.

A avaliação de Efí, ACBr, BoletoNetCore, go-asaas e Cobranca-API diferencia SDK, motor de boleto/CNAB e gateway. Essa distinção evita instalar vários serviços que disputem a autoridade sobre os mesmos pagamentos. Efí aparece como candidata inicial; o próprio relatório condiciona a decisão à conta e aos produtos contratados pelo piloto.

O limite metodológico está explícito no capítulo 25: o autor não conseguiu clonar o repositório nem executar testes. Assim, modelos de tabelas, endpoints, permissões e telas devem ser tratados como propostas. A inspeção local desta análise confirma os limites principais do gateway, mas não transforma todo o inventário proposto em requisito aprovado.

**Uso recomendado:** preservar como histórico da concepção e consultar o FIN-V2 para o planejamento financeiro atualizado. Não abrir dois backlogs a partir dos dois arquivos.

### FIN-V2 — consolidação financeira de 24/10

O FIN-V2 mantém a estrutura de 26 capítulos e incorpora 20 propostas A01–A20, com uma matriz de rastreabilidade no capítulo 24.1. A comparação textual encontrou **804 das 814 linhas do FIN-V1 preservadas**, desconsiderando apenas os anchors adicionados aos títulos; as substituições concentram-se no cabeçalho e na apresentação. Portanto, os dois arquivos são versões do mesmo trabalho, e não duas avaliações independentes que corroborem uma à outra.

Os avanços mais úteis são o onboarding bancário, o tratamento de títulos do ERP anterior, os picos mensais de emissão, os limites do mTLS no ingresso, a separação de cobrança SaaS e cobrança do assinante, e a conciliação assistida de Pix sem vínculo inequívoco. O documento também reduz a primeira interface a oito fluxos reutilizáveis, coerentes com a preservação da UI oficial.

Há, porém, duas sequências de releases no capítulo 20: a original F0–F6 e a revisada F0/F1/F1-M/F1.1/F2/F3. O significado de F2 e F3 muda entre elas. Para um futuro plano executivo, escolher uma sequência e registrar a substituição da anterior. Idempotência, recuperação de eventos, isolamento e conciliação precisam estar presentes antes de dinheiro real, mesmo quando a tabela antiga coloca parte da resiliência em F2.

**Uso recomendado:** base para uma primeira integração vertical, com um PSP e um piloto delimitado, após reconciliar as propostas com o schema e os fluxos existentes.

### REDE — integrações de equipamentos e open source

O dossiê reúne catálogo de fabricantes, famílias NAS, funções de CPE, projetos reutilizáveis, contratos de drivers e anexos de comandos. Sua contribuição principal é definir compatibilidade por **modelo, firmware, tecnologia e operação**, separando referência documental, implementação, ensaio sintético, hardware e piloto.

A distinção entre OLT/ONU, ACS/CPE e NAS/RADIUS está alinhada à arquitetura do projeto. ONMT e Kusuma são apresentados como fontes de comandos e componentes; Oxidized como referência de sessão/backup; NTC Templates e LibreNMS como fontes de parsers/amostras; GenieACS e FreeRADIUS como bases já existentes. A classificação é útil para selecionar um componente pequeno em vez de incorporar outro ERP ou NMS inteiro.

Os anexos 25 e 26 contêm comandos candidatos e diferenças relevantes entre GPON/EPON, ZTE clássico/Titan, FiberHome CLI/TL1 e famílias V-SOL. O anexo DMZ faz uma revisão crítica das fontes comunitárias; não fornece um roteiro universal executável. A classificação da V1600D4-DP como EPON foi conferida nesta análise na [página do fabricante](https://www.vsolbr.com.br/produto/olt-epon-v1600d4-dp/).

**Uso recomendado:** orientar seleção de fontes, captura de respostas e homologação de uma família de cada vez, conforme o equipamento disponível no piloto. Rankings de repositórios e contagens comerciais não demonstram suporte do NexoISP.

## 3. Aderência ao repositório atual

Referência local observada: `HEAD 0a6c2a8c285ddffdec7bd6cf2a75cf06631d6743`. O diretório já continha alterações não commitadas antes desta tarefa; a inspeção considerou o conteúdo presente no workspace, sem atribuí-lo integralmente ao HEAD.

| Tema | Evidência local | Implicação para os relatórios |
|---|---|---|
| Interface oficial | [AGENTS.md](../AGENTS.md), [plano v0](integracao-v0/PLANO.md) e [matriz funcional](integracao-v0/MATRIZ_FUNCIONAL.md) | Evoluir `apps/web` mantendo componentes e identidade v0; legado serve para consulta de contratos |
| Domínio financeiro | [Migration financeira](../db/migrations/00003_financeiro.sql), [finance/core.go](../apps/api-go/internal/finance/core.go) e [finance/advanced.go](../apps/api-go/internal/finance/advanced.go) | Faturas, pagamentos, eventos, baixa manual, acordos e confiança já possuem base; criar apenas as extensões necessárias |
| Gateway real | `Charges` e `Demo` em [finance/core.go](../apps/api-go/internal/finance/core.go); [handler do gateway](../apps/api-go/internal/modules/escrita/gateway.go) | Cobranças fictícias dependem de `NEXO_DEMO_MODE=1`; webhook registrado aceita apenas gateway demo. Não existe integração bancária real nesse caminho |
| Conciliação | `chargePayments`, `Reconcile` e `Event` em [finance/gateway.go](../apps/api-go/internal/finance/gateway.go) | Há deduplicação e tratamento de divergência na base demonstrativa, mas a consulta externa atual lê `demo_gateway_charges` |
| Empresa faturadora | [empresas_tags.go](../apps/api-go/internal/modules/escrita/empresas_tags.go) | Reutilizar o cadastro e o vínculo contratual existentes ao modelar a conexão recebedora; evitar duplicar `billing_entities` sem mapeamento |
| Confiança | `Trust`/`Grant` em [advanced.go](../apps/api-go/internal/finance/advanced.go), endpoint do portal e migration 00021 | A10 amplia e valida uma capacidade existente; não é um módulo a iniciar do zero |
| Régua de avisos | [Migration 00027](../db/migrations/00027_avisos_ao_assinante.sql), [fila 00035](../db/migrations/00035_fila_de_avisos.sql), [outbound/notices.go](../apps/api-go/internal/outbound/notices.go) | A09 deve evoluir regras, templates, canais e fila atuais, com validação do estado financeiro no envio |
| Migração financeira | `importInvoice` em [importacao.go](../apps/api-go/internal/modules/escrita/importacao.go) e [guia CSV](importacao-csv.md) | Já importa títulos e pagamentos históricos por origem/ID; isso não equivale à conciliação da carteira bancária legada proposta em A12 |
| Driver OLT | [olt_base.py](../services/network-agent/nexo_agent/drivers/olt_base.py), [olt_huawei.py](../services/network-agent/nexo_agent/drivers/olt_huawei.py) e [expansão OLT](expansao-olt-onu.md) | Preservar o contrato e o executor. Huawei continua sem homologação física documentada |
| Catálogo de ONU | [onu_catalogo.go](../apps/api-go/internal/modules/escrita/onu_catalogo.go) | Modelos/templates são documentação do provedor; não constituem um registro de capacidades executáveis homologadas |
| ACS | [acs/client.go](../apps/api-go/internal/acs/client.go) e [migration 00052](../db/migrations/00052_tr069_cpe.sql) | Há integração GenieACS e associação com RLS; `Task` distingue `applied` de `queued`. A proposta deve estender essa base |
| Células SaaS | [db/db.go](../apps/api-go/internal/db/db.go), [migration 00056](../db/migrations/00056_diretorio_celulas.sql) | Existe diretório, mas `WithScope` rejeita pool fora de `c1`. Migração entre células permanece evolução futura |

O [plano v0](integracao-v0/PLANO.md) e a matriz registram 154 unidades integradas e validadas e 20 capacidades preservadas, incluindo limitações. Essa é evidência documental preexistente, não uma regressão reexecutada nesta tarefa. A integração da interface não conclui gateway real, homologação física nem migração universal.

## 4. Pontos concretos para resolver antes da implementação

**P0 — Identidade externa precisa incluir a conexão financeira.** A migration 00003 usa unicidade `(gateway, gateway_charge_id)`, `(gateway, gateway_payment_id)` e `(gateway, event_id)`. A função `gateway_charge_tenant` resolve o tenant por gateway e cobrança; `Event` depende desse resultado. Para contas independentes com IDs iguais no mesmo PSP, essa modelagem não oferece o namespace por conexão proposto nos relatórios. A extensão deve incluir conexão/empresa/tenant, adaptar funções privilegiadas, índices e processamento, e preservar o histórico existente. Não basta acrescentar o nome de um banco ao campo `gateway`.

**P0 — Não colocar chamadas bancárias dentro da transação atual.** Hoje `Charges` opera apenas no banco demonstrativo e recebe `*db.Tx`; o job BILLING a chama dentro de `WithScope`. Ao integrar um PSP, persistir tentativa/intenção, liberar a transação, chamar o fornecedor e gravar resultado em nova transação. Um timeout exige consulta posterior e estado incerto, não emissão automática de outra cobrança. Este é um cuidado de desenho para a extensão, não uma falha de HTTP bancário já existente.

**P0 — O webhook demo não é contrato de PSP real.** O handler atual usa HMAC com `NEXO_GATEWAY_WEBHOOK_SECRET` e processa `finance.Event` no atendimento da requisição. Cada adaptador real precisa de autenticação própria e conexão resolvida de forma confiável, além de recepção durável, confirmação de recebimento conforme fornecedor e processamento recuperável. A [documentação Asaas](https://docs.asaas.com/docs/about-webhooks) confirma reentrega, deduplicação por ID, persistência antes do HTTP 200 e processamento assíncrono; a [documentação Efí](https://dev.efipay.com.br/docs/api-pix/webhooks/) descreve a configuração mTLS de callbacks Pix.

**P0 — Reutilizar River e completar quotas bancárias.** Na leitura final do workspace, [jobs.go](../apps/api-go/internal/jobs/jobs.go) já despacha jobs duráveis por tenant, com retry independente e lock por provedor, usando [jobargs/periodic.go](../apps/api-go/internal/jobargs/periodic.go). Essa alteração local foi considerada na revisão; não se deve abrir como lacuna uma separação de jobs que já está sendo implementada. Ainda é necessário definir e validar quotas por conta/PSP, limites externos, emissão em pico e recuperação sem duplicação. Esta inspeção não executou os testes da alteração concorrente.

**P1 — Persistência inteira não implica cálculo integralmente inteiro.** As colunas monetárias da migration 00003 usam centavos em `integer`, mas `num` e `settle` em `finance/core.go` trabalham com `float64`; a importação também possui conversões monetárias em ponto flutuante. O requisito do relatório exige revisar os caminhos alterados, parsing de valores do PSP e arredondamento. A inspeção não demonstrou perda de centavos; não há base para declarar corrupção financeira. Avaliar `int64`/decimal e capacidade das colunas conforme os limites aprovados.

**P1 — Migração de carteira é mais ampla que importação de saldo.** A importação atual conserva origem e ID do título, e `ensureCharges` exclui registros com `external_source`. Isso ajuda a evitar reemissão demonstrativa, mas não fornece vínculo por conexão, txid, nosso número, conta/convênio e retornos do banco antigo. A12 precisa completar a identidade bancária e a coexistência dos recebimentos. Para piloto migrado, esse trabalho antecede o corte.

**P1 — Já existe proteção de vínculo ACS, mas a proposta é mais ampla.** `cpe_links` possui RLS, restrição de portal e ID ACS único. O cliente usa um `NEXO_ACS_URL` por instalação. Não há motivo para substituir o ACS ou ignorar essas proteções; a evolução por múltiplas instalações, prova de associação e acompanhamento durável de tarefas requer avaliação específica. A distinção HTTP 200/202 está alinhada à [API oficial GenieACS](https://docs.genieacs.com/en/latest/api-reference.html).

**P1 — Não corrigir um catálogo operacional com base apenas no texto importado.** O dossiê identifica erros em classificações de terceiros, mas esta análise não encontrou evidência de que esses SKUs estejam cadastrados incorretamente na instalação do usuário. Aplicar a classificação correta na futura curadoria, sem presumir registros reais nem modificar equipamentos.

## 5. Tratamento das propostas A01–A20

Esta triagem indica reaproveitamento e dependências; nenhum item foi implementado nesta tarefa.

| Itens | Tratamento sugerido |
|---|---|
| A01 — API Pix padrão | Interface interna tipada e perfis por PSP; cliente gerado é opção, condicionado à API efetivamente contratada |
| A02 — cob/cobv/BolePix | Modelar dívida e instrumentos sem duplicar baixa; excedente recebido exige conciliação |
| A03 — mTLS/webhook | Resolver autenticação de transporte e conexão antes da alocação financeira; não confiar em headers externos de certificado |
| A04 — simulador | Reaproveitar a separação demo para testes isolados; acrescentar cenários determinísticos de timeout, concorrência e eventos fora de ordem |
| A05 — picos de emissão | Reusar o despacho por tenant presente no workspace; acrescentar quotas de conta/PSP e ensaios de concorrência e falha |
| A06 — Pix estático | Criar conciliação assistida a partir de recebimentos confirmados; comprovante e coincidência de valor não bastam |
| A07 — caixa | Baixa manual já existe; sessão de caixa, sangria, fechamento e prestação de contas são escopo adicional conforme piloto |
| A08 — carnê | Emissão em lote com identidade por competência, confirmação externa e tratamento de alterações contratuais |
| A09 — régua | Ampliar canais/regras/fila existentes; verificar saldo e elegibilidade no momento do envio |
| A10 — confiança | Reusar `Trust`/`Grant`; validar concorrência, limites e confirmação técnica, sem refazer o fluxo |
| A11 — negativação/protesto | Integração futura, dependente de contrato e processo próprio |
| A12 — carteira legada | Complementar importador com identidade bancária e conciliação; requisito de corte para carteira ativa migrada |
| A13 — SaaS × ISP | Manter domínios, recebedores e efeitos operacionais separados |
| A14 — ERP × BaaS | Decisão contratual pendente; esta análise não valida enquadramento regulatório |
| A15 — ativação bancária | Parte da primeira integração: requisitos, credenciais, teste, recebedor, webhook e estado de homologação |
| A16 — OAuth/chaves/certificados | Implementar conforme o PSP escolhido, com escopos, rotação e revogação |
| A17 — tarifas | Ferramenta posterior; exige tarifas fornecidas e fonte, sem preços inventados |
| A18 — troca de banco | Novas cobranças podem mudar de conexão; antigas preservam identidade e conciliação |
| A19 — Open Finance/Pix Automático | Modalidades adicionais, com autorização e eventos próprios; não condicionar a elas o Pix convencional |
| A20 — escolha do PSP | Decidir com conta/produtos do piloto e prova do fluxo; a preferência por Efí no relatório não é seleção comercial concluída |

## 6. Ajustes documentais e limites das fontes

1. **Referência Git incorreta no dossiê:** o capítulo 15 informa `0a6c2a8c285ddffdec7bd6cf06631d6743`, uma sequência de 34 caracteres que diverge do HEAD local. Não usar esse valor como identificação verificada da revisão; registrar o hash realmente consultado em cada futura implementação.
2. **Escalas de evidência diferentes:** o capítulo 1 do dossiê usa níveis 0–5; o anexo 26 usa F0–F4; o anexo 25 usa confiança A/B. Essas escalas não têm equivalência declarada. Padronizar antes de convertê-las em dados do produto, preservando fonte e operação. Evitar ainda confundir F0 financeiro com F0 de evidência de rede.
3. **Ordem variável de fabricantes:** os capítulos 20, 25.18 e o anexo DMZ apresentam prioridades distintas. Escolher uma fila conforme demanda e hardware, mantendo leitura e captura de evidências antes da escrita. ZTE/FiberHome são candidatos do documento, não compromisso de suporte.
4. **Modelos de dados e APIs são conceituais:** `billing_entities`, intenções, observações e associações ACS devem ser mapeados às entidades existentes. As permissões conceituais também precisam ser adaptadas à autorização Go, sem checagem apenas na UI.
5. **Maturidade e licenças de terceiros:** rankings, estrelas, cobertura e licenças relatadas não foram auditados integralmente nesta tarefa. Antes de copiar código ou implantar serviços, fixar commit, revisar o arquivo e suas dependências e preservar autoria/licença. Um serviço separado não é, por si, prova de independência jurídica.
6. **Afirmações normativas e comerciais:** os originais citam BaaS, NFCom, alterações do Pix e condições de PSPs. Esta análise não confirma vigência, aplicabilidade por provedor/UF nem tarifas. Esses pontos precisam ser revalidados na decisão correspondente; não foram usados para declarar conformidade.

Foram conferidas seletivamente fontes primárias sobre [SDK Go Efí](https://github.com/efipay/sdk-go-apis-efi), [webhook Efí](https://dev.efipay.com.br/docs/api-pix/webhooks/), [webhook Asaas](https://docs.asaas.com/docs/about-webhooks), [API GenieACS](https://docs.genieacs.com/en/latest/api-reference.html) e [V-SOL V1600D4-DP](https://www.vsolbr.com.br/produto/olt-epon-v1600d4-dp/). Essas conferências sustentam apenas os pontos citados, sem homologar os fornecedores ou todos os projetos listados nos arquivos.

## 7. Ordem de trabalho recomendada

| Ordem | Entrega futura | Evidência necessária |
|---|---|---|
| 1 | Inventário financeiro por código, persistência e UI; escolher a sequência de releases | Mapa das entidades atuais, extensões e decisões do piloto |
| 2 | Conexões financeiras e tentativas idempotentes, com isolamento e recepção durável | Dois tenants com IDs externos iguais sem colisão; timeout recuperado sem segunda emissão |
| 3 | Um PSP com onboarding, cobrança, consulta, evento, baixa e portal | Sandbox e depois piloto autorizado, valores/recebedor conferidos e restauração exercitada |
| 4 | Carteira legada quando aplicável | IDs preservados, somatórios conferidos, recebimentos antigos conciliados e reversão ensaiada |
| 5 | Ciclo comercial/rede, régua e operação assistida | Pagamento e reativação pendente apresentados separadamente; mensagens e eventos sem efeito duplicado |
| 6 | Huawei físico e catálogo de evidências; próxima família disponível no piloto | Modelo/firmware, respostas sanitizadas, leitura posterior e recuperação documentadas |
| 7 | Segundo PSP, mais drivers e recursos adicionais | Nova integração comprova os mesmos contratos sem duplicar domínios ou reescrever a UI |

As frentes financeira e de equipamentos compartilham isolamento, auditoria, resultado incerto e recuperação, mas têm critérios de aceite próprios. A liberação continua subordinada às [pendências](pendencias.md), ao [roteiro do piloto](PILOTO.md) e às garantias da [arquitetura](arquitetura.md).

## 8. Verificação desta entrega

Foi conferido o download integral, a leitura UTF-8, os tamanhos, hashes, a relação textual FIN-V1/FIN-V2 e os caminhos locais citados. Os originais foram preservados e receberam links no índice documental. Não foram executados comandos dos anexos, instaladas bibliotecas, realizadas chamadas a PSPs com credenciais, feitas mutações operacionais ou executados ensaios físicos. Não foi rodada regressão da aplicação: esta entrega modifica somente documentação e não constitui auditoria completa do produto.
