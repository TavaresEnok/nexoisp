# Documentação do NexoISP

Documentação de referência e de operação. Planos já executados, prompts de implementação, comparativos antigos e diários de desenvolvimento foram removidos; seu histórico permanece no Git.

| Documento | Quando consultar |
|---|---|
| [Arquitetura](arquitetura.md) | Componentes atuais, decisões técnicas e garantias que devem ser preservadas |
| [Integração do frontend v0](integracao-v0/PLANO.md) | Sete etapas, regra obrigatória de UI/UX, preservação e situação da integração |
| [Aplicação oficial e validação](integracao-v0/OPERACAO.md) | Execução do frontend, laboratório descartável e limites preservados |
| [Matriz funcional da integração](integracao-v0/MATRIZ_FUNCIONAL.md) | 174 unidades: 154 integradas e validadas e 20 capacidades preservadas |
| [Pendências](pendencias.md) | Bloqueios de produção, homologações e evolução ainda necessária |
| [Roteiro do primeiro piloto](PILOTO.md) | Portões de entrada, corte, recuperação e acompanhamento do primeiro provedor |
| [Auditoria comparativa SGP](SGP_COMPARATIVO_NEXOISP/README.md) | Evidências, diferenças, backlog, melhorias implementadas e validação rastreável |
| [Robustez operacional](ROBUSTEZ-OPERACIONAL.md) | Jobs por provedor, limite entre réplicas, provas de recuperação, monitoramento e limites de aceite |
| [Operação](operacao.md) | Instalação, segurança, configuração dos módulos, monitoramento, backup e recuperação |
| [API pública](api-publica.md) | Tokens, escopos, idempotência e webhooks para integrações |
| [Importação CSV](importacao-csv.md) | Formatos de assinantes, títulos e histórico; prévia, corte e reversão |
| [Migração SGP](10-migracao-sgp.md) | Uso das ferramentas de leitura e mapeamento dos dados de origem |
| [Laboratório PPPoE](lab-pppoe.md) | Roteiro reproduzível e limites da validação de rede |
| [OLT/ONU](expansao-olt-onu.md) | Operação do driver Huawei, comandos e roteiro de homologação |
| [Análise dos três relatórios recebidos](ANALISE_RELATORIOS_FINANCEIRO_E_EQUIPAMENTOS_2026-10-24.md) | Comparação das versões financeiras, avaliação do dossiê de equipamentos, aderência ao código e prioridades propostas |
| [Relatório financeiro consolidado v2](NexoISP_Relatorio_Financeiro_Consolidado_v2_2026-10-24.md) | Planejamento financeiro recebido em 24/10/2026; propostas A01–A20, sem comprovação de implementação |
| [Arquitetura financeira original](NexoISP_Relatorio_Arquitetura_Financeira_Open_Source_2026-10-23%281%29.md) | Versão financeira de 23/10/2026 preservada como histórico; consultar a v2 para o planejamento atualizado |
| [Dossiê de equipamentos v1.2](NexoISP_Dossie_Completo_Integracoes_Equipamentos_OpenSource_2026-10-24_v1.2.md) | Pesquisa de integrações e comandos candidatos por família; não representa homologação física |
| [Referência da API do SGP](API-SGP-completa.txt) | Material de terceiro utilizado pelas ferramentas em `tools/sgp-migracao`; descreve entradas, sem garantir formatos de resposta |

O backend da aplicação usa Go. Agente Python, FreeRADIUS e GenieACS são componentes separados; React/Vite continua sendo a ferramenta de frontend. Instruções específicas do backend ficam em [apps/api-go/README.md](../apps/api-go/README.md).

Implementação e teste em laboratório não equivalem a homologação no provedor. A liberação comercial depende dos critérios em [Operação](operacao.md#7-lista-de-entrada-em-produção-preencher-com-o-provedor).
