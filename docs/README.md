# Documentação do NexoISP

Documentação de referência e de operação. Planos já executados, prompts de implementação, comparativos antigos e diários de desenvolvimento foram removidos; seu histórico permanece no Git.

| Documento | Quando consultar |
|---|---|
| [Arquitetura](arquitetura.md) | Componentes atuais, decisões técnicas e garantias que devem ser preservadas |
| [Pendências](pendencias.md) | Bloqueios de produção, homologações e evolução ainda necessária |
| [Auditoria comparativa SGP](SGP_COMPARATIVO_NEXOISP/README.md) | Evidências, diferenças, backlog, melhorias implementadas e validação rastreável |
| [Operação](operacao.md) | Instalação, segurança, configuração dos módulos, monitoramento, backup e recuperação |
| [API pública](api-publica.md) | Tokens, escopos, idempotência e webhooks para integrações |
| [Importação CSV](importacao-csv.md) | Formatos de assinantes, títulos e histórico; prévia, corte e reversão |
| [Migração SGP](10-migracao-sgp.md) | Uso das ferramentas de leitura e mapeamento dos dados de origem |
| [Laboratório PPPoE](lab-pppoe.md) | Roteiro reproduzível e limites da validação de rede |
| [OLT/ONU](expansao-olt-onu.md) | Operação do driver Huawei, comandos e roteiro de homologação |
| [Referência da API do SGP](API-SGP-completa.txt) | Material de terceiro utilizado pelas ferramentas em `tools/sgp-migracao`; descreve entradas, sem garantir formatos de resposta |

O backend da aplicação usa Go. Agente Python, FreeRADIUS e GenieACS são componentes separados; React/Vite continua sendo a ferramenta de frontend. Instruções específicas do backend ficam em [apps/api-go/README.md](../apps/api-go/README.md).

Implementação e teste em laboratório não equivalem a homologação no provedor. A liberação comercial depende dos critérios em [Operação](operacao.md#7-lista-de-entrada-em-produção-preencher-com-o-provedor).
