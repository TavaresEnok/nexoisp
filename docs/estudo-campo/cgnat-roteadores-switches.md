# Estudo de backups reais — CGNAT, roteadores Huawei (BNG/borda) e switches

Data: 2026-11-10. Fonte: backups de produção de terceiros (somente leitura, dentro do container, último backup de cada equipamento). Nenhum arquivo foi copiado. Todos os números abaixo são agregados. Linhas de configuração aparecem só normalizadas (`<IP>`, `N`, `<id>`), sem nomes de provedores ou equipamentos.

Cobertura efetiva (pastas de equipamento que têm ao menos um `backup_*`):

| Tipo | Pastas | Com backup lido |
|---|---|---|
| CGNat_Hillstone | 18 | 9 |
| CGNat_A10 | 5 | 3 |
| Router_Huawei | 135 | 52 (44 zip + 8 cfg) |
| Router_Cisco / Router_Juniper | 4 / 2 | 1 / 1 |
| Switch_Huawei | 335 | 70 |
| Switch_Datacom | 65 | 24 |
| Switch_Cisco / TP-LINK | 10 / 5 | 2 / 1 |

---

## 1. Números-chave

### CGNAT Hillstone (9 equipamentos, 26 regras de bloco de portas)
- Formato: `snatrule id N from address-book "<txt>" to address-book "<txt>" service "<txt>" trans-to address-book "<txt>" mode dynamicport fixed-block start N end N size N [log]`.
- Os 9 equipamentos usam `dynamicport fixed-block`: blocos de portas alocados quando a sessão abre (NAT444 por bloco). Nenhum usa uma fórmula determinística declarada. Há também `mode static` 1:1 (12 regras, 1 equipamento) e `no-trans` (10 regras).
- Tamanho do bloco (start/end/size), em 24 regras com pool resolvido:
  - 1024–64511 com size 1984, o que dá 32 blocos por IP: 12 regras
  - 1024–64511 com size 3968 (16 blocos): 5
  - 1024–62463 com size 3840 (16 blocos): 2
  - 1024–64255 com size 3328 (19 blocos): 2
  - 1024–64383 com size 960 (66 blocos): 2
  - 1024–62463 com size 7680 (8 blocos): 1
- **Nenhuma regra termina na porta 65535.** O fim é 64511 em 17 de 24 regras, e 62463, 64255 ou 64383 nas demais.
- Relação de assinantes por IP público (endereços privados ÷ públicos): 1:32 em 12 regras, 1:16 em 5, 1:18 em 2, 1:8 em 3 e 1:64 em 2. Blocos públicos vão de 1 a 1024 IPs; blocos privados, de 32 a 32768.
- 2 de 24 regras usam pool público que não é CIDR (224 endereços).
- Registro: 18 de 26 regras têm `log`. `logging traffic nat on` aparece em 3 de 9 equipamentos e `logging traffic nat to syslog` em só **1 de 9**. Há servidor syslog configurado em 2 de 9. Os 9 têm `no logging traffic session to buffer`. Na prática, **no máximo 1–2 de 9 CGNATs Hillstone exportam a alocação de blocos para fora do equipamento**.
- `nat type full-cone` aparece em 3 de 9.

### CGNAT A10 (3 equipamentos, 4 regras `fixed-nat` visíveis)
- Formato: `cgnv6 fixed-nat inside ip-list <id> nat ip-list <id> method use-all-nat-ips offset random ports-per-user N respond-to-user-mac [usable-nat-ports 1024 65535]`. As 4 regras usam `method use-all-nat-ips` e `offset random`.
- O NAT determinístico (`fixed-nat`) está nos 3 equipamentos, e os 3 têm `cgnv6 fixed-nat create-port-mapping-file` (com `port-mapping-files-count N`). Um deles usa `lsn-rule-list` e partição, por isso a regra não aparece no texto.
- ports-per-user: 1948, 1900, 1000 e 8000. A relação fica em 1:32, 1:32, 1:64 e 1:8. Os IPs NAT por regra são 128, 1014 (não é CIDR), 8 e 256; os internos, 4096, 32768, 512 e 2048.
- Timeouts: `service-timeout tcp <porta> 600` para portas de VPN/RDP/BD, `udp 53 120` e `icmp-timeout fast`.
- Registro: `logging host <IP>` em 2 de 3 e sflow collector em 3 de 3.

### Roteadores Huawei (52 lidos; VRP V800R009–R024, um V200R007)
- **Papel**: 41 BNG (bas/pool BAS), dos quais 32 também falam BGP; 10 são só borda/core (BGP sem BAS); 1 é outro.
- BGP aparece em 42 equipamentos, com 1 a 411 peers (mediana 16).
- **CGN embutido praticamente não existe**. Um único equipamento tem `nat instance` sem `address-group` (esqueleto sem uso) e 3 têm `service-location`. Nenhum tem `nat address-group`.
- **Os pools de assinante são privados**. Somando os 39 BNGs com pool local: 260.761 endereços RFC1918 (em 37 equipamentos), 186.086 em 100.64/10 (em 27) e só **764 públicos** (em 3). 36 de 39 BNGs só entregam endereço privado; o NAT fica num equipamento externo (Hillstone, A10 ou MikroTik).
- **AAA/RADIUS**: os 41 BNGs têm grupo RADIUS e `radius-server authorization <IP> destination-port 3799` (CoA/DM). Outros comandos frequentes:
  - `radius-server user-name original`: 36
  - `format-attribute nas-port-id vendor redback-simple`: 35
  - `radius-attribute assign hw-mng-ipv6 pppoe motm`: 34
  - `radius-attribute apply framed-ipv6-pool match pool-type`: 33
  - `radius-attribute case-sensitive qos-profile-name`: 40
  - `hw-user-password coa-request`: 11
  - `include Reply-Message coa-nak`: 9
  - `coa-request hw-policy-name daa`: 5
- Os grupos RADIUS levam o nome de ERPs do mercado. Só um deles aparece em cerca de 15 BNGs e outro em cerca de 4.
- **Accounting interim**: 5 min em 68 de 74 domínios; também aparecem 1200 s (4), 20 min (2), 3 min (2), 15 min (1) e 1 min (1). `accounting-start-delay` aparece em 13 e `accounting dual-stack identical` em 6.
- **Velocidade do plano**: `qos rate-limit-mode car inbound/outbound` em 38 de 41, ou seja, a taxa vem do RADIUS. `qos-profile` só existe em 15 de 41 (mediana 0, máximo 134 perfis, formato `car cir N pir N cbs N pbs N ...`).
- **Suspensão**:
  - 29 de 41 têm pool com nome de bloqueio e 24 de 41 têm domínio de bloqueio.
  - 41 usam `redirect ip-nexthop <IP>` em traffic-policy, 37 deles com `inbound global-acl`. É o redirecionamento para a página de aviso.
  - `user-group` só aparece em 1. `web-auth` não é usado (38 têm só `undo web-auth-server`).
  - **Só 1 qos-profile em todo o corpus tem descrição de bloqueio.**
- **IPv6**: pool de delegação (`pool <id> bas delegation`) em 39 de 41, DHCPv6 em 32 e `nd autoconfig managed-address-flag` em 20.
- **Acesso**:
  - `access-type layer2-subscriber default-domain authentication`: 38 (10 com `force`)
  - `user-vlan N`: 39, com mediana de 120 interfaces BAS e máximo de 2152
  - `pppoe-server bind`: 21
  - QinQ termination: 6–10
  - `user-max-session N` no domínio: 22

### Outros roteadores
- 1 Juniper MX atua como BNG (dynamic-profiles/demux) e tem 3 vizinhos BGP.
- 1 Cisco atua como BNG (bba-group/virtual-template) e tem 9 vizinhos BGP.

### Switches
- **Huawei (70)**:
  - VLANs por switch: mediana 116, p90 540, máximo 3898.
  - **52 de 70 são transporte MPLS L2VPN**: VSI/VPLS em 44 (mediana 8, máximo 193) e `mpls l2vc` em 49 (mediana 40, máximo 385).
  - QinQ (`qinq stacking vid N pe-vid N`): 33 de 70, mediana 3 por switch.
  - Proteção de laço: `stp disable` em 48 de 70, `stp loop-protection`/`bpdu-filter` em 16, loopback-detect em só 7.
  - Gerência: loghost em 47, NTP em 21, hwtacacs em 27, LLDP habilitado em 6, trap host SNMP em 6.
- **Datacom (24)**: 17 rodam DmOS como transporte MPLS VPWS (pw-id mediana 12, máximo 51) e todos esses 17 têm `loopback-detection`. Os outros 7 usam o formato legado `vlan batch`.

---

## 2. Achados e impacto no NexoISP

### A1 — A consulta judicial (ofício) não identifica assinantes atrás de Hillstone nem de A10 — **prioridade ALTA, esforço M/G**
- **Evidência**:
  - 36 de 39 BNGs Huawei só entregam IP privado e nenhum faz NAT. O NAT fica no Hillstone (alocação dinâmica `fixed-block`), no A10 (`fixed-nat ... offset random method use-all-nat-ips`) ou no MikroTik.
  - O `CGNATReverse` (`apps/api-go/internal/network/cgnat.go`) calcula a origem por fórmula sequencial: índice ÷ blocos por IP e porta inicial + (índice mod blocos) × tamanho.
  - No Hillstone, quem usou o bloco depende da ordem de chegada; não há fórmula (é o modelo de log por bloco da RFC 7768). No A10, `offset random` e `use-all-nat-ips` espalham os usuários entre todos os IPs NAT com deslocamento aleatório, então a fórmula sequencial dá **outro assinante**.
  - Hoje `legalIP` (`apps/api-go/internal/modules/escrita/ipam.go`) responderia com segurança aparente e o resultado estaria errado, se o operador cadastrasse o plano espelhando o equipamento.
- **O que muda**:
  1. `cgnat_plans` ganha `source` com três valores: `nexo_formula`, que é o atual e só vale para o script RouterOS gerado; `vendor_mapping`, para o A10; e `block_log`, para Hillstone e outros.
  2. Criar a tabela `cgnat_port_blocks (tenant, plan, public_ip, port_start, port_end, private_ip, valid_from, valid_to, origem)`, sem apagamento e com RLS.
  3. Importar o arquivo do A10 gerado por `create-port-mapping-file` (há nos 3 de 3).
  4. Receber syslog de alocação e liberação de bloco no agente. É o Hillstone `log` mais `logging traffic nat to syslog`.
  5. `legalIP` e `cgnatTrace` passam a consultar `cgnat_port_blocks` antes da fórmula. Planos de origem externa sem dado mostram claramente que não há como responder.

### A2 — Registro de NAT ausente na maioria dos CGNATs — **ALTA (operacional e jurídica), esforço P**
- **Evidência**: só 1 de 9 Hillstones exporta NAT para syslog e 3 de 9 sequer ligam `logging traffic nat`. Sem esse registro, a combinação IP público + porta + hora não leva a ninguém. O Marco Civil exige guarda de 1 ano.
- **O que muda**:
  - Na tela `apps/web/features/network/cgnat.tsx`, um plano de CGNAT externo exige informar se há fonte de rastreio e alerta quando não há.
  - Incluir em `docs/operacao.md` um checklist por fabricante: no Hillstone, `log` na snatrule mais `logging traffic nat to syslog`; no A10, port-mapping-file ou syslog.
  - Isso depende de A1.4 para receber os registros.

### A3 — O modelo assume que os blocos vão até 65535 — **ALTA, esforço P**
- **Evidência**: 24 de 24 regras Hillstone terminam antes de 65535 (64511, 62463, 64255 ou 64383). Hoje `CGNATCapacity`, `CGNATForward`, `CGNATReverse` e o trecho sem porta de `legalIP` usam `65536 - port_start`.
  - Nas regras com size 960 e fim 64383, o equipamento tem 66 blocos e o NexoISP calcularia 67. A partir do 2º IP público, todos os mapeamentos ficam deslocados.
  - Nas outras 22 regras o arredondamento esconde o erro por coincidência.
- **O que muda**:
  - Coluna `port_end` (padrão 65535) em `cgnat_plans`, numa nova migration.
  - Usar `floor((port_end - port_start + 1) / ports_per_subscriber)` em `network/cgnat.go` e em `ipam.go:329`.
  - Campo novo na tela de CGNAT.

### A4 — Os pools públicos reais nem sempre são CIDR — **MÉDIA, esforço M**
- **Evidência**: há pool público de 224 endereços (2 de 24 regras Hillstone) e de 1014 IPs NAT (1 de 4 regras A10). `cgnat_plans.public_cidr` e `ip_pools.cidr` aceitam um único CIDR.
- **O que muda**: permitir faixa (início e fim) ou lista de blocos no plano. Com A1 (blocos importados), isso só afeta a capacidade e o script.
- **Compatível**: a faixa de portas por assinante (64–32768) cobre todos os valores reais (960–8000). O limite de /16 no bloco privado cobre todos os casos (máximo real de 32768 por regra).
- **Compatível**: o tipo `cgnat` de `ip_pools` aceita RFC1918, usado em 37 de 39 BNGs.

### A5 — A suspensão em BNG Huawei não segue o padrão de campo — **ALTA, esforço P**
- **Evidência**: suspensos em equipamento Huawei recebem `Huawei-Qos-Profile-Name=<perfil>` e **não** recebem `Framed-Pool` (`apps/api-go/internal/radius/vendor.go`, ramo `blocked`). Nos backups:
  - 29 de 41 BNGs bloqueiam por pool de bloqueio e 24 por domínio de bloqueio, sempre com `redirect ip-nexthop` para o aviso (41).
  - Só 15 de 41 têm algum `qos-profile`, e só 1 deles é de bloqueio.
  - Quase sempre o perfil enviado não existe no BNG, e o assinante suspenso cai no pool normal.
- **O que muda**:
  - Novo modo `pool` em `tenant_settings.suspension_mode` (migration; hoje só `reject|profile`) e em `network/engine.go`, linhas 190–213.
  - Para Huawei, enviar `Framed-Pool=<pool de bloqueio>`, sem perfil de QoS, ou opcionalmente `Huawei-Domain-Name`.
  - Cobrir em `vendor_test.go`.

### A6 — Planos por qos-profile no Huawei — **MÉDIA, esforço P**
- **Evidência**: 38 de 41 usam `qos rate-limit-mode car`, e o envio atual de `Huawei-Input/Output-Average-Rate` em bps (×1000 sobre kbps) está correto para eles. Mas 13–15 de 41 mantêm `qos-profile` por plano (até 134) com cir+pir e `case-sensitive qos-profile-name` (40).
- **O que muda**: em `vendor.go`, para Huawei, permitir mandar `Huawei-Qos-Profile-Name=<perfil do plano>` também com o assinante ativo. Opcionalmente, mandar `Huawei-Input/Output-Peak-Rate`.

### A7 — A consulta IPv6 ignora a delegação dinâmica do BNG — **ALTA, esforço P**
- **Evidência**: 39 de 41 BNGs delegam o prefixo de pool local (`bas delegation`) e 33 aplicam `framed-ipv6-pool`. O prefixo não passa pelo IPAM do NexoISP.
  - A consulta IPv6 de `legalIP` (`apps/api-go/internal/modules/escrita/sql/62a0bfbd_0.sql`) lê só `ip6_delegation_history`, que é cadastral.
  - `radius_acct` já grava `delegated_ipv6_prefix` e `framed_ipv6_prefix` (migration 00076), mas a consulta não usa.
- **O que muda**: unir, em `62a0bfbd_0`, as sessões de `radius_acct` em que `delegated_ipv6_prefix >>= ip` ou `framed_ipv6_prefix >>= ip` no período, ligando ao contrato pelo username.

### A8 — Accounting e desconexão (DM) são compatíveis — **sem ação ou BAIXA**
- **Evidência**:
  - Os 41 BNGs aceitam DM e CoA na porta 3799, e `SendDisconnect` (`radius/coa.go`) usa User-Name, Acct-Session-Id, Framed-IP, Event-Timestamp e Message-Authenticator. Isso é suficiente para o Huawei.
  - O interim real é de 5 min em 92%, dentro do intervalo de `acct_interim_seconds` (60–3600).
- **Ponto aberto (BAIXA)**: falta CoA-Request para trocar de plano ou suspender sem derrubar a sessão. É usado por 5 BNGs (`coa-request hw-policy-name daa`).

### A9 — NAS-Port-Id tem formato conhecido e não é aproveitado — **MÉDIA, esforço P/M**
- **Evidência**: 35 de 41 usam `nas-port-id vendor redback-simple` (interface, slot/porta e VLAN) e 39 terminam usuários por `user-vlan`, com mediana de 120 subinterfaces BAS. O NexoISP guarda `nas_port`, mas não interpreta o valor.
- **O que muda**: extrair a VLAN e a interface do NAS-Port-Id no accounting. Com isso, a sessão vai para OLT/VLAN/POP e o NOC ganha impacto por VLAN e por OLT, sem modelar switches.

### A10 — Switches: transporte L2 sem necessidade de configuração — **BAIXA/MÉDIA, esforço M**
- **Evidência**: 52 de 70 switches Huawei e 17 de 24 Datacom são transporte MPLS (VPLS/VPWS) entre OLT e BNG.
  - Têm muitas VLANs (mediana 116, máximo 3898) e QinQ em 33 de 70.
  - Proteção de laço fraca: `stp disable` em 48 de 70 e loopback-detect em só 7 de 70 Huawei. Nos Datacom, 17 de 17 DmOS têm loopback-detect.
  - O NexoISP não tem switch nem enlace (`devices.driver` aceita `demo`, `mikrotik_radius`, `olt_demo`, `olt_huawei` e `radius`; `network_sites` só registra poste, torre e prédio).
- **O que muda**: não modelar VLANs nem L2VPN (alto volume, pouco valor para o ERP). Se houver demanda do NOC, cadastrar o "equipamento de transporte" de forma passiva (POP, uplink para OLT/BNG, IP de gerência para Zabbix/SNMP) para calcular impacto no mapa. Para impacto por VLAN, A9 resolve a maior parte.

### A11 — Fabricantes de BNG fora do enum — **BAIXA, esforço P**
- **Evidência**: há 1 Juniper MX BNG e 1 Cisco BNG contra 41 Huawei. A migration 00036 restringe `devices.vendor` a `mikrotik|huawei|cisco|generic`.
- **O que muda**: acrescentar `juniper`, com taxa por `ERX-Qos-Profile-Name`/`Juniper` VSA, só quando houver equipamento para homologar (coerente com `DECISOES.md`).

### A12 — CGN embutido no Huawei não precisa de suporte agora — **sem ação**
- **Evidência**: no máximo 1 de 52 tem esqueleto de `nat instance`, sem `address-group`. Exportar script Huawei, Hillstone ou A10 também não compensa. O que importa é importar e receber os registros (A1).

## Ordem sugerida
1. Corrigir rápido o que dá resultado errado hoje: A3 (`port_end`), A5 (suspensão por pool no Huawei) e A7 (IPv6 a partir do accounting).
2. Mudança de modelo da consulta judicial: A1 (blocos importados ou registrados, origem por plano) e A2 (alertas e checklist).
3. Melhorias: A6, A9, A4.
4. Sob demanda: A10, A11, A8 (CoA-Request).

Observação: nenhum comando foi executado em equipamento. A semântica do `fixed-block` do Hillstone foi inferida da sintaxe e do padrão NAT444 de blocos (RFC 7768) e precisa ser confirmada num equipamento antes de documentar como definitiva.
