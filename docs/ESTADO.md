# Estado do NexoISP

**Atualizado em 09/11/2026.** Este é o resumo de referência. Os relatórios de lotes (`LOTE*`, `CONCLUSAO-INTEGRAL*`, `RELATORIO-GERAL-*`, `CORRECOES-*`) saíram do repositório em 09/11/2026 e continuam acessíveis na tag `arquivo/pre-limpeza-2026-11-09`.

## Auditoria local atual

A [auditoria de 06/11/2026](auditoria-2026-11-06/RELATORIO.md) corrige guardas de recuperação e produtividade das filas sem publicar o serviço. A baseline inicial foi `9119c57`, com diretório limpo. O relatório distingue provas novas, evidências históricas e limitações. A causa da divergência entre os dois CIs dessa baseline continua **inconclusiva**, pois os logs completos exigem acesso autenticado. Uma execução local verde não a resolve.

Avaliação local sintética: aprovada no recorte validado. Publicação e piloto: **ainda bloqueados**; ações exatas na [lista externa única](auditoria-2026-11-06/PENDENCIAS-EXTERNAS.md). Backup local não protege contra perda do host; metas de RPO/RTO ainda precisam do operador. A aplicação antiga está parada e o virtual host local responde como PNETLab; [configuração proposta de publicação](auditoria-2026-11-06/PUBLICACAO.md), atualizada para Nginx central → Apache com VirtualHost exclusivo → Caddy em loopback, sem alterações nos serviços. O ChatISP já tem VirtualHost próprio; o NexoISP ainda não tem upstream ativo validado.

## Rodada de conclusão — 09/11/2026

Tudo o que estava pela metade ou só planejado e dependia apenas de código foi implementado, testado com PostgreSQL real e validado no navegador. Decisões e itens deliberadamente não implementados estão em [Decisões](DECISOES.md).

| Entrega | Situação | Migração |
|---|---|---|
| Projeto físico FTTH: cabos com traçado, fusões por caixa, medições OTDR com arquivo bruto, importação KML com prévia | Pronto | 00087 |
| Campo: check-in/check-out com geolocalização, assinatura do cliente, foto pela câmera, fila offline idempotente | Pronto | 00088 |
| Liquidação de comissões: período congelado, pagamento, estorno, CSV | Pronto | 00089 |
| Estoque: custo médio ponderado, valor do estoque e contas a pagar geradas no recebimento | Pronto | 00090 |
| Template TR-069 de CPE (`/rede/ftth/acs-template`) com aplicação por intenção ACS durável | Pronto | 00091 |
| Acompanhamento operacional (`/acompanhamento`) e assistente determinístico (`/assistente`) | Pronto | — |
| Consulta pública de viabilidade (`/viabilidade/<slug>`) com captação de prospecto | Pronto | 00092 |
| Senha provisória com troca obrigatória e encerramento de sessões na redefinição | Pronto | 00093 |
| Arquivo DICI no leiaute do Manual de Coleta SCM, com bloqueio por pendências | Pronto (tabela de tecnologias conferida em 2026-11-10) | — |
| Multa e juros da política na emissão de boleto Efí | Pronto em código; homologação Efí pendente | — |
| Deduplicação de alertas persistida no banco | Pronto | 00094 |
| IP real do cliente atrás de Nginx → Apache → Caddy (`NEXO_TRUSTED_PROXIES`) | Pronto em código; conferir na publicação | — |
| Loop de reinício da VPN, `./nexo doctor`, travas de versão/documentação/material de terceiro | Pronto | — |

Nenhum destino do menu cai mais em "Recurso planejado". A matriz funcional não tem unidade pendente.

Validação executada neste servidor sobre o `main` integrado (09/11/2026):

| Verificação | Resultado |
|---|---|
| Go: build, vet, golangci-lint | Sem erros |
| Suíte Go com PostgreSQL 16 real e `-race` | Aprovada, sem falhas nem testes pulados |
| Frontend: TypeScript, 228 testes, build de produção | Aprovados |
| Navegador: 42 cenários da fumaça + intenção de pagamento + cenários com ACS sintético (CPE e template) | Aprovados |
| Contratos do workflow: instalação nativa com duas réplicas e manifesto de rotas, migrações financeiras, efeitos de pagamento, resiliência, restore em cluster limpo, auditoria SGP, imagem da VPN, SBOM | Aprovados |
| Matriz funcional | 196 unidades; 176 integradas e validadas, cada uma com verificação de interface; nenhuma pendente |

Por último, as imagens `:20261110h` (backup de config de Intelbras/FiberHome/VSOL/Parks por CLI sobre o transporte OS, migração 00103; **frontend reconstruído** — os deploys `:b`..`:g` traziam `apps/web/dist` de 04:18, sem a UI de hoje, inclusive a tela de backup; `:h` corrige), backup em `backups/pre-atualizacao-20261110h.dump` e volta por `compose.yaml.20261110g`. Antes, as imagens `:20261110g` (driver de OLT Datacom DmOS — identidade e backup de config, validado ao vivo; migração 00102), com backup em `backups/pre-atualizacao-20261110g.dump` e volta por `compose.yaml.20261110f`. Antes, as imagens `:20261110f` (driver de OLT ZTE ZXA10 — leitura de ONU e backup de config, validado ao vivo; migração 00101), com backup em `backups/pre-atualizacao-20261110f.dump` e volta por `compose.yaml.20261110e`. Antes, as imagens `:20261110e` (backup semanal da configuração das OLTs e concentradores com agente, 4 cópias cifradas; migração 00100), com backup em `backups/pre-atualizacao-20261110e.dump` e volta por `compose.yaml.20261110d`. Antes, as imagens `:20261110d` (segunda rodada do estudo de campo: registro de NAT e faixa pública no CGNAT, VLAN pelo NAS-Port-Id, qos-profile Huawei, `src-address`, avisos de gerência no NOC; migrações 00098–00099), com backup em `backups/pre-atualizacao-20261110d.dump` e volta por `compose.yaml.20261110c`. Depois, as imagens `:20261110c` (grupos B e C do estudo de campo, migrações 00096–00097), com backup em `backups/pre-atualizacao-20261110c.dump` e volta por `compose.yaml.20261110b`. Ainda em 10/11/2026 o painel passou às imagens `:20261110b` (grupo A do estudo de campo: layout do CGNAT e IPv6 na consulta de ofício, migração 00095), com backup em `backups/pre-atualizacao-20261110b.dump` e volta por `compose.yaml.20261110`. Em 10/11/2026 o painel (servido em nexoisp.tokstiloesporte.com) passou às imagens `:20261110` (auditoria das subações, aviso da demonstração e código ADSL2 do DICI), com backup prévio em `backups/pre-atualizacao-20261110.dump` e volta possível por `compose.yaml.20261109`. O painel local de avaliação (`127.0.0.1:18380`, `~/.local/share/nexoisp/painel-20261106`) foi atualizado para esta versão em 09/11/2026 (migrações até 00094), com backup prévio em `backups/pre-atualizacao-20261109.dump`; as imagens `:20261106` e o `compose.yaml.20261106` permitem voltar. O CI do GitHub não foi consultado daqui (sem `gh`); a bateria equivalente rodou localmente.

## Base

- Evidência histórica: código em `main` e `dev/lote01-consolidado-2026-10-26` no commit `42b8154` à época da validação. A auditoria atual partiu de `9119c57` e gera somente commits locais; não houve push. O workflow `backend Go e painel` passou nesse commit (execuções 41174481523 em `main` e 41174481387 em `dev`), incluindo os contratos com PostgreSQL, o painel real contra o Go e o SBOM.
- Não houve deploy, produção, migração de dados reais nem homologação em equipamento físico ou com gateway real.
- Entregue nesta etapa: coluna `ip_fixo` na importação CSV (assinantes e contratos), com as regras da alocação manual do IPAM e sem enviar nada ao equipamento ([Importação CSV](importacao-csv.md)).

## Funcionalidades implementadas

| Área | O que existe |
|---|---|
| Cadastro e privacidade | Assinantes, ficha, vários contratos por titular, contatos e consentimento, documentos, anotações, linha do tempo, exportação pessoal e anonimização |
| Comercial | Planos versionados, adicionais e combos, vencimento, fidelidade e multa, descontos, mudança agendada, aditivo, aceite simples, etiquetas, empresa e POP, viabilidade pública com captação de prospecto, liquidação de comissões |
| Financeiro | Geração por competência, baixa manual integral/parcial com taxas e desconto, estorno, cancelamento, acordos, prazo de confiança, degraus de cobrança, relatórios, CSV contábil; conexões financeiras isoladas e pipeline Efí apenas em sandbox interno; multa e juros enviados na emissão Efí; contas a pagar |
| Atendimento e campo | Chamados, protocolos, OS com checklist, kits, materiais, equipamentos por série, anexos privados, agenda, SLA com expediente e feriados, pesquisa de satisfação, tela móvel, check-in/check-out, assinatura do cliente, foto pela câmera e fila offline |
| Estoque e compras | Materiais, depósitos, transferências, fornecedores, pedidos, cotações com pedido rascunho, custo médio e valor do estoque, contas a pagar |
| Portal do assinante | Contratos, títulos, uso, Wi-Fi do próprio CPE, atendimento, aceite e marca opcional do provedor |
| Rede e acesso | Agente com mTLS e comandos assinados, RADIUS integrado, provisionar/suspender/reativar/desconectar, IP fixo e prefixo IPv6, VPN WireGuard e L2TP/IPsec, TR-069, OLT Huawei (apenas emulador), CGNAT e IPAM, NOC por regras, templates TR-069 por modelo, projeto físico FTTH (cabos, fusões, OTDR, KML) |
| Administração e integrações | Equipe e perfis, módulos por provedor, API pública com tokens, webhooks assinados, auditoria e retenção, prévia DICI, importação CSV (assinantes, contratos, títulos, histórico, documentos, usuários, rede), arquivo DICI no leiaute SCM, senha provisória com troca obrigatória, acompanhamento operacional e assistente |
| Operação | Preflight de produção, backup diário por systemd com manifesto, `restore-check`, gancho de cópia externa, métricas Prometheus e alertas, réplica em espera, `./nexo doctor`, deduplicação de alertas persistida |

## Jornadas do primeiro piloto

Cada jornada lista o que já existe e **apenas** o que impede usá-la no piloto.

| Jornada | O que existe | Lacuna que impede o uso | Tipo |
|---|---|---|---|
| J1 Cadastro e contrato | Cadastro, contratos, planos e importação CSV completa, incluindo IP fixo | Exportação autorizada da origem (SGP ou IXC) e conferência do mapeamento | Recurso externo |
| J2 Cobrança e recebimento | Geração de títulos, baixa manual, estorno, acordos, CSV contábil | Na fase 1 a cobrança fica no sistema atual (decisão abaixo); nada impede o piloto. Cobrança pelo NexoISP exige gateway homologado | Fora da fase 1 (sandbox Efí no futuro) |
| J3 Ativação, bloqueio e reativação | Provisionamento, suspensão por rejeição ou perfil, reativação e desconexão pelo agente e RADIUS integrado, todos manuais na fase 1 e conferidos pelo preflight | Só validado no MikroTik CHR virtual; falta o NAS físico do piloto | Recurso externo (NAS) |
| J4 Atendimento e OS | Chamados, OS, agenda, estoque, campo e anexos | Nenhuma: sem avisos automáticos na fase 1 | Pronta para homologação de uso |
| J5 Recuperação | Backup diário, manifesto, `restore-check`, gancho `NEXO_BACKUP_COPY`, preflight, alertas Prometheus; ensaio em cluster limpo e guardas do restore operacional auditadas | Host do piloto, destino externo da cópia, cofre de chaves, canal de alertas | Recurso externo |

## Correções internas

| Item | Situação |
|---|---|
| IP fixo na importação CSV | Feito em 02/11/2026, com testes em PostgreSQL real (aceite, rejeições, reimportação, prévia, permissão, isolamento entre provedores e concorrência) |
| Preflight da fase 1 do piloto | Feito em 02/11/2026: `NEXO_PILOTO_FASE=1` faz o preflight conferir as decisões abaixo, com teste em PostgreSQL real |
| Recuperação auditada em 06/11 | Corrigidas lacunas locais: destino explícito, autenticação de dump/manifesto, validação antes da substituição e retomada bloqueada em falha. Ver relatório para prova e limites |

## Decisões do piloto — fase 1

Tomadas pelo dono em 02/11/2026, que pediu as opções recomendadas e informou não poder fornecer, por ora, equipamento físico, contas de pagamento, OLT nem concentrador.

| Tema | Decisão |
|---|---|
| Cobrança | Fica no sistema atual do provedor. O NexoISP cuida de cadastro, contratos, acesso e OS; títulos podem ser importados apenas para consulta, sem dois financeiros sobre os mesmos títulos |
| Fiscal | **Fiscal inativo neste piloto** (fecha B14 como não aplicável nesta fase) |
| Suspensão | Manual, pelo painel, no modo que o NAS do piloto suportar (rejeição ou perfil de bloqueio) |
| Reativação | Manual; o pagamento não reativa sozinho |
| Avisos ao assinante | Nenhum aviso automático |
| Recuperação | Meta de RPO 24 h (backup diário) e RTO 4 h, a confirmar com o provedor quando ele for definido |

Com `NEXO_PILOTO_FASE=1`, o `./nexo prod db preflight` reprova o ambiente se houver gateway configurado, geração automática de cobrança, suspensão automática, reativação automática por pagamento ou canal de aviso ao assinante ativo. Essas decisões são revistas quando houver gateway homologado e NAS do piloto.

## Recursos externos necessários

- Provedor piloto, grupo de contratos reversível, responsáveis e janela.
- Exportação autorizada da base atual (SGP ou IXC) para conferir o mapeamento.
- NAS e firmware usados pelo provedor, com acesso para o roteiro PPPoE/RADIUS.
- Host do piloto com domínio, DNS, HTTPS e segredos próprios.
- Destino externo para backup, cofre para chaves e canal para alertas.
- Para fases seguintes, não para a fase 1: conta sandbox Efí (cobrança pelo NexoISP), WhatsApp oficial ou canal HTTP (avisos automáticos), OLT e CPEs do provedor.

Em 02/11/2026 o dono informou que nenhum desses recursos está disponível agora. Até chegarem, o piloto não pode começar. A auditoria atual encontrou e corrigiu lacunas locais adicionais; não presumir ausência de lacunas por falta de recursos externos.

## Homologações pendentes

PPPoE/RADIUS no NAS físico (o laboratório de 02/11/2026 exercitou o RADIUS integrado com um MikroTik virtual real e simuladores Huawei/Cisco, sem homologar Huawei/Cisco: [Laboratório PPPoE, seção 6](lab-pppoe.md)); suspensão, perfil e página de aviso no NAS; gateway em sandbox e depois real; OLT e TR-069 nos modelos do piloto; CGNAT e IPv6 no concentrador real; failover do RADIUS e do banco em hosts distintos; restauração em host físico; capacidade com o volume do piloto; uso assistido e revisão de segurança independente. Detalhes em [Pendências](pendencias.md).

## Backlog fora do piloto

Itens deliberadamente não implementados, com motivo em [Decisões](DECISOES.md): fiscal integrado (NFCom/NFS-e), segundo gateway, OLT de outros fabricantes sem equipamento, CoA (mudança de perfil sem derrubar a sessão; hoje a troca de plano reautentica a sessão), IA com modelo externo, multicélulas e transmissão automática do DICI (a ANATEL não oferece API). Trabalho offline, assinatura na OS, liquidação de comissões e arquivo DICI foram entregues em 09/11/2026. Chatwoot/Webchat estão fora do escopo.

## Solidificação OLT (2026-11-11)
- Seletor de driver no painel passou a oferecer os drivers reais de OLT (ZTE/Datacom/Intelbras/FiberHome/VSOL/Parks) sob o módulo OLT, além de Huawei; inventário mostra o fabricante por driver.
- Leitura de ONU validada em campo: Huawei, ZTE, Datacom, Intelbras, FiberHome (estado + sinal). VSOL/Parks: só backup (acesso pendente). EPON: sem equipamento.
- Autorizar/desautorizar ONU seguem PENDENTES e recusadas nos drivers; plano de homologação em lab em `docs/estudo-campo/plano-provisionamento-lab.md`.
