# Estudo de configurações MikroTik RouterOS reais → melhorias no NexoISP

Data: 10/11/2026. Fonte: o backup `.rsc` mais recente de cada equipamento MikroTik do acervo de backups (somente leitura, analisado dentro do contêiner, sem copiar arquivos). Aqui só entram agregados e padrões normalizados. Nenhum nome, login, IP, segredo, comentário ou provedor aparece.

> Ressalva de cobertura: das 592 pastas `MikroTik_RouterOS`, só **197 têm backups `.rsc`**; as outras 395 estão vazias. Todas as contagens são sobre esses 197 equipamentos. "BNG" = equipamento com `/interface pppoe-server server add` (**102**).
> Atributos que o RADIUS devolve e entradas dinâmicas de address-list não aparecem no export. Quando um achado depende deles, ele é **inferido** da configuração (isso vem indicado).

---

## 1. Números-chave

| Tema | Número |
|---|---|
| Equipamentos analisados | 197 (102 BNG PPPoE, 17 com BGP, 18 CRS3xx, ~86 com CGNAT) |
| RouterOS | v6: 129 (65%), v7: 68. 6.49 = 80, 6.48 = 31, 7.12 = 15, 7.24 = 9. **BNGs: 71 em v6 (70%) e 31 em v7** |
| Modelos de BNG | CCR1036 32, CCR1009 21, CCR2116 14, RB4011 12, CHR/x86 ~10 |
| Servidores PPPoE por BNG | mediana 8, p75 21, máx. 90. 74% sobre VLAN e 24% direto na ethernet. QinQ em 2 BNGs. `service-name` preenchido em 100% |
| Autenticação PPPoE (por BNG) | aceita PAP: 93/102 (91%). **Só PAP: 21**. Só CHAP: 5. Inclui MS-CHAPv2: 51 |
| one-session-per-host | todos os servidores = sim: 53 BNGs; parte: 29; nenhum: 20 |
| MTU/MRU (servidores) | 1480 (padrão/explícito) ~73%, 1492 26%, mrru=1600 30% |
| BNG com RADIUS (`/ppp aaa use-radius=yes`) | **70/102 (69%)**. Só secrets locais: 32 (31%) |
| Servidores RADIUS por equipamento | 1: 25, **2: 34**, 3+: 17. timeout 3s: 62%; padrão de 300 ms: 29% |
| Portas RADIUS | não padrão em 69% das entradas (RADIUS hospedado com porta por provedor) |
| CoA (`/radius incoming accept=yes`) | **66/76 (87%)** dos que têm RADIUS. Porta 3799 em 100% |
| interim-update (BNG RADIUS) | **5m: 50 (71%)**, ausente/0s: 11 (16%), 3m/4m: 5, 20m: 3, 1m: 1 |
| require-message-auth | 43 entradas definem `no` explicitamente |
| /ppp profile | 1.332 perfis em 151 equipamentos. 77% com rate-limit. Unidades: k 58%, M 38%, G <1% |
| Rate-limit | `Nk/Nk` 531, `NM/NM` 311, `Nm/Nm` 54. Com rajada: 86 (8,5%). Simétrico 54%, subida<descida 43% |
| Perfis "de bloqueio" (nome com bloq) | 70 perfis em 57 equipamentos. 45 com **1k/1k** e 50 com pool próprio privado |
| /ppp secret | 20.588 em 153 equipamentos. caller-id (MAC) 7%, IP fixo 1,9% (CGNAT 164, privado 136, público 86), **71% desativados** |
| Bloqueio por address-list `bloqueados` | **57 equipamentos** (52 deles com RADIUS e nenhum colocando a lista via perfil, então ela chega pelo RADIUS) |
| Walled garden `sites-liberados` | 57 equipamentos (≤20 entradas cada) |
| CGNAT | 86 equipamentos com NAT de 100.64/10. **netmap 67** (50 determinísticos com faixa de portas), masquerade 9, src-nat sem portas 8 |
| CGNAT determinístico | início na porta 1024 em 49/50. **1:64 (1008 portas) em 21 e 1:32 (2016) em 20**, 1:16 em 5. Árvore de `jump` em 52 equipamentos |
| Pools IPv4 | 558 privados, 118 CGNAT, 48 públicos. BNGs: CGNAT+privado 57, só privado 23, com público 22 |
| IPv6 | 35/102 BNGs com `/ipv6 pool` (34%). PD por perfil em 15, WAN `remote-ipv6-prefix-pool` em 13. prefix-length do PD: /64 28, /56 12, /58 8 |
| DHCP/hotspot | DHCP server em 101 equipamentos, **nenhum com use-radius**. Hotspot: 1 equipamento |
| Filas | simple queue em 27 equipamentos (quase todas ≤10), queue tree em 6. Planos aplicados por **rate-limit dinâmico do PPP** |
| BGP | 17 equipamentos (v6 7, v7 10), quase sempre com 2–3 pares e sempre com filtros. Communities de blackhole: 0. Rotas blackhole: 4 |
| API | habilitada em 71/197. **Nos BNGs: api 62/102 (50 restritas por endereço, 35 em porta própria), sem nenhuma API 38. api-ssl com certificado: 0/197** |
| Outros serviços | telnet ligado 17, ftp 14, www 56. ssh em porta própria 190/197, winbox em porta própria 160 |
| SNMP / NTP / syslog | SNMP 161 (82%, community restrita por endereço 141). **NTP cliente desligado em 45/102 BNGs (44%)**. syslog remoto 28 |
| Scripts | backup+fetch 126. on-up/on-down em 69 perfis (16 equipamentos: script que envia o prefixo IPv6 delegado ao ERP). netwatch 50 |

---

## 2. Achados e o que muda no NexoISP

Prioridade: **A** alta / **M** média / **B** baixa. Esforço: **P** pequeno (≤1 dia) / **M** médio (2–5 dias) / **G** grande (>1 semana).

### A1. Suspensão por address-list entregue pelo RADIUS (`Mikrotik-Address-List`) não existe para PPPoE. **Prioridade A · Esforço M**
- **Evidência:** 57 equipamentos usam a lista `bloqueados` no firewall. Em 52 deles há RADIUS e nenhum perfil PPP preenche essa lista, então ela chega pelo RADIUS. Formas mais comuns: `dstnat dst-nat tcp 80,443 src-list=bloqueados dst-list=!sites-liberados → portal` (42), `raw prerouting drop src-list=bloqueados dst-list=!sites-liberados` (36), `srcnat masquerade bloqueados→sites-liberados` (31) e `filter forward drop` (16). O perfil de bloqueio (`Mikrotik-Group`) aparece em 57 equipamentos, mas costuma conviver com a lista.
- **No NexoISP hoje:** `apps/api-go/internal/radius/vendor.go` (`attributes`) só envia `Mikrotik-Address-List` para IPoE/hotspot. As modalidades de suspensão são só `reject|profile` (`db/migrations/00020_suspensao_por_perfil.sql`). O agente (`services/network-agent/nexo_agent/drivers/mikrotik_radius.py`, `REPLY_ATTRS`/`RadiusStore.apply/read`) não conhece a lista.
- **Mudança:** criar a modalidade `address_list` em `tenant_settings`, com `suspension_address_list` configurável (padrão sugerido `bloqueados`, para casar com as regras que 57 provedores já têm). Em `vendor.go`, ao bloquear: manter `Mikrotik-Group` (o do plano ou o de bloqueio) e somar `Mikrotik-Address-List=<lista>`. Ajustar `network/engine.go`, onde a suspensão é montada, e `RadiusStore.read()` no agente, para reconhecer "suspensa por lista". A sessão continua sendo derrubada, porque a lista só vale na reautenticação.

### A2. O agente exige api-ssl com CA, e nenhum MikroTik real tem isso. **Prioridade A · Esforço M**
- **Evidência:** api-ssl com certificado em **0/197**. Nos BNGs, a API sem TLS está ligada em 62/102 (50 restritas por endereço, 35 em porta própria) e 38 BNGs não têm nenhuma API ligada.
- **No NexoISP hoje:** `MikrotikSessions` (`mikrotik_radius.py`) usa a porta 8729 com verificação de CA. Texto puro só é aceito em laboratório e em loopback (`NEXO_AGENT_ALLOW_INSECURE_LAB`). Resultado: em 100% dos BNGs observados o driver não conecta sem preparação manual (`docs/lab-pppoe.md` §2 faz isso à mão).
- **Mudança:** (a) gerar no assistente (`apps/api-go/internal/modules/leitura/radius_commands.json`) o bloco de certificado autoassinado, com variantes **v6 e v7**: `/certificate add … sign`, `/ip service set api-ssl certificate=… address=<agente>/32 disabled=no`, `/user group add name=nexo-agent policy=read,write,api,!…`; (b) aceitar no agente a **fixação de impressão digital** (TOFU) como alternativa à CA; (c) incluir o endereço do agente no `address=` do serviço, já que 81% restringem; (d) quando não houver API, degradar com clareza para "somente RADIUS + Disconnect por CoA", que já existe em `radius/coa.go`.

### A3. CGNAT determinístico: o mercado usa netmap intercalado, e o NexoISP gera outro layout e não importa o existente. **Prioridade A · Esforço G**
- **Evidência:** 50 equipamentos com netmap e faixa de portas, num total de cerca de 9.900 regras netmap. O padrão é um bloco privado do mesmo tamanho do bloco público (`/29→/29`, `/30→/30`, `/27→/27`), em 3 regras por bloco (tcp e udp com `to-ports`, mais uma regra geral sem portas para ICMP), começando em 1024. Proporção 1:64 (1008 portas) em 21 equipamentos e 1:32 (2016) em 20. Há árvore de `jump` saindo do srcnat por /24 em 52. Mapeamento: IP privado de índice *i* → bloco *k = i div P*, público = base + (*i mod P*), portas = 1024 + *k*·tamanho.
- **No NexoISP hoje:** `apps/api-go/internal/network/cgnat.go` (`CGNATForward/Reverse`) faz IPs privados consecutivos dividirem o mesmo IP público, um layout diferente. `CGNATScript` gera **2 regras por IP privado** numa única cadeia linear (um /22 vira mais de 2 mil regras avaliadas em sequência, contra cerca de 96 no netmap). A consulta de ofício (`features/network/legal.tsx`) não consegue responder pelos CGNATs que já estão em produção. O padrão da UI, `ports_per_subscriber: "2000"` (`apps/web/features/network/cgnat.tsx:206`), desperdiça 512 portas por IP.
- **Mudança:** em `cgnat_plans`, adicionar a coluna `layout` (`sequential|netmap`) e permitir vários blocos públicos por plano. Implementar o layout netmap em Forward, Reverse e Script, com a árvore de jump. Criar um **importador de regras** `/ip/firewall/nat` (leitura pelo agente ou colagem do export) que reconstrói os planos e mostra uma verificação amostral. Na UI, oferecer os padrões 1008 (1:64), 2016 (1:32) e 4032 (1:16).

### A4. Uso da lista pelo RADIUS e template de bloqueio da documentação divergem do mercado e têm uma falha provável. **Prioridade A · Esforço P**
- **Evidência:** o mercado chama a lista de `bloqueados` (58 equipamentos), não `nexo-bloqueados`. Mantém um walled garden `sites-liberados` (57). Redireciona 80 **e 443** (42). Descarta em **raw/prerouting** (36, contra 16 em filter). Faz **masquerade do pool de bloqueio** (31 + 8).
- **No NexoISP hoje:** `docs/operacao.md` (linhas 117–124) manda o *perfil* colocar a lista (só 8 equipamentos fazem assim), não prevê lista de sites liberados e não tem src-nat. O pool de bloqueio do laboratório é privado (`10.254.0.0/24`, `lab-pppoe.md` linha 129) e o dst-nat aponta para o IP público do portal: sem masquerade desse pool, a resposta do portal não volta, a menos que um NAT genérico do provedor cubra o pool. **É preciso conferir em laboratório.**
- **Mudança:** reescrever o template com: nome da lista configurável (o mesmo de A1), lista `sites-liberados` (portal, gateway de pagamento, DNS), masquerade do pool de bloqueio, drop em raw e a observação sobre 443. Gerar o template no assistente do concentrador em vez de deixá-lo só na documentação.

### A5. Faltam aviso na navegação e etapa "aviso" de rede. **Prioridade M · Esforço M**
- **Evidência:** a lista `bloqueio-avisar` aparece em cerca de 40 equipamentos, contando as variantes. O padrão é `mangle mark-connection` das conexões novas 80/443 → dst-nat ao portal → `filter add-src-to-address-list` com `address-list-timeout` quando o assinante abre a página, e ele volta a navegar até o tempo expirar. Também há 44 perfis `aviso` (com address-list `aviso`) e 46 perfis `pendencia` (21 deles com on-up).
- **No NexoISP hoje:** `warn_after_days` (`plans`/`PUT /api/plans/:id/dunning`) só serve para mensagens. `finance/gateway.go` (`autoSuspendTarget`) conhece apenas `reduced|blocked`.
- **Mudança:** criar a etapa `warned` em `autoSuspendTarget`/`network.Request`, que mantém plano e velocidade e envia `Mikrotik-Address-List=<lista de aviso>`. Incluir o template mangle/nat/filter com tempo limite. A página `/aviso/<provedor>` já existe.

### A6. A validação de rate-limit recusa 6,3% dos formatos reais. **Prioridade M · Esforço P**
- **Evidência:** 64 de 1.013 strings falham na regex do NexoISP: espaço duplo antes da prioridade (48) e unidade `G`/`g` (8). Também aparecem `m` minúsculo (54) e `K` maiúsculo (21), que já são aceitos.
- **No NexoISP hoje:** a regex em `apps/api-go/internal/modules/escrita/rede.go:44` e o `check` em `db/migrations/00033_desconexao_parametros_rede.sql`.
- **Mudança:** normalizar espaços (colapsar e aparar) antes de validar e aceitar `[gG]`. Fazer a mesma normalização no importador (A9). A ordem subida/descida (rx/tx) do NexoISP está correta: 43% dos perfis têm subida < descida e só 2,7% o inverso.

### A7. O intervalo de accounting não é enviado por padrão. **Prioridade M · Esforço P**
- **Evidência:** 11 de 70 BNGs com RADIUS (16%) não têm `interim-update` (0s), e 71% usam 5m.
- **No NexoISP hoje:** `vendor.go` só envia `Acct-Interim-Interval` quando `devices.acct_interim_seconds` está preenchido. `radius_telemetry.go` considera a sessão atrasada depois de 900 s. Em NAS sem interim, as sessões aparecem como "atrasadas" e o consumo fica velho.
- **Mudança:** enviar 300 s quando o campo for nulo, ou definir padrão 300 na coluna. O assistente já manda `interim-update=5m`, mas isso só vale para quem roda os comandos.

### A8. Relógio do NAS sem NTP compromete a linha do tempo dos ofícios. **Prioridade M · Esforço P/M**
- **Evidência:** NTP cliente desligado em 45/102 BNGs (44%), sendo 28 dos 70 com RADIUS.
- **No NexoISP hoje:** `radius_record_accounting` (`db/migrations/00076_radius_accounting_events.sql`, linhas 79–82) confia no `Event-Timestamp` do NAS sempre que ele vem. O assistente (`radius_commands.json`) não configura NTP.
- **Mudança:** calcular a divergência (recebido − delay − Event-Timestamp). Acima de cerca de 60 s, usar o horário de recebimento e sinalizar "relógio do NAS divergente" em `radius_telemetry.go` e no NOC. Incluir `/system ntp client` no assistente, com sintaxe diferente em v6 e v7.

### A9. Não há importação a partir do MikroTik (secrets e perfis). **Prioridade M · Esforço G**
- **Evidência:** 31% dos BNGs (32) autenticam só com secrets locais. São 20.588 secrets, com MAC em 7% e IP fixo em 1,9%. **71% estão desativados**, concentrados em 33 BNGs com RADIUS que têm 90% ou mais de secrets desativados: são restos ou contingência, não inadimplentes. Perfis de plano: 46/70 dos BNGs com RADIUS têm 4 ou mais perfis com rate-limit.
- **No NexoISP hoje:** a importação é só por CSV (`modules/escrita/importacao.go`).
- **Mudança:** leitura somente pela API (agente) de `/ppp/secret`, `/ppp/profile` e `/ip/pool` para uma área de preparação. Mapear perfil → plano pelo rate-limit, remote-address → IP fixo e caller-id → MAC. **Não** converter `disabled=yes` em suspensão sem confirmação.

### A10. Falta CoA para trocar o plano sem derrubar a sessão. **Prioridade M · Esforço M**
- **Evidência:** 87% dos NAS com RADIUS aceitam CoA, todos na porta 3799.
- **No NexoISP hoje:** `radius/coa.go` implementa só Disconnect-Request (código 40). A troca de plano derruba a sessão (`docs/lab-pppoe.md`, caso 5).
- **Mudança:** implementar CoA-Request (43) com `Mikrotik-Rate-Limit` quando o plano tiver `rate_limit`, e cair para Disconnect se vier NAK. Validar no CHR (v6 e v7) antes de ligar. Para mudança de lista ou perfil, continuar derrubando a sessão.

### A11. Não há conferência de que perfil e pool existem no NAS. **Prioridade M · Esforço M**
- **Evidência:** a maioria usa o modelo `Mikrotik-Group` = perfil do plano (46/70 BNGs com RADIUS têm 4 ou mais perfis de plano). O perfil de bloqueio típico é 1k/1k com pool privado (45 e 50 de 70).
- **No NexoISP hoje:** a migração 00020 diz que "o perfil precisa existir no NAS: o NexoISP não o cria". Se o nome estiver errado, o RouterOS cai no perfil `default` sem avisar.
- **Mudança:** o agente lê `/ppp/profile` e `/ip/pool` e informa a nuvem. `network/engine.go` e a UI alertam sobre perfil de plano, de redução ou de bloqueio, ou sobre `Framed-Pool`, inexistente em algum NAS.

### A12. CGNAT não determinístico e logs de NAT. **Prioridade M · Esforço G**
- **Evidência:** 17 dos 86 equipamentos com CGNAT (20%) usam masquerade ou src-nat sem portas. 16 têm `log=yes` em regras de NAT, 7 usam traffic-flow (6 IPFIX) e 28 mandam syslog remoto (11 com o tópico `account`).
- **No NexoISP hoje:** a consulta de ofício só resolve CGNAT a partir de `cgnat_plans`.
- **Mudança:** curto prazo, avisar em `legal.tsx` que um IP público sem plano determinístico não é resolvido. Médio prazo, coletar no agente o syslog de NAT ou o IPFIX do NAS.

### A13. IPv6 com delegação de prefixo pelo pool do NAS. **Prioridade M/B · Esforço M**
- **Evidência:** 34% dos BNGs têm IPv6. Nos perfis, o PD sai do pool (`dhcpv6-pd-pool` em 15 BNGs, `remote-ipv6-prefix-pool` em 13). 16 equipamentos rodam um script on-up que lê o binding DHCPv6 e envia o prefixo ao ERP por `/tool fetch`, sinal de que o accounting não bastava para o registro legal.
- **No NexoISP hoje:** prefixo fixo por contrato vindo do IPAM (00017/00062) e envio de `Delegated-IPv6-Prefix`. O accounting já grava `delegated_ipv6_prefix` (`infra/radius/queries.conf`).
- **Mudança:** criar a modalidade "PD pelo pool do NAS", que não envia prefixo ou envia `Delegated-IPv6-Prefix-Pool`/`Framed-IPv6-Pool`. Conferir em laboratório se RouterOS v6 e v7 mandam o prefixo no accounting. Se não mandarem, oferecer um modelo de on-up que faça POST com token para a API do NexoISP, alimentando o histórico IPv6.

### A14. RADIUS em modo direto sem `src-address`. **Prioridade B · Esforço P**
- **Evidência:** 57% das entradas definem `src-address`.
- **No NexoISP hoje:** o NAS é identificado por `Packet-Src-IP-Address` (`queries.conf`), e o template direto em `radius_commands.json` só define `src-address` no modo túnel. Um NAS com vários IPs pode chegar por um endereço não cadastrado.
- **Mudança:** incluir `src-address=<IP cadastrado>` também no modo direto. Garantir que o RADIUS integrado sempre devolva `Message-Authenticator`, para o operador poder manter `require-message-auth` (43 entradas hoje forçam `no`).

### A15. IPoE e hotspot quase não aparecem nos MikroTik. **Prioridade B · Esforço P**
- **Evidência:** nenhum dos 101 equipamentos com DHCP usa RADIUS no DHCP, embora 62 entradas RADIUS declarem `dhcp`. Hotspot: 1 equipamento. Em 61 BNGs o DHCP existe para outros fins (gerência, CPE).
- **Mudança:** baixa prioridade de investimento. No template, trocar o comentário `/ip dhcp-server set [find] use-radius=yes` por `[find name=<servidor dos assinantes>]`: com `[find]` puro, quem descomentar quebra também o DHCP de gerência.

### A16. Listas de bloqueio judicial/regulatório. **Prioridade B · Esforço M**
- **Evidência:** `bloqueados-oficio` em 5 equipamentos e `blacklist` em 4, sempre com drop por `dst-address-list`.
- **Mudança:** opcional. Lista gerenciada pelo NexoISP e empurrada pelo agente, com trilha de auditoria por ofício.

### A17. VLAN e POP de serviço podem vir do accounting. **Prioridade B · Esforço P**
- **Evidência:** mediana de 8 servidores PPPoE por BNG (máximo 90), 74% sobre VLAN, `service-name` em 100%.
- **No NexoISP hoje:** o accounting já grava `port` (NAS-Port-Id, que no MikroTik é a interface/VLAN) e `called` (o service-name). A ficha técnica (`subscriber-technical-panels`, "VLAN de serviço") mostra "indisponível".
- **Mudança:** preencher a VLAN e o service-name a partir da última sessão.

### A18. Compatibilidade v6/v7 para o agente e o assistente. **Prioridade M · Esforço P**
- **Evidência:** 70% dos BNGs estão em v6 (6.44 ou mais nova; nenhuma usa o login legado da API). O túnel WireGuard do assistente só serve v7, ou seja, 30% dos BNGs. Diferenças que importam: certificados e NTP têm sintaxe distinta, e `require-message-auth` só existe nas versões novas (24 equipamentos o usam). Roteamento (`/routing bgp connection` e `/routing ospf interface-template` no v7, contra `peer`/`network` no v6) só interessa a bordas.
- **Mudança:** tratar L2TP/acesso direto como caminho principal para v6 em `radius_commands.json`. Gerar comandos por versão detectada (`check()` já lê a versão via `/system/resource`).

### O que o NexoISP já acerta (confirmado pelos números)
- Padrões do assistente: `timeout=3s` (62% do mercado), `interim-update=5m` (71%), CoA em 3799 (100%), servidor RADIUS secundário (69% têm 2 ou mais).
- Senha em claro como padrão: 91% dos BNGs aceitam PAP e 21 aceitam *só* PAP, então o modo `nt_hash` (só MS-CHAPv2) quebraria a maioria. Vale um aviso na UI ao escolhê-lo.
- Envio de `Mikrotik-Group` junto com `Mikrotik-Rate-Limit`, o que cobre os dois modelos do mercado (16 BNGs com RADIUS sem nenhum perfil de plano e 46 com perfis por plano).
- IP fixo por `Framed-IP-Address` e MAC por `Calling-Station-Id ==`, compatíveis com o uso real (1,9% e 7%).

### Higiene observada (para a documentação e o NOC, sem ação no código)
- A API sem TLS é o meio que existe, então o NexoISP deve orientar a restrição por endereço, que 81% já fazem.
- telnet ligado em 17 equipamentos, ftp em 14, www em 56. ssh e winbox quase sempre em porta própria (190 e 160).
- SNMP ligado em 82%, quase sempre com community restrita por endereço. RoMON ligado em 155.
- `/ip dns allow-remote-requests` em 10 equipamentos e `ip cloud` (DDNS) em 49.
