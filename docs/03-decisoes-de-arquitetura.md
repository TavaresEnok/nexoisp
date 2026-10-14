# NexoISP — Decisões de arquitetura

Versão 1.0 · 9 de outubro de 2026

## Uso

Este arquivo reúne os ADRs de forma compacta para acelerar o início. Não é necessário criar quatorze arquivos separados agora. “Base de implementação” significa a recomendação técnica consolidada deste pacote; não afirma uma homologação ou uma aprovação jurídica/comercial.

Quando uma decisão mudar, registrar data, motivo e consequência. Preservar identificadores para que tarefas e código possam referenciá-los.

## ADR-001 — Monólito modular

**Situação:** base de implementação.

Usar Fastify/TypeScript como backend central. Separar módulos de identidade, cadastro, contratos, financeiro e rede, com acesso controlado entre eles. Workers podem usar o mesmo código em processos próprios. Frontend React/TypeScript.

Não criar FastAPI central, microserviços por tabela, barramento universal ou arquitetura de plugins sem necessidade demonstrada.

## ADR-002 — Tarefas de rede no PostgreSQL

**Situação:** base de implementação.

PostgreSQL é a fonte de verdade para intenções e tarefas. Reservar itens com transações curtas e controle de posse; `SKIP LOCKED` pode distribuir trabalho, mas não garante exclusão de efeitos no dispositivo.

Gravar estado desejado e solicitação relacionada atomicamente. Não manter locks SQL abertos durante comandos de rede. Outbox entra quando houver publicação externa que precise de recuperação. Redis/BullMQ não são dependências obrigatórias do MVP.

## ADR-003 — Multi-tenancy

**Situação:** base de implementação.

Utilizar `tenant_id`, autorização no backend e RLS nas tabelas aplicáveis. A conexão comum da aplicação não pode ser proprietária das tabelas, superusuária ou ter `BYPASSRLS`. Migrations usam papel separado.

Aplicar contexto do tenant por transação, a partir de identidade autorizada. Considerar `FORCE ROW LEVEL SECURITY` conforme os papéis utilizados. Testar isolamento com o papel real, incluindo reutilização de conexão. Relacionamentos e índices devem respeitar o tenant.

Não colocar identificador de tenant livre enviado pelo navegador como autoridade de acesso.

## ADR-004 — RADIUS independente

**Situação:** base de implementação.

Autenticar com dados locais sincronizados e versionados. RADIUS continua durante indisponibilidade da nuvem e reinício do agente, dentro das condições locais disponíveis.

Dados locais representam a última política conhecida. Não prometer conhecimento de pagamentos ou cancelamentos ocorridos durante a partição. A falha do próprio servidor RADIUS exige recuperação ou redundância específica.

## ADR-005 — Seleção do motor RADIUS

**Situação:** pendente de prova técnica e avaliação de distribuição.

Comparar FreeRADIUS e ToughRADIUS para o fluxo exigido: autenticação, perfil, accounting, integração local, operação offline e manutenção. Verificar release e dependências antes de distribuir.

Para acelerar, a engenharia pode começar a prova com um candidato, registrando que é experimental, sem integrar dois motores ao mesmo tempo. Não afirmar licenças a partir de memória nem considerar a separação em processo uma solução jurídica automática.

## ADR-006 — Identidade e transporte do agente

**Situação:** base de implementação.

Agente inicia conexão de saída. Usar mTLS com identidade individual, vínculo ao tenant e equipamentos autorizados. Definir emissão, rotação e revogação.

Certificados locais podem ser gerados para desenvolvimento. Não desabilitar verificação TLS como padrão de produção e não exigir portas administrativas expostas na internet.

## ADR-007 — Operações estruturadas

**Situação:** base de implementação.

Catálogo inicial: `subscriber.provision`, `subscriber.suspend` e `subscriber.resume`. Validar schemas, autorização, integridade, versão e prazo. Não aceitar shell ou CLI arbitrários enviados pela interface.

Proteger o envelope persistido com assinatura verificada pelo agente, usando biblioteca consolidada; não inventar criptografia. A assinatura autentica o conteúdo, mas não torna atual uma intenção antiga.

Duplicatas legítimas devem ser reconhecidas. Identidade da operação, identidade da tentativa e proteção contra replay têm finalidades diferentes.

## ADR-008 — Persistência local

**Situação:** SQLite definido; proteção e gestão de chaves a detalhar na implementação.

Persistir tentativas, etapas e resultados necessários à recuperação. Usar transações locais e sincronização repetível. Se não conseguir registrar a tentativa de forma durável, não iniciar nova escrita no equipamento.

Limitar dados e evitar segredos em payloads. Definir armazenamento seguro de chaves, permissões e criptografia dos dados sensíveis para o ambiente de instalação escolhido. Não anunciar “SQLite criptografado” sem implementar e validar o mecanismo correspondente.

## ADR-009 — Atualização do agente

**Situação:** requisito antes do piloto distribuído.

Pacotes autenticados, atualização controlada e compatibilidade de protocolo. Definir parada segura, preservação do SQLite e recuperação de atualização interrompida.

Rollback de binário precisa respeitar a compatibilidade das migrations locais. Não prometer rollback automático universal. Na demonstração local, procedimento manual documentado é suficiente; no piloto, não aceitar download e execução de pacote sem verificação.

## ADR-010 — Financeiro e integrações

**Situação:** arquitetura definida; gateway e políticas pendentes.

Domínio financeiro próprio e um adaptador de gateway inicial. Separar fatura, pagamento e evento recebido. Deduplicar recorrência e eventos. Conciliar resultados incertos com o provedor externo.

Usar sandbox antes de produção. Valores divergentes seguem política explícita ou ficam em conciliação. Fiscal depende do processo real do piloto; não presumir que poderá ser adiado em qualquer provedor.

## ADR-011 — Migração

**Situação:** base de implementação; formato depende de amostra autorizada.

Importar por formato conhecido com simulação, validação, identificação de origem e reexecução segura. Relatar campos ausentes e conflitos. Não tentar adivinhar schemas de versões do MK-Auth.

Planejar corte e reversão com preservação dos eventos posteriores. Usar grupo controlado para a virada do RADIUS, com uma fonte autoritativa por grupo.

## ADR-012 — Matriz de equipamentos

**Situação:** MikroTik/RouterOS v7 como família inicial; versão e configuração exatas pendentes.

Começar com CHR e cliente PPPoE no laboratório. Homologar depois no equipamento do piloto. Registrar versão, configuração, operação e resultado.

Driver simulado serve ao desenvolvimento, não à declaração de compatibilidade. OLTs, CGNAT e outros fabricantes ficam para etapas posteriores.

## ADR-013 — Credenciais e auditoria

**Situação:** base de implementação; método de autenticação deve ser homologado.

Proteger credenciais dos equipamentos e segredos PPPoE em repouso e trânsito, restringir acesso e permitir rotação. O formato necessário ao RADIUS depende do método de autenticação selecionado.

Não gravar senhas em logs, auditoria ou fixtures reais. Não presumir que hash de login web serve a qualquer protocolo PPPoE. Usar referências de segredo quando possível. O modelo de distribuição do agente não garante sigilo absoluto do código instalado.

## ADR-014 — Reconciliação e resultados incertos

**Situação:** requisito desde a primeira implementação que altera serviço.

Manter versão crescente da intenção por recurso e evidência datada do estado observado. Na reconexão, sincronizar a visão válida antes de novas escritas. Snapshot incompleto não deve gerar exclusões.

Antes de executar, revalidar intenção e precondições. Se a tarefa ainda não começou e está obsoleta, substituí-la. Se pode ter produzido efeito, verificar e reconciliar com a intenção atual.

Persistir progresso. Após timeout, reinício ou perda de posse, consultar antes de repetir quando houver possibilidade de efeito. Não garantir “exatamente uma vez”.

Serializar operações conflitantes e começar com um executor por equipamento. Expiração da posse não prova que o executor anterior parou. Na transferência de execução, assegurar parada, isolamento ou revogação efetiva do executor anterior. Uma geração de executor na aplicação não impede sozinha comandos já enviados ao dispositivo.

Detectar alterações manuais e reportá-las. Não sobrescrever automaticamente divergência externa no MVP. Oferecer modo de manutenção que suspenda escritas do ERP.

Reconciliação cobre somente credenciais/políticas PPPoE, perfis e suspensão no conjunto homologado. Não implementar comparação universal permanente de toda a rede.

## Registro de decisões tomadas na implementação (10/10/2026)

Escolhas reversíveis feitas durante o desenvolvimento do MVP. Não alteram os ADRs acima; detalham como foram aplicados.

| Ref. | Decisão | Motivo / consequência |
|---|---|---|
| ADR-001 | SQL explícito com `pg` (sem Kysely); interface em CSS próprio (sem Tailwind/shadcn) | Menos dependências e build mais simples. Trocar depois não afeta o modelo de dados |
| ADR-001 | Identidade visual própria em CSS (sem Tailwind/shadcn): cores das áreas tiradas do código de cores da fibra óptica; tipografia Atkinson Hyperlegible, empacotada no build (sem requisição a serviço externo de fontes); ícones desenhados no próprio código; confirmações e avisos dentro do sistema; tema claro e escuro | Auditoria automática de acessibilidade (axe, WCAG 2 A/AA) sem violações em 12 telas em 10/10/2026. Não substitui teste com leitor de tela nem com usuários |
| ADR-001 | Rotinas periódicas (faturamento, conciliação, suspensão) rodam no processo da API, sob trava consultiva do PostgreSQL | Com mais de uma réplica, só uma executa por vez (a trava não foi exercitada com duas réplicas reais) |
| ADR-003 | RLS com `FORCE` desnecessário: papel `nexo_app` não é dono. Login/sessão/agente usam funções `SECURITY DEFINER`; tabela `sessions` sem acesso direto. Portal: políticas restritivas por assinante | Testado com o papel real, inclusive reuso de conexão |
| ADR-003 | Sessão por token opaco (hash no banco) em cookie `HttpOnly`, `SameSite=Strict` (e `Secure` sob HTTPS); escrita por cookie exige cabeçalho próprio (anti-CSRF). `Authorization: Bearer` continua aceito para integrações | O JavaScript da página não acessa o token |
| ADR-005 | FreeRADIUS 3.2 lendo SQLite local (`rlm_sql_sqlite`) como candidato **experimental** | Provado com `radclient` e, em 10/10/2026, com sessão PPPoE real em CHR 7.24.5 (`docs/lab-pppoe.md`). ToughRADIUS não avaliado. Licença/distribuição não avaliadas |
| ADR-012 | Laboratório virtual executado: CHR RouterOS 7.24.5 + `pppd`, 12 casos aprovados | Equipamento físico e versão do piloto continuam pendentes |
| ADR-006 | Listener próprio para agentes (8443) com mTLS + token; CN = `agent:<id>`; **impressão digital do certificado fixada** no primeiro uso | Certificado antigo/vazado é recusado mesmo válido e assinado pela CA; trocar exige "Aceitar novo certificado" no painel. Substitui a CRL |
| ADR-007 | Envelope assinado com Ed25519 (`node:crypto` / `cryptography`) sobre o JSON exato persistido; segredo PPPoE fora do envelope, entregue só no `begin` | Agente fixa a chave pública no primeiro contato (troca exige ação manual) |
| ADR-008 | SQLite do agente não guarda segredos. No RADIUS local há duas opções por equipamento (`password_storage`): `cleartext` (necessário para CHAP) ou `nt_hash` (só o hash NT; exige NAS em MS-CHAPv2) | Com `nt_hash` não há senha em claro no disco do site (comprovado no laboratório). O hash NT ainda equivale à credencial para MS-CHAP: manter permissões restritas e, se exigido, criptografia de disco do host (não implementada pelo produto) |
| ADR-010 | Gateway atrás de uma interface com um único adaptador (`demo`); fatura com valor cheio do plano; títulos importados não geram cobrança automática | Juros, multa, proporcionalidade, parcial e estorno ficam em conciliação manual até existir regra |
| ADR-013 | Senhas PPPoE e segredo de MFA cifrados com AES-256-GCM por chave do ambiente; credencial do equipamento fica só no agente. **Rotação da chave**: `NEXO_SECRET_KEY_PREVIOUS` + `cli.js rotate-secrets` | Rotação exercitada na instalação de produção local |
| ADR-014 | Marcador de versão gravado junto da autorização local permite distinguir o efeito de cada operação; um executor por equipamento garantido pela reserva; operação incerta bloqueia o equipamento até ser verificada | "Exatamente uma vez" não é prometido |
| Expansão 1 | OLT/ONU reaproveita a fila de operações: `operations` passa a apontar para conta PPPoE **ou** ONU; o agente trata as duas famílias com o mesmo fluxo (persistir, revalidar, aplicar, verificar). Marcador de versão na descrição da ONU | Sem segunda infraestrutura de automação. Driver real depende do fabricante |
| — | Suspensão implementada apenas como "negar autenticação + derrubar sessão", rotulada como modalidade de demonstração | Modalidade real depende da política comercial |

### ADR-005 — comparação dos candidatos (10/10/2026)

Fontes: páginas dos repositórios oficiais consultadas em 10/10/2026 e prova prática. **Não é parecer jurídico** sobre licenças.

| Critério | FreeRADIUS 3.2 | ToughRADIUS |
|---|---|---|
| Licença declarada no repositório | GPL-2.0 | MIT (dicionários derivados do FreeRADIUS sob CC BY 4.0) |
| Prova prática neste projeto | **Sim**: `radclient` (PAP/CHAP/MS-CHAP) e sessões PPPoE reais em MikroTik CHR 7.24.5, CHAP e MS-CHAPv2, accounting, 6 clientes | **Não testado** (avaliação apenas documental) |
| Dados locais / operação offline | SQLite local lido por `rlm_sql_sqlite`; comprovado com nuvem e agente parados | Declara suporte a SQLite; operação offline não descrita |
| Integração com o agente | Tabelas `radcheck`/`radreply` públicas e estáveis; o agente grava direto, com marcador de versão na mesma transação | Modelo de dados próprio com painel e API administrativa; exigiria outro driver e deixaria dois "donos" do cadastro |
| Atributos MikroTik | `Mikrotik-Group` comprovado (perfil e fila aplicados) | Declara VSA MikroTik, sem detalhes |
| Manutenção | Projeto maduro; suporte comercial disponível (InkBridge Networks) | Ativo; sem versões publicadas na página do repositório |
| Complexidade no site | Um serviço sem interface | Serviço + painel web próprio (superfície extra a proteger) |

**Decisão:** manter o FreeRADIUS como motor do MVP. Motivo: é o único comprovado, lê dados que o agente controla por completo e não traz um
segundo painel de cadastro. **Consequência a tratar antes de entregar o agente a terceiros:** o pacote de site distribui o FreeRADIUS (GPL-2.0)
como programa separado em container próprio; a forma de distribuição e as obrigações da licença precisam de validação do responsável designado
(pendência "Distribuição e licenciamento"). O ToughRADIUS só deve ser reavaliado, com prova prática, se essa validação inviabilizar o FreeRADIUS.

## Registro de pendências

Os responsáveis nominais e datas devem ser preenchidos com informações reais. Prazos relativos abaixo indicam o limite para resolver, sem inventar compromissos.

| Pendência | Responsável funcional | Resolver até |
|---|---|---|
| Piloto e acesso ao equipamento | Proprietário do produto + provedor | Homologação de rede |
| Motor RADIUS e forma de instalação | Engenharia + infraestrutura | Integração real do agente |
| Regras de cobrança e suspensão | Produto + financeiro do provedor | Ativação de automações reais |
| Gateway e credenciais | Produto + financeiro | Integração financeira real |
| Distribuição e licenciamento | Responsável designado pelo produto | Entrega do agente a terceiros |
| Processo fiscal | Provedor + responsável fiscal | Entrada comercial |
| RPO/RTO, limites offline e suporte | Infraestrutura + operação do provedor | Piloto com dados reais |

## Referências técnicas

- [PostgreSQL — SELECT e SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.htm): reserva concorrente de registros de fila.
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html): políticas e exceções de privilégios.
- [MikroTik — RADIUS](https://manual.mikrotik.com/docs/authentication-authorization-accounting/radius/): autenticação, accounting, Disconnect e CoA.

Consultadas na elaboração do planejamento em 9 de outubro de 2026. Confirmar a documentação aplicável às versões efetivamente adotadas ao implementar conectores.

## ADR-016 — RADIUS integrado ao sistema (14/10/2026)

**Decisão do proprietário:** o provedor não instala nem administra servidor de autenticação. O RADIUS sobe junto com o NexoISP, é configurado
pelo painel e não aparece como produto separado. Isso **substitui, como padrão,** o desenho anterior (RADIUS e agente na rede do provedor, ADR-005),
que continua existindo como opção para quem quer autenticar com o enlace até o sistema fora do ar.

**Como ficou:**
- Um serviço `radius` no mesmo `docker compose` da API, lendo e gravando no banco do NexoISP com um papel próprio (`nexo_radius`) que só alcança as tabelas `radius_*`.
- O concentrador é cadastrado no painel (fabricante, endereço de origem) e **reconhecido pelo endereço de origem** dos pacotes; esse endereço define o provedor,
  e todas as consultas do servidor ficam restritas às contas dele. O endereço é único em toda a plataforma.
- A senha PPPoE fica **cifrada** no banco (`pgp_sym_encrypt`, chave `NEXO_RADIUS_KEY`) e só o servidor RADIUS a abre; a aplicação não tem permissão de decifrar por esse caminho.
- As operações usam a **mesma fila e as mesmas regras** do agente (reserva, posse, versão da intenção, evidências). Quem executa é um executor interno da própria API.
- Derrubar sessão é pelo protocolo (**Disconnect-Request, RFC 5176**), não por API de fabricante. O que muda por fabricante é só o conjunto de atributos (`radius/vendor.ts`).
- Accounting, consumo, quem está online e o log de autenticação vêm direto do banco, sem sincronização por agente.

**Consequências assumidas:**
- Se o sistema (ou o caminho até ele) cair, quem está conectado continua; **reconexões e novas conexões falham** até voltar. Mitigação prevista: segunda instância do
  serviço em outro endereço, configurada como RADIUS secundário no concentrador (ainda não exercitada entre servidores diferentes).
- O RADIUS fica exposto em UDP 1812/1813 para os endereços dos concentradores. Pacote de origem desconhecida é descartado, mas custa uma consulta ao banco: falta limitar por firewall/taxa.
- O concentrador precisa alcançar o servidor e aceitar dele a desconexão (UDP 3799). **Túnel (VPN) entre provedor e sistema ainda não é entregue pelo produto.**
- Perder `NEXO_RADIUS_KEY` obriga a reprovisionar todas as contas (as senhas continuam no cadastro, cifradas com `NEXO_SECRET_KEY`).

**Situação:** MikroTik validado no CHR 7.17 do cenário PNETLab (autenticação, IP fixo, accounting, desconexão, suspensão e reativação). Huawei e Cisco: atributos e comandos
pela documentação dos fabricantes, **não exercitados em equipamento**.

### ADR-016, complemento — túnel integrado (14/10/2026)

**Decisão do proprietário:** o caminho entre o concentrador e o sistema é um túnel entregue pelo produto, como nos concorrentes.

- Serviço `vpn` no compose (mesma imagem da API, comando `vpn.js`): interface WireGuard com **um par por concentrador** cadastrado no painel. O concentrador disca para
  o sistema (funciona atrás de NAT, sem IP público nem porta de entrada no provedor) e recebe um endereço próprio em `10.250.0.0/16`; o servidor é `10.250.0.1`.
- O endereço do túnel passa a ser o que identifica o concentrador no RADIUS. O servidor RADIUS **compartilha a rede** do serviço do túnel (`network_mode: service:vpn`).
- As chaves do par são geradas pelo sistema; a **privada é mostrada uma vez** e não é guardada. A chave do servidor fica num volume (`vpnstate`).
- A desconexão de sessão sai pelo serviço do túnel (repasse interno), porque é de lá que o concentrador a aceita.
- Pares não se alcançam entre si: cada um só tem rota para o endereço do servidor, e o serviço não encaminha pacotes.

**Limites assumidos:** WireGuard existe no RouterOS 7; **RouterOS 6, Huawei e Cisco não têm** — para eles vale o acesso direto por IP ou um túnel próprio do provedor
(L2TP/IPsec não é entregue). Reiniciar o serviço do túnel (toda implantação o recria) derruba os túneis por cerca de 25 s: quem está conectado continua, logins novos
esperam. A faixa `10.250.0.0/16` é fixa. O host precisa do módulo `wireguard` do kernel (Linux 5.6+).

**Situação:** validado no CHR 7.17 do cenário PNETLab — túnel estabelecido, autenticação, accounting, desconexão, suspensão e reativação por dentro dele.

