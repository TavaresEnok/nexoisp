# Estudo — OLTs não-Huawei em backups reais de provedores (10/11/2026)

**Escopo:** OLT_VSOL, OLT_FiberHome, OLT_ZTE, OLT_Datacom, OLT_Intelbras, Olt_Parks, OLT_TP-LINK, OLT_Maxprint, OLT_Digistar, OLT_CDATA,
OLT_Nokia, OLT_Furukawa, OLT_Cianet. Para comparar, usei só contagens de OLT_Huawei.

**Método e privacidade:** acesso somente leitura ao backup center, usando o backup mais recente de cada equipamento. A análise rodou dentro do
container e nada foi copiado para fora. Saíram apenas agregados e formas normalizadas: texto entre aspas virou `<txt>`, serial virou `<SN>`, IP virou `<IP>`,
número virou `N`, e qualquer palavra que aparece em menos de 2–3 provedores virou `<x>`. Prompts, hostnames, URLs e domínios também foram mascarados.
O relatório não cita provedor nem equipamento. Também li os scripts de coleta (`backup_scripts/*_olt_netmiko.py`, `olt_cli_backup.py`) e o
relatório de auditoria de conexão do backup center (03/2026), deste só com agregados por fabricante.

---

## 1. Números-chave

### 1.1 Base instalada (equipamentos cadastrados) e cobertura de backup

| Fabricante | OLTs cadastradas | Provedores | Com backup | Sem nenhum backup | Formato do dump |
|---|---:|---:|---:|---:|---|
| Huawei (referência) | 386 | 83 de 104 | 138 (36%) | 248 | — |
| VSOL | 81 | 30 | 23 (28%) | 58 | `show running-config` estilo Cisco, ou exportação por arquivo |
| FiberHome | 51 | 16 | 9 (18%) | 42 | `show startup-config` com comandos `set ...` abreviados |
| ZTE | 32 | 10 | 16 (50%) | 16 | `show running-config` (C300/C320) e `show startup-config` com seções `!<mim>` (C600) |
| Datacom (DmOS) | 16 | 5 | 8 (50%) | 8 | `show running-config` hierárquico (ConfD, `commit`) |
| Intelbras | 15 | 12 | 5 (33%) | 10 | `show running-config-devel` (CLI no estilo DZS: `onu set`/`bridge add`) |
| TP-Link | 6 | 5 | 0 | 6 | — |
| Parks | 5 | 2 | 3 (60%) | 2 | `show running-config` com ONU indexada pelo serial |
| Maxprint | 4 | 4 | 0 | 4 | — |
| Digistar | 3 | 3 | 0 | 3 | — |
| CDATA | 2 | 1 | 0 | 2 | — |
| Nokia, Furukawa, Cianet | 1 cada | 1 cada | 0 | 3 | — |
| **Total não-Huawei** | **218** | — | **64 (29%)** | **154** | |

- 47 dos 104 provedores com OLT (45%) usam **mais de um fabricante de OLT**.
- **Acesso** (auditoria de 03/2026, 57 tentativas em OLTs não-Huawei): **Telnet em 39 (68%)** e SSH em 18. FiberHome foi Telnet em 12 de 12,
  VSOL em 14 de 21 e ZTE em 6 de 12. Houve sucesso em 18 de 57. Causas das falhas: conexão recusada (17), timeout (6), falha de autenticação ou SSH (6, quase todas em VSOL),
  sem rota ou rede inalcançável (5), VPN do grupo (4).
- **Qualidade do que foi coletado:** um backup cadastrado como VSOL é na verdade de uma Huawei (`display current-configuration`, `ont add`).
  Duas OLTs aparecem cadastradas duas vezes (mesmo conjunto de seriais: 1 VSOL e 1 ZTE). Dois backups ZTE têm o dump repetido 2× e um tem 24×, somando 18 MB.
  Todos os 16 backups ZTE têm **linhas cortadas em 80 colunas**, com mais de 40 mil linhas partidas no pior caso.
  3 dos 5 backups Intelbras trazem lixo de sessão no meio (prompt, `%% Invalid command`, ANSI, "The OLT system is processing...").
  Os backups Datacom são recentes (mediana de 2 arquivos de histórico; nos demais fabricantes a mediana fica entre 76 e 90).

### 1.2 ONUs nos backups

| Fabricante | ONUs | ONUs/OLT (mediana · máx.) | ONUs/PON mediana · p95 · máx. | Autenticação | ID da ONU |
|---|---:|---|---|---|---|
| ZTE | 13.557 (16 OLTs) | ~875 · 3.269 | 26 · 90 · 122 | serial em 100% | 1..128, `R/S/P:N` |
| FiberHome | 10.150 (9) | 603 · 3.528 | 35 · 97 · 115 | serial em 97%, serial+senha em 3% | 1..128, `slot/pon` (há variante `li`) |
| Datacom | 4.583 (8) | ~556 · 1.050 | 56 · 106 · 119 | serial em 100% (`onu-auth-method serial-number`) | **0..127**, `N/N/N` |
| VSOL | 3.292 (23) | 90 · 510 | 13 · 100 · 122 | **GPON por serial (1.740) e EPON por MAC (1.552)** | 1..128, `0/N` |
| Intelbras | 2.636 (5) | 565 · 787 | 67 · 113 · 118 | serial em 100% | 1..128, PON com **um só número** (`gpon N`) |
| Parks | 1.200 (3, 1 provedor) | 381 · 603 | 50 · 96 · 105 | serial em 100% | **sem ID numérico: a ONU é identificada pelo serial** |

### 1.3 Serviço por ONU (desenho de rede)

| Fabricante | 1 T-CONT + 1 GEM | VLAN cliente ≠ VLAN de saída | Esquema de VLAN | Bridge | Roteador / WAN pela OLT | TR-069 empurrado pela OLT | ONU com nome/descrição |
|---|---|---|---|---|---|---|---|
| ZTE | >99,9% | 244 service-ports (1,8%, 3 OLTs); transparente em 608 (1 OLT) | por PON com várias VLANs por PON; 1–58 VLANs/OLT; 3 OLTs com VLAN fixa | 80% (`vlan port eth_0/1 mode tag vlan`) | PPPoE na ONU configurado pela OLT: 6% (6 OLTs); veip: 19% | 24% (5 OLTs, 1–4 ACS por OLT) | 52% |
| Datacom | 97,4% (2,6% com 2 service-ports) | 600 (13%, 3 OLTs); QinQ `action vlan add` em 43 (2 OLTs) | fixa (3), por PON (1), misto (4) | 73% (`ethernet N native vlan`) | line-profile "Router" 58%; veip 27% | **66%** (`tr069-acs-profile`, 5 OLTs) | 96% |
| Intelbras | sim | não há | **por PON** (≈1 VLAN por PON, 6–10 por OLT) | 75% (`tagged data eth N`) | 17% (`tagged router`) | não aparece | só 1 OLT |
| VSOL | sim | não há | 12 de 23 sem VLAN por ONU no dump (EPON e GPON com VLAN no perfil ou na porta híbrida); onde existe, por PON ou fixa | 849 ONUs com `portvlan`/`ctc eth ... vlan mode tag` | praticamente zero | não aparece | 27% |
| FiberHome | — | — | **não aparece por ONU** em 7 de 9 (só `service_vlan`/`add vlan` na OLT; `set ep ... vlan_m tag/tra` em 2) | — | `set wancfg` só em 2 linhas | não aparece | **não aparece no dump** |
| Parks | — | — | a VLAN fica no perfil `vlan-translation` | 45% (`uni-port`) | 38% (`iphost`) | não aparece | 91% (`alias`) |

### 1.4 Modelo e tipo da ONU

- **A maioria das ONUs é de outro fabricante, não do fabricante da OLT.** Pelo prefixo do serial: em OLT ZTE, 44% são ZTEG e 56% de terceiros
  (HWTC 16%, ITBS 11%, TPLG 6%…). Em FiberHome, 97% são de terceiros (HWTC 21%, TPLG 20%, ZTEG 18%, FHTT 3%). Em Datacom, 94% (HWTC 37%, ZTEG 17%, SHLN 10%).
  Em Intelbras, 62% (ITBS 38%, HWTC 22%). Em Parks, 77% (HWTC 66%, PRKS 23%).
- **O "tipo" declarado na OLT é quase sempre genérico, não o modelo real.** Na ZTE, cerca de 54% usam tipos genéricos criados pelo provedor ("ZTE-ONT", "ALL", "BRIDGE"
  ou nomes próprios, com 7 de 16 OLTs definindo `onu-type ... gpon max-tcont N ...`). O resto se divide entre a família F601 (~22%), F628, F670L e F673A.
  Na FiberHome, 91% usam o tipo SFU genérico `5506-01-A1`, seguido de HG260 (5%). Na Intelbras, `meprof intelbras-default` aparece em 79%, `intelbras-110g` em 15% e `-110b` em 5%.
  Na Datacom, os line-profiles são "Router" (58%), "Bridge/BRIDGE" (18%), "PPPoE" (2%) e nomes próprios (18%).
- **Nomes das ONUs:** quando existem, seguem em geral o formato de login ou código com separador: Datacom 81%, VSOL 79%, Parks 60% (mais 31% alfanuméricos)
  e ZTE 32% (mais 34% de palavra única, 19% alfanuméricos e 15% numéricos).
  Ou seja, o provedor já usa o campo para o login PPPoE ou o contrato.
- **Firmware/modelo da OLT:** o dump quase não informa. ZTE se divide em dois dialetos, 8 OLTs C300/C320 (`gpon-olt_`/`gpon-onu_`, 7.743 ONUs) e 8 C600/C650
  (`gpon_olt-`/`gpon_onu-`/`vport-`, 5.814 ONUs). Na VSOL, cerca de 10 OLTs trazem a linha "Software Version VN.N.NR" e 1 tem uma plataforma nova baseada em Linux/FRR.
  Na FiberHome, as placas `HSWA`/`GC8B`/`GCOB`/`HU1A` indicam AN5516, e 6 OLTs têm capacidade XG-PON/EPON (`onu_ability_set_config card_type xgpon|gepon`).
- **Gestão por ferramenta de terceiros:** 5 de 16 OLTs ZTE usam perfis com nomes padronizados do SmartOLT (`tcont N profile SMARTOLT-...`).

### 1.5 Formas normalizadas da autorização (o que o dump mostra)

**ZTE C300/C320**
```
interface gpon-olt_N/N/N
  onu N type <TIPO> sn <SN>
interface gpon-onu_N/N/N:N
  name <txt> / description <txt>
  sn-bind enable sn
  tcont N profile <perfil>
  gemport N tcont N
  service-port N vport N user-vlan N vlan N
pon-onu-mng gpon-onu_N/N/N:N
  service <nome> gemport N vlan N
  vlan port eth_N/N mode tag vlan N                      (bridge)
  wan-ip N mode pppoe username <txt> password <txt>      (roteador; credencial em claro na OLT)
  pppoe N nat enable user <txt> password <txt>
  tr069-mgmt N acs <URL> validate basic username <txt> password <txt>
  security-mgmt N state enable mode forward ingress-type lan protocol ...
  dhcp-ip ethuni eth_N/N from-onu|from-internet ; loop-detect ethuni eth_N/N enable
```
**ZTE C600/C650**: `interface gpon_olt-N/N/N` → `onu N type <TIPO> sn <SN>`; `interface gpon_onu-N/N/N:N` → tcont/gemport;
`interface vport-N/N/N.N:N` → `service-port N user-vlan N vlan N`; `pon-onu-mng gpon_onu-N/N/N:N` → `flow mode N tag-filter vlan-filter untag-filter discard`,
`flow N pri N vlan N`, `gemport N flow N`, `switchport-bind switch_N/N veip N|iphost N`, `vlan-filter iphost N pri N vlan N`. A mesma ONU aparece em várias seções `!<...>`, então é preciso deduplicar.

**VSOL GPON** (`interface gpon 0/N`): `onu add N profile default sn <SN>`, `onu N profile line name <txt>`, `onu N profile srv name <txt>`, `onu N desc <txt>`,
`onu N tcont N dba <perfil>`, `onu N gemport N tcont N gemport_name <x>`, `onu N service <x> gemport N vlan N`, `onu N service-port N gemport N uservlan N vlan N|transparent`,
`onu N portvlan eth N mode tag vlan N`, `onu N pri equid <x>`. Há também perfis globais `profile line id N name <txt>` (tcont/gemport/service-port dentro) e
`profile srv id N name <txt>` (portvlan dentro), além de `onu auto-learn line-profile name <txt>` / `srv-profile name <txt>` (autoprovisionamento em 4 OLTs).
**VSOL EPON** (`interface epon 0/N`): `confirm onu mac <MAC> onuid N [auth-mode mac]`, `onu mac-auth add <MAC>`, `onu N ctc eth N vlan mode tag|transparent`,
`onu N ctc eth N vlan pvid N pri N`, `onu N ctc eth N loopdetect enable`.

**FiberHome AN5516**: `set white phy addr <SN> pas null|<senha> ac add sl N p N o N ty <TIPO>` (whitelist), `set autho sl N p N ty <TIPO> o N phy <SN> pas null`
(estado autorizado), `set service_ba sl N p N o N ty data|iptv|voi fix N as N` (banda por serviço), `set onu_pon_type slot N pon N onu N pon_type N`,
`set ep sl N p N o N p N serv N vlan_m tag|tra N N` (VLAN na porta da ONU, só 2 OLTs), `create service_vlan N` / `set service_vlan N vlan_begin N vlan_end N` /
`add vlan vlan_begin N vlan_end N tag uplink slot N port N`. O dump usa a **forma abreviada** (`white phy addr ... ac add sl ... p ... o`), que não é necessariamente a sintaxe interativa.

**Datacom DmOS**
```
interface gpon N/N/N
 onu-auth-method serial-number
 onu N
  name <txt>
  serial-number <SN>
  line-profile <perfil>        [onu-profile <x>] [service-profile <x> line-profile <x>]
  tr069-acs-profile <perfil>
  ethernet N  negotiation / no shutdown / native vlan vlan-id N
  veip N
service-port N
 gpon N/N/N onu N gem N match vlan vlan-id N action vlan replace vlan-id N
 (QinQ: match vlan vlan-id any action vlan add vlan-id N)
profile gpon line-profile <x> (tcont N bandwidth-profile <x> / gem N / map <x> / ethernet any vlan N cos ... / veip N vlan N cos any)
dhcp ... circuit-id format <hostname> eth <oltSlot>/<panelPort>/<onuId>/<onuSlot>/<gemPort>:<svlan>
```
**Intelbras**: `onu set gpon N onu N serial-number <SN> meprof <perfil>`, `bridge add gpon N onu N downlink vlan N tagged data eth N` (bridge) ou `... tagged router` (roteador),
`bridge-path modify gpon N onu N gem N mode flap`, `bridge-profile add <x> downlink vlan N tagged eth N gtp N` + `bridge-profile bind add <x> device <meprof> gpon N`
(modelo de autosserviço), `onu set gpon N auto|noauto` (16 PONs em auto e 24 em noauto), `onu block enable gpon N`, `onu description <txt>`.

**Parks** (`interface gpon1/N`): `onu add serial-number <SN>`, `onu <SN> alias <txt>`, `onu <SN> flow-profile <x>`,
`onu <SN> vlan-translation-profile <x> uni-port N|iphost N`, `onu <SN> ethernet-profile auto-on`, `onu <SN> upstream-fec disabled`. Perfis:
`gpon profile flow <x>` / `add flow ...`, `gpon profile vlan-translation <x>` / `add translation access N ...`, `gpon profile bandwidth <x>`.

### 1.6 Lições dos scripts de coleta (interação com a CLI)

- **Telnet é comum.** Todos os scripts aceitam `use_telnet`. FiberHome cai para `cisco_ios_telnet` e para pexpect próprio, com até 100 mil páginas de paginação
  e coleta de até 300 s sem progresso.
- **SSH antigo:** o script ZTE habilita `HostKeyAlgorithms=+ssh-rsa,ssh-dss`, `KexAlgorithms=+diffie-hellman-group1-sha1,group14-sha1` e
  `Ciphers=+aes128-cbc,3des-cbc`.
- O `enable` pede senha própria. Os scripts tentam, na ordem, `enable_password`, a senha do login e o usuário. FiberHome mostra `Login:`/`Password:`.
- Para desligar a paginação, cada firmware aceita um comando diferente: `terminal length 0`, `screen-length 0 temporary`, `no page`, `terminal datadump`, `scroll`.
  A paginação aparece como `--More--`, `---- More ----`, `[More]`, `<--- More --->`, `Press any key` e `More ( Press 'Q' to break )`.
  O prompt tem as formas `host>`, `host#`, `host(config)#` e `<host>`. Há ainda prompts soltos do tipo `Texto:`.
- **VSOL** chega a percorrer 17 comandos para achar a configuração. Alguns firmwares não imprimem nada e só exportam por arquivo (`backup network http <URL>` + `file upload status`).
- **Intelbras** responde "The OLT system is processing, waiting to execute command..." antes do dump, então é preciso esperar em vez de tratar como erro.
- **ZTE** quebra linhas em 80 colunas: o parser tem que juntar as continuações.
- Os scripts de TP-Link, Maxprint, Digistar, CDATA, Nokia, Furukawa e Cianet são genéricos (`show running-config` ou perfil `olt_generic`) e
  nenhum desses equipamentos tem backup. Não há evidência sobre esses fabricantes.

---

## 2. Achados → o que muda no NexoISP

Referências no NexoISP: `services/network-agent/nexo_agent/drivers/olt_base.py` (`OltDriver`/`OnuState`), `olt_huawei.py`,
`apps/api-go/internal/modules/escrita/olt.go` (validação de `POST /api/contracts/:id/onu`), `rede.go` (enum de drivers), `onu_catalogo.go`
(catálogo de modelos e templates), `docs/expansao-olt-onu.md` e a decisão em `docs/DECISOES.md` "OLT de outros fabricantes: não escrever drivers sem equipamento".

| # | Achado | Evidência | O que muda no NexoISP | Prioridade | Esforço |
|---|---|---|---|---|---|
| 1 | **Huawei continua sendo o fabricante principal, mas não basta.** 45% dos provedores têm mais de um fabricante de OLT | Huawei em 83 de 104 provedores. Entre os outros: VSOL 30, FiberHome 16, Intelbras 12, ZTE 10, Datacom 5. Em ONUs: ZTE 13,6 mil, FiberHome 10,2 mil, Datacom 4,6 mil, VSOL 3,3 mil, Intelbras 2,6 mil | Homologar a Huawei continua em primeiro lugar. Ordem sugerida para os próximos drivers: **(1) ZTE C300/C320** (mais ONUs por OLT, modelo service-port quase igual ao da Huawei, netmiko `zte_zxros`), depois o dialeto C600. **(2) VSOL GPON** (maior número de provedores, comandos simples por ONU), depois VSOL EPON. **(3) FiberHome AN5516**. **(4) Intelbras**. **(5) Datacom** (base pequena, mas o melhor encaixe técnico por causa do `commit`). A decisão "sem equipamento não há driver" continua valendo, mas o modelo de dados e os fixtures (achados 2 a 9) podem ser feitos agora sem violá-la | P1 (decidir a ordem) | — |
| 2 | **EPON e identidade por MAC** | VSOL: 1.552 de 3.292 ONUs (47%) em 8 de 23 OLTs autenticam por MAC (`confirm onu mac <MAC> onuid N`). FiberHome tem placas EPON e XG-PON | Acrescentar ao contrato `pon_type` (`gpon`, `epon`, `xgpon`/`xgspon`) e `auth_mode` (`sn`, `sn+password`, `loid`, `mac`). Em `olt.go` o serial (`^[A-Za-z0-9]{8,20}$`) precisa aceitar e normalizar MAC (`aa:bb:..`, `aabb.cc..`, 12 hex). Em `discover()`, devolver `pon_type` e `auth_mode` | P1 | M (API + agente + UI, 2–3 dias) |
| 3 | **Senha/LOID além do serial** | FiberHome: 347 ONUs (3%) com `pas <senha>`. ZTE mostra `uncfg-onu-display-info ... sn pw loid loidpw` | Campo opcional `onu_password`/`loid` na autorização, tratado como segredo: não vai para a auditoria em claro e é validado pelo `_safe` | P2 | P (1 dia) |
| 4 | **O endereçamento da ONU varia por fabricante** | ZTE `R/S/P:N` (1..128), Datacom `N/N/N` + ID **0..127**, FiberHome `slot/pon` (há variante `li`), Intelbras PON com um só número, VSOL `0/N`, **Parks sem ID numérico (ONU indexada pelo serial)** | Hoje `ont_id` só existe em `extra`. Tornar `onu_index` opcional e de primeira classe em `OnuState` e no retorno de `authorize`. Validar `pon_port` por driver (a regex geral já aceita 1 a 4 níveis). Cada driver declara a faixa de IDs (0- ou 1-based) e o algoritmo para achar ID livre. Com p95 de 90–113 e máximo de 122 por PON, o caso de PON quase cheia precisa de teste | P1 | P–M |
| 5 | **Os perfis não se resumem ao par linha/serviço da Huawei** | ZTE pede `type <TIPO>` já existente (`onu-type`) + `tcont profile`; FiberHome `ty <TIPO>`; Intelbras `meprof`; Parks `flow-profile` + `vlan-translation-profile` + `ethernet-profile`; Datacom `line-profile` + `onu-profile`/`service-profile`/`tr069-acs-profile` opcionais; VSOL `profile line`/`profile srv` | Trocar `line_profile`/`service_profile` fixos por **`profiles: dict[str,str]`**, com cada driver declarando os campos que exige (`required_profiles` em `check()`/capacidade). O catálogo `onu_catalogo.go` (templates com `compatible_olts`) passa a preencher esses campos por fabricante de OLT. Manter `line_profile`/`service_profile` como aliases para Huawei | P1 | M (3 dias) |
| 6 | **O tipo da ONU não sai do serial** | Em ZTE, 56% das ONUs são de terceiros e cerca de 54% usam tipo genérico. Em FiberHome, 97% são de terceiros e 91% usam o tipo genérico `5506-01-A1` | `discover()` informa fabricante/modelo detectados (prefixo do SN, EquipmentID), mas o tipo e os perfis de provisionamento vêm do **template escolhido** pelo operador ou da regra (OLT, fabricante da ONU) → template. Nunca deduzir o tipo da OLT a partir do SN | P1 | P (regra no catálogo) |
| 7 | **Um serviço por ONU cobre mais de 97% dos casos. Tradução de VLAN e QinQ são minoria fora da Huawei** | 1 T-CONT + 1 GEM: ZTE >99,9%, Datacom 97,4%. VLAN cliente ≠ saída: ZTE 1,8%, Datacom 13%, Intelbras/VSOL 0% (na Huawei, 84%). Transparente: ZTE 608 ONUs. QinQ (`action vlan add`): Datacom 43 | Manter o modelo de serviço único. Generalizar `user_vlan` (hoje só na credencial Huawei) para **parâmetro opcional da autorização, com default por OLT**, e acrescentar `vlan_mode` (`translate`, `same`, `transparent`, `qinq`). Cada driver recusa o modo que não suporta | P2 | P–M |
| 8 | **O esquema de VLAN mais comum é por PON** | Intelbras ≈1 VLAN por PON (0,95–1,0 das ONUs com a VLAN da sua PON). VSOL 0,99–1,0 nas OLTs com VLAN por ONU. ZTE 0,49–0,97 com várias VLANs por PON. Datacom: 3 OLTs com VLAN fixa | Sugerir a VLAN automaticamente ao autorizar: **VLAN padrão por porta PON** (tabela `pon` já existe em `pon.go`) com fallback para a VLAN da OLT. Isso reduz erro do operador | P2 | P (1–2 dias) |
| 9 | **Modo roteador e TR-069 empurrados pela OLT** | ZTE: PPPoE na ONU pela OLT em 6% (usuário e senha em claro no config), veip 19%, TR-069 (`tr069-mgmt ... acs`) 24%. Datacom: line-profile Router 58%, `tr069-acs-profile` 66%. Intelbras `tagged router` 17%. Parks `iphost` 38% | Hoje a doc diz "fora do escopo: ONU em modo roteador, TR-069". Proposta: **`mode` (bridge/router) vindo do template e, opcionalmente, `acs_profile` com o nome de um perfil que já existe na OLT** (nunca URL ou credencial vindas da nuvem). **Não** enviar credencial PPPoE pela CLI da OLT: ela fica em claro no config e nos backups. Credencial PPPoE fica no TR-069/GenieACS | P2 | M |
| 10 | **Autoprovisionamento ligado na OLT** | VSOL `onu auto-learn ...` (4 OLTs). Intelbras `onu set gpon N auto` (16 PONs), `bridge-profile bind ... device <meprof>`, `auto-service enable` | Nesses casos a ONU é autorizada sem passar pelo NexoISP: `discover()` volta vazio e as ONUs aparecem como "estranhas". `check()` deve informar `auto_provisioning: true` e a UI deve avisar ("a OLT autoriza sozinha; o NexoISP não controlará a autorização"). Divergência apenas para ONUs com o marcador `nexo:` | P1 | P (1 dia por driver) |
| 11 | **Convivência com outras ferramentas e com nomes já usados** | 5 de 16 OLTs ZTE são geridas por SmartOLT. O nome ou descrição da ONU já guarda o login/contrato: ZTE 52%, Datacom 96%, Parks 91% | Não corrigir nem apontar divergência em ONUs sem o marcador. **O marcador `nexo:<id>:v<n>` não pode apagar o login do provedor**: usar `description` para o marcador e preservar `name` onde há os dois (ZTE C300). Nos fabricantes com um só campo (Datacom `name`, Parks `alias`, VSOL `desc`), usar o formato `<login> nexo:<id>:v<n>`, a confirmar o limite de tamanho no equipamento. No FiberHome o dump não mostra descrição, então a versão precisa de fallback (comparar o estado lido com a intenção) | P1 | M |
| 12 | **Telnet e SSH antigo são a regra fora da Huawei** | 68% das tentativas não-Huawei foram por Telnet (FiberHome 100%). O script ZTE precisa de `ssh-rsa/ssh-dss`, `dh-group1-sha1` e `aes128-cbc/3des-cbc` | O transporte do agente (`NetmikoCli`, hoje só SSH `huawei_smartax`) vira uma **camada CLI genérica**: SSH, Telnet como opção explícita (credencial em claro, só em rede local, aviso na UI e `allow_telnet` na credencial local), algoritmos antigos opt-in por OLT via `ssh_trust`, regex de prompt e paginação por fabricante, espera em mensagens de "processando" e junção de linhas quebradas (ZTE, 80 colunas) | P1 (antes do 1º driver não-Huawei) | M (2–3 dias) |
| 13 | **Firmwares variam muito dentro do mesmo fabricante** | ZTE em dois dialetos (C300 8 OLTs, C600 8). VSOL GPON, EPON e uma plataforma Linux/FRR. Variações em VSOL: 17 comandos de backup diferentes e exportação HTTP. FiberHome com variante `li` | Um driver por **dialeto** (`olt_zte_c300`, `olt_zte_c600`, `olt_vsol_gpon`, `olt_vsol_epon`...), mantendo o `expected_product`/`expected_firmware` já exigido para escrita. `check()` precisa identificar o dialeto pela própria saída | P1 | — |
| 14 | **O cadastro não é confiável para dizer o fabricante** | Um "VSOL" é Huawei, duas OLTs estão cadastradas em duplicidade e 71% dos equipamentos não-Huawei nunca tiveram backup | `check()` deve **identificar o fabricante e recusar driver incompatível** (já é feito para modelo e firmware; estender para "a saída não é deste fabricante"). Para importação: detectar OLT duplicada pelo conjunto de seriais | P2 | P |
| 15 | **No FiberHome, o serviço da ONU não aparece no config** | 7 de 9 OLTs não têm VLAN por ONU. Só whitelist (`set white`), `set autho` e banda (`set service_ba`) | Num driver FiberHome, a leitura do estado (VLAN, WAN) precisa vir de comandos `show` específicos, não do dump. A autorização por whitelist é simples, mas a configuração de serviço depende do equipamento: **fica para depois de ZTE/VSOL** e só com OLT em mãos | P3 | G (6–8 dias com equipamento) |
| 16 | **Datacom é transacional** | DmOS com `commit` (8 de 8), service-port como objeto de topo indexado, ID de ONU começando em 0 | Encaixa bem nas garantias do motor: aplicar → `commit` → ler de volta. Falha antes do commit não deixa estado parcial (diferente de Huawei e ZTE, em que a ONU pode ficar sem service-port). O driver precisa de `commit`/`abort` explícitos e de tratar "commit sem mudança" | P3 | M (4–5 dias com equipamento) |
| 17 | **Fixtures realistas para os emuladores** (sem dados reais) | Distribuições acima. O corpus **só tem configuração, nenhuma saída de `show`** | Criar um gerador de fixtures **fictícios** por fabricante e dialeto. Parâmetros: 8/16 PONs; ONUs por PON pela distribuição real (mediana 13–67, p95 90–113, uma PON com 120+); SN com prefixos na proporção observada (ZTEG/HWTC/ITBS/TPLG…) e sufixo aleatório; VLAN por PON, fixa e com tradução (1,8%/13%); 1 T-CONT/1 GEM com ~3% de exceções; nomes no formato login fictício; tipos genéricos ("ALL", "ZTE-ONT", `5506-01-A1`); EPON por MAC. Incluir as anomalias reais: linhas quebradas em 80 colunas (ZTE), lixo de prompt e `%% Invalid command` (Intelbras), mensagem "processing" (Intelbras), ONU repetida em várias seções (C600), dump repetido, paginação, prompt de senha no `enable`, Telnet. As saídas de `show` (descoberta, estado, potência) precisam vir de documentação pública do fabricante e continuam **"não homologado"** | P2 | M (2 dias por fabricante) |
| 18 | **Fabricantes sem evidência** | TP-Link (6 OLTs), Maxprint (4), Digistar (3), CDATA (2), Nokia, Furukawa e Cianet: 18 OLTs e nenhum backup | Não planejar drivers para eles. Basta registrar na documentação que não há dados | — | — |

### 2.1 Conjunto mínimo de comandos por driver

Os comandos de **escrita** abaixo seguem a forma vista nos backups reais. Os de **leitura e descoberta** não aparecem no corpus (só há configuração) e vêm de
conhecimento público, então **precisam ser confirmados no equipamento**.

| Driver | check | discover | read | authorize | deauthorize | Riscos |
|---|---|---|---|---|---|---|
| ZTE C300/C320 | `show version` / `show card` | `show gpon onu uncfg` (a confirmar) | `show gpon onu by sn <SN>`, `show gpon onu detail-info gpon-onu_R/S/P:N`, `show pon power attenuation gpon-onu_...`, `show running-config interface gpon-onu_...` (a confirmar) | `configure terminal`; `interface gpon-olt_R/S/P` → `onu N type <TIPO> sn <SN>`; `interface gpon-onu_R/S/P:N` → `name`/`description`, `tcont 1 profile <P>`, `gemport 1 tcont 1`, `service-port 1 vport 1 user-vlan U vlan V`; `pon-onu-mng gpon-onu_...` → `service <s> gemport 1 vlan V`, `vlan port eth_0/1 mode tag vlan V` | `interface gpon-olt_R/S/P` → `no onu N` | O tipo precisa existir (`onu-type`); linhas quebradas; SSH antigo; gravar com `write` |
| ZTE C600/C650 | idem | `show pon onu uncfg` (a confirmar) | idem, com `gpon_onu-` | `interface gpon_olt-R/S/P` → `onu N type ...`; `interface gpon_onu-...` → tcont/gemport; `interface vport-R/S/P.N:1` → `service-port 1 user-vlan U vlan V`; `pon-onu-mng gpon_onu-...` → `service`/`vlan port` ou `flow`/`switchport-bind ... veip` | `no onu N` | Dialeto diferente; config em seções |
| VSOL GPON | `show version` (a confirmar) | `show onu auto-find` (a confirmar) | `show onu info` / sinal óptico (a confirmar) | `interface gpon 0/P` → `onu add N profile <P> sn <SN>`, `onu N profile line name <x>`, `onu N profile srv name <x>`, `onu N desc <txt>`, `onu N service-port 1 gemport 1 uservlan U vlan V`, `onu N portvlan eth 1 mode tag vlan V` | remoção da ONU N (sintaxe a confirmar) | A VLAN pode estar no perfil e não na ONU; `auto-learn`; firmwares muito variados; Telnet |
| VSOL EPON | idem | (a confirmar) | (a confirmar) | `interface epon 0/P` → `confirm onu mac <MAC> onuid N`, `onu N ctc eth 1 vlan mode tag`, `onu N ctc eth 1 vlan pvid V pri 0` | (a confirmar) | Identidade por MAC; não existe T-CONT/GEM |
| FiberHome AN5516 | (a confirmar) | (a confirmar) | (a confirmar) | whitelist `... phy addr <SN> pas null ... add sl N p N o N ty <TIPO>` (a forma interativa difere da abreviada do dump) | whitelist `delete` | Telnet; serviço fora do dump; sem campo de descrição visível |
| Intelbras | (a confirmar) | (a confirmar) | (a confirmar) | `onu set gpon P onu N serial-number <SN> meprof <perfil>`; `bridge add gpon P onu N downlink vlan V tagged data eth 1` (ou `tagged router`) | `bridge delete ...` + remoção da ONU (a confirmar) | Lixo na saída; "processing"; PON `auto` |
| Datacom DmOS | `show platform` / `show firmware` (a confirmar) | `show interface gpon N/N/N discovered-onus` (a confirmar) | `show interface gpon N/N/N onu N` (a confirmar) | `config` → `interface gpon N/N/N` → `onu N` → `serial-number <SN>`, `name <txt>`, `line-profile <x>`, `ethernet 1 native vlan vlan-id V`; `service-port N gpon N/N/N onu N gem 1 match vlan vlan-id U action vlan replace vlan-id V`; `commit` | `no service-port N`; `interface gpon ...` → `no onu N`; `commit` | ID começa em 0; índice global de service-port |
| Parks | (a confirmar) | (a confirmar) | (a confirmar) | `interface gpon1/P` → `onu add serial-number <SN>`, `onu <SN> alias <txt>`, `onu <SN> flow-profile <x>`, `onu <SN> vlan-translation-profile <x> uni-port 1` | `no onu <SN>` (a confirmar) | Sem ID numérico; 1 provedor no corpus |

### 2.2 Mudanças sugeridas no contrato `OltDriver` (resumo)

- `discover()` → `{serial, mac?, pon_port, pon_type, auth_mode, vendor, model, equipment_id}`.
- `authorize(serial, *, pon_port, profiles: dict, service_vlan, user_vlan=None, vlan_mode='same'|'translate'|'transparent'|'qinq', mode='bridge'|'router', acs_profile=None, onu_password=None, onu_index=None, description)`.
  Manter os parâmetros atuais como aliases para não quebrar a Huawei.
- `OnuState` → acrescentar `onu_index`, `pon_type`, `auth_mode`, `user_vlan`, `vlan_mode`, `mode`, `profiles: dict` e `name` separado de `description`.
- `check()` → acrescentar `vendor`, `dialect`, `required_profiles`, `onu_index_range`, `auto_provisioning`, `transport` (`ssh`/`telnet`) e `legacy_ssh`.
- Na API Go: `driver` em `rede.go` com os novos dialetos, sempre com o rótulo "não homologado". Em `olt.go`, validação de serial/MAC e de `pon_port` por driver,
  no mesmo padrão que hoje existe só para `olt_huawei`.

### 2.3 Limites deste estudo

- Saíram apenas agregados. Os comandos de leitura e descoberta não foram observados, porque o corpus tem só configuração.
- Datacom tem pouco histórico. Parks tem um só provedor. Os 7 fabricantes menores não têm nenhum backup.
- A classificação dos esquemas de VLAN é heurística: fração das ONUs com a VLAN mais comum da sua PON e número de VLANs por PON.
- Nenhuma conclusão aqui homologa driver. Vale a decisão de 10/10: driver só com equipamento. O que pode ser feito antes é o modelo de dados, a camada CLI genérica e os fixtures fictícios.
