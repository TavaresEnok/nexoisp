# Estado do NexoISP

**Atualizado em 02/11/2026.** Este é o resumo de referência. Os documentos `LOTE*`, `CONCLUSAO-INTEGRAL*`, `RELATORIO-GERAL-*` e `CORRECOES-*` ficam como histórico: os estados que eles descrevem eram válidos na data de cada um e não são repetidos aqui.

## Base

- Código publicado em `main` e `dev/lote01-consolidado-2026-10-26` no commit `42b8154`. O workflow `backend Go e painel` passou nesse commit (execuções 41174481523 em `main` e 41174481387 em `dev`), incluindo os contratos com PostgreSQL, o painel real contra o Go e o SBOM.
- Não houve deploy, produção, migração de dados reais nem homologação em equipamento físico ou com gateway real.
- Entregue nesta etapa: coluna `ip_fixo` na importação CSV (assinantes e contratos), com as regras da alocação manual do IPAM e sem enviar nada ao equipamento ([Importação CSV](importacao-csv.md)).

## Funcionalidades implementadas

| Área | O que existe |
|---|---|
| Cadastro e privacidade | Assinantes, ficha, vários contratos por titular, contatos e consentimento, documentos, anotações, linha do tempo, exportação pessoal e anonimização |
| Comercial | Planos versionados, adicionais e combos, vencimento, fidelidade e multa, descontos, mudança agendada, aditivo, aceite simples, etiquetas, empresa e POP |
| Financeiro | Geração por competência, baixa manual integral/parcial com taxas e desconto, estorno, cancelamento, acordos, prazo de confiança, degraus de cobrança, relatórios, CSV contábil; conexões financeiras isoladas e pipeline Efí apenas em sandbox interno |
| Atendimento e campo | Chamados, protocolos, OS com checklist, kits, materiais, equipamentos por série, anexos privados, agenda, SLA com expediente e feriados, pesquisa de satisfação, tela móvel |
| Estoque e compras | Materiais, depósitos, transferências, fornecedores, pedidos, cotações com pedido rascunho |
| Portal do assinante | Contratos, títulos, uso, Wi-Fi do próprio CPE, atendimento, aceite e marca opcional do provedor |
| Rede e acesso | Agente com mTLS e comandos assinados, RADIUS integrado, provisionar/suspender/reativar/desconectar, IP fixo e prefixo IPv6, VPN WireGuard e L2TP/IPsec, TR-069, OLT Huawei (apenas emulador), CGNAT e IPAM, NOC por regras |
| Administração e integrações | Equipe e perfis, módulos por provedor, API pública com tokens, webhooks assinados, auditoria e retenção, prévia DICI, importação CSV (assinantes, contratos, títulos, histórico, documentos, usuários, rede) |
| Operação | Preflight de produção, backup diário por systemd com manifesto, `restore-check`, gancho de cópia externa, métricas Prometheus e alertas, réplica em espera |

## Jornadas do primeiro piloto

Cada jornada lista o que já existe e **apenas** o que impede usá-la no piloto.

| Jornada | O que existe | Lacuna que impede o uso | Tipo |
|---|---|---|---|
| J1 Cadastro e contrato | Cadastro, contratos, planos e importação CSV completa, incluindo IP fixo | Exportação autorizada da origem (SGP ou IXC) e conferência do mapeamento | Recurso externo |
| J2 Cobrança e recebimento | Geração de títulos, baixa manual, estorno, acordos, CSV contábil | Sem gateway homologado o NexoISP não emite boleto/Pix real; falta decidir quem cobra no piloto e se o fiscal está ativo | Decisão + recurso externo (sandbox Efí) |
| J3 Ativação, bloqueio e reativação | Provisionamento, suspensão por rejeição ou perfil, reativação e desconexão pelo agente e RADIUS integrado; suspensão automática desligada por padrão e conferida pelo preflight | Só validado no MikroTik CHR virtual; falta o NAS físico do piloto. Falta decidir se a suspensão será manual ou automática e se o pagamento reativa sozinho | Decisão + recurso externo (NAS) |
| J4 Atendimento e OS | Chamados, OS, agenda, estoque, campo e anexos | Nenhuma para uso interno. Avisos automáticos ao assinante dependem de canal (WhatsApp oficial ou HTTP) | Decisão (avisos sim/não) |
| J5 Recuperação | Backup diário, manifesto, `restore-check`, gancho `NEXO_BACKUP_COPY`, preflight, alertas Prometheus; ensaio em cluster limpo | Host do piloto, destino externo da cópia, cofre de chaves, canal de alertas; falta definir RPO/RTO | Recurso externo + decisão |

## Correções internas

| Item | Situação |
|---|---|
| IP fixo na importação CSV | Feito em 02/11/2026, com testes em PostgreSQL real (aceite, rejeições, reimportação, prévia, permissão, isolamento entre provedores e concorrência) |
| Outras lacunas internas das jornadas | Nenhuma encontrada que não dependa de decisão ou recurso abaixo |

## Decisões do dono

As recomendações abaixo são sugestões e não foram tomadas como decisão.

| Pergunta | Recomendação |
|---|---|
| No piloto, a cobrança fica no sistema atual ou passa ao NexoISP com baixa manual? | Manter no sistema atual na primeira fase; NexoISP com cadastro, acesso e OS. Evita dois financeiros sobre os mesmos títulos |
| O fiscal está ativo neste piloto? | Registrar "fiscal inativo neste piloto" se a cobrança ficar no sistema atual |
| Suspensão manual ou automática? Por rejeição ou por perfil de bloqueio? | Manual, com o modo que o NAS do piloto suportar; automática só depois de gateway e conciliação homologados |
| O pagamento confirmado reativa sozinho? | Não na primeira fase; reativação manual |
| O piloto envia avisos automáticos ao assinante? | Não na primeira fase |
| Qual perda de dados e tempo de recuperação aceitáveis? | RPO de 24 h (backup diário) e RTO de 4 h, a confirmar com o provedor |

## Recursos externos necessários

- Provedor piloto, grupo de contratos reversível, responsáveis e janela.
- Exportação autorizada da base atual (SGP ou IXC) para conferir o mapeamento.
- NAS e firmware usados pelo provedor, com acesso para o roteiro PPPoE/RADIUS.
- Host do piloto com domínio, DNS, HTTPS e segredos próprios.
- Destino externo para backup, cofre para chaves e canal para alertas.
- Conta sandbox Efí, somente se a cobrança passar ao NexoISP.
- WhatsApp oficial (WABA) ou canal HTTP, somente se houver avisos automáticos.

## Homologações pendentes

PPPoE/RADIUS no NAS físico; suspensão, perfil e página de aviso no NAS; gateway em sandbox e depois real; OLT e TR-069 nos modelos do piloto; CGNAT e IPv6 no concentrador real; failover do RADIUS e do banco em hosts distintos; restauração em host físico; capacidade com o volume do piloto; uso assistido e revisão de segurança independente. Detalhes em [Pendências](pendencias.md).

## Backlog fora do piloto

Fiscal integrado, segundo gateway, trabalho offline e assinatura na OS, OLT de outros fabricantes, CoA, IA assistiva, multicélulas, liquidação de comissões e transmissão DICI. Continuam registrados em [Pendências](pendencias.md); Chatwoot/Webchat estão fora do escopo.
