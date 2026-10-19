# Triagem das capacidades anteriormente agrupadas como backend preservado

Reconciliada em 19/10/2026 após o achado R04. São 169 unidades: **149 integradas e validadas**, **14 serviços internos**, **dois contratos externos** e **quatro limitações existentes**. Não há capacidade de negócio disponível dispensada de interface apenas por ter sido inventariada como “somente backend”. `backendState`, `behavior` e as fontes do inventário descrevem o levantamento original; `integrationClassification`, `integrationNotes` e `validation` descrevem a integração atual.

## Capacidades de negócio

| Unidade | Apresentação operacional e validação |
|---|---|
| BE-03 | Endereço de instalação na ficha comercial do contrato; `frontend-v0-commercial.mjs` |
| BE-04 | Selecionar assinante indicador, gravar e remover indicação na ficha comercial; rejeição de autoindicação, escrita indevida e acesso entre provedores em `frontend-v0-remediation.mjs` |
| BE-05 | Classificação estruturada de atendimento e conversão de lead para assinante existente, além de criar um novo; `frontend-v0-remediation.mjs` |
| BE-06 | Redefinir senha de usuário, editar POP/empresa e catálogos/políticas/campos personalizados; `frontend-v0-admin-team.mjs` e `frontend-v0-quality.mjs` |
| BE-07 | Editor de propriedades do equipamento e editor de pool; `frontend-v0-remediation.mjs` e `frontend-v0-ipam.mjs`. Referência de credencial não é leitura ou exposição do segredo do equipamento |
| BE-08 | Consulta CGNAT por IP privado e titulares históricos; `frontend-v0-cgnat-legal.mjs`; permanecem as limitações de laboratório e IPv6 |
| BE-09 | Plano/POP/etiqueta na carteira e CSV; empresa no arquivo contábil; `frontend-v0-remediation.mjs` |
| BE-24 | Relatório real em `/relatorios/indicacoes`, menu Financeiro, busca e link na ficha; leitura depende de `finance:read`; `frontend-v0-remediation.mjs`. O limite de linhas retornado pelo Go fica explícito, sem comissão inventada |
| BE-26 | Nova fatura avulsa na interface financeira; `frontend-v0-finance.mjs` |
| BE-27 | Excluir etiqueta global com confirmação na ficha; `frontend-v0-remediation.mjs` |

Algumas apresentações já existiam no checkpoint revisado, mas sua evidência não havia sido associada aos itens BE. A classificação agora distingue correção de documentação e implementação nova. Os caminhos de evidência por item estão no [JSON da matriz](matriz-funcional.json).

## Serviços internos preservados

Não exigem uma página adicional para reproduzir protocolos ou processamento do servidor. As ações e resultados de negócio correspondentes continuam nas telas operacionais existentes. Preservação do serviço não significa homologação física nova.

| Unidade | Motivo da classificação |
|---|---|
| BE-10 | Protocolo autenticado de comunicação agente/servidor, separado da navegação humana |
| BE-11 | Fila transacional, assinatura, idempotência e recuperação de comandos; implementação exclusiva do backend |
| BE-12 | Protocolo RADIUS/accounting/desconexão; contas, sessões e estado são apresentados nas telas de acesso/rede |
| BE-13 | Executor Python instalado no ambiente de rede; comandos são solicitados e acompanhados pela interface existente |
| BE-14 | Serviço VPN e ferramentas do host; cadastro/instruções/estado dos NAS já são apresentados na rede |
| BE-15 | Adaptador Go/GenieACS; a interface existente de CPE apresenta parâmetros e tarefas, sem duplicar o ACS |
| BE-16 | Jobs de cobrança e reconciliação; configuração e operações financeiras já expostas, execução depende de habilitação |
| BE-17 | Workers de avisos, webhooks, SLA e retenção; configuração, filas e políticas expostas nas respectivas telas |
| BE-18 | Jobs RADIUS/accounting/agregação; consultas de uso e sessões dependem de dados efetivamente recebidos |
| BE-19 | Ferramenta administrativa `nexo-db`, migrações e rotação de segredos, executadas na infraestrutura |
| BE-20 | Sessão, CSRF, MFA, permissões e RLS; não se reimplementam no navegador. Fluxos humanos de sessão/MFA têm telas e testes |
| BE-21 | Listener de métricas, logs e especificação interna; preservação de observabilidade do servidor |
| BE-22 | Scripts de backup, cópia e restauração da infraestrutura; não se transforma execução privilegiada em operação do navegador |
| BE-25 | Relação de origens NAS consumida internamente pelo RADIUS; cadastro humano dos equipamentos permanece na rede |

## Contratos externos

| Unidade | Motivo da classificação |
|---|---|
| BE-01 | Consultas `/public/v1` para sistemas externos, com tokens, escopos e limites; administração de tokens integrada e testada em `frontend-v0-integrations.mjs` |
| BE-02 | Criação de atendimento/OS por consumidores da API pública, com idempotência; criação humana já integrada em CRM/OS, sem duplicar um cliente público na UI |

Esses protocolos permanecem no backend. Esta correção não declara uma nova execução completa de todos os contratos públicos externos.

## Limitações existentes

| Unidade | Limite preservado |
|---|---|
| FI-17 | Não existe gateway bancário real integrado para gerar Pix/boleto pagável |
| AD-20 | Importação CSV intermediária existe; migração universal direta de SGP/MK-Auth não existe |
| PO-09 | Quitação em instituição financeira depende de gateway real ausente; demonstração não é pagamento bancário |
| BE-23 | Banco restrito à célula `c1`; distribuição e migração multicélula não estão implementadas |

Os três tipos visuais sem catálogo CRUD correspondente no Go (`network-pon`, `network-onu-models` e `network-onu-templates`) continuam identificados como planejados. Leituras PON disponíveis permanecem no NOC. Isso não bloqueia equipamentos/NAS/OLT, que agora têm destinos operacionais corretos. Os 420 nós do catálogo v0 não representam 420 funcionalidades existentes no Go.
