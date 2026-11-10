# Reconhecimento ao vivo das CLIs de OLT (formato por marca/modelo)

Capturado conectando **só leitura** em OLTs reais (pelo jump host dos provedores, com autorização do dono em
2026-11-10), para construir/validar os drivers. **Nada aqui identifica provedor ou cliente**: apenas a forma da CLI —
login, prompt, comandos de consulta e cabeçalhos de saída. Sem número de série, IP, nome de cliente/host ou senha.
Prompts mostrados de forma genérica (`<host>`). Ferramenta: `services/network-agent/tools/sonda_campo.py` (Huawei, usa o
driver) e um reconhecimento por telnet/SSH cru para os demais.

## Situação por marca

| Marca | Modelo visto | PON | Transporte | Login / modo | Status |
|---|---|---|---|---|---|
| Huawei | MA5600 (R017), MA5800 (R019) | GPON | telnet / SSH (antigo e moderno) | `enable`→`config` | **driver pronto e validado em campo** |
| ZTE | ZXA10 (placas GTGH/GTGHK) | GPON | telnet | direto / `enable` | CLI mapeada |
| FiberHome | AN5516 | GPON | telnet / SSH | `Login`→`User>`→`enable`→`Admin#` (árvore) | CLI mapeada |
| Datacom | DM4615 (DmOS) | GPON | SSH | `<host>#` (estilo Cisco/DmOS) | CLI mapeada |
| Intelbras | OLT8820plus (Embedded Platform 16.2) | GPON | telnet | `<modelo> login:`→`enable`→`#` | CLI mapeada |
| VSOL | — | — | telnet | — | **pendente**: telnet aceita conexão mas não envia prompt (mesmo com IAC/CR); investigar login/porta |
| Parks | — | — | SSH | — | **pendente**: shell SSH cai com "Aiee, segfault!" (BusyBox); provável exec por comando |

> EPON antigo: nos equipamentos testados o que respondeu foi GPON. ZTE/FiberHome/VSOL têm linha EPON; os comandos EPON
> (`show epon onu ...` / equivalente) precisam ser confirmados numa OLT EPON real — ainda não encontrada ativa nos alvos.

## Huawei — MA5600 / MA5800
Já no driver `services/network-agent/nexo_agent/drivers/olt_huawei.py`. Confirmado em campo num **MA5683T / MA5600V800R017**:
- Identidade: `display version` (`PRODUCT`, `VERSION`).
- Descoberta: `display ont autofind all` (blocos com `F/S/P`, `Ont SN : <16hex> (<VEND>-<8hex>)`).
- ONU: `display ont info by-sn <sn>` — o SN vem como `<16hex> (VEND-xxxx)`; ótica em `display ont optical-info <port> <id>`
  (`Rx optical power(dBm)`, `Tx optical power(dBm)`).
- Backup de config: `display current-configuration` — paginação e o prompt real como terminador (seções separadas por `#`).

## ZTE — ZXA10 (C3xx/C6xx)
- Transporte telnet; `show version` é **ambíguo** (usar forma específica, ex.: `show version-software`).
- Placas: `show card` →
  `Rack Shelf Slot CfgType RealType Port HardVer SoftVer Status` (placas GPON observadas: `GTGH`/`GTGHK`).
- ONUs: `show gpon onu state` →
  `OnuIndex(=shelf/slot/port:onu) | Admin State | OMCC State | Phase State | Channel`; `Phase State` = `working`/`DyingGasp`.
- Não autorizadas: `show gpon onu uncfg` (quando vazio: `%Code 62310-GPONSRV : No related information to show.`).
- EPON provável: `show epon onu ...` (confirmar em OLT EPON).

## FiberHome — AN5516
- `Login:` → senha → `User>` (modo usuário). `enable` → `Admin#` (modo privilegiado).
- CLI **em árvore de diretórios**: `list` imprime a árvore inteira de comandos; `cd <dir>` entra (ex.: `cd onu` → `Admin\onu#`);
  diretórios: `service protocol device qinq interface vlan upgrade maintenance card onu aaa profile qos otdr msan config`.
- Comandos verbais no topo: `show`, `enable`, `list`, `cd`, `save`, `download/upload ftp [system|config|...]`, `reboot`.
- Paginação: `--Press any key to continue Ctrl+c to stop--` (responder com espaço).
- Para o driver: ONU fica em `cd onu`; backup de config via `show`/`upload ftp config` (confirmar comando exato de dump).

## Datacom — DM4615 (DmOS)
- SSH; prompt `<host>#` (estilo Cisco). `show version` não existe nessa forma (`syntax error: element does not exist`).
- `show system` → relógio, uptime, chassi/slot, carga de CPU.
- `show interface gpon` →
  `Physical interface : gpon f/s/p, Enabled, ... Link-level type : GPON, Logical reach, FEC, Transceiver type, ONUs count`.
- Backup de config no DmOS: `show running-config` (confirmar paginação `| nomore`).
- EPON: `show interface epon` (no equipamento visto não havia EPON).

## Intelbras — OLT8820plus (Embedded Platform 16.2)
- Banner `Intelbras Embedded Platform <ver> <modelo>`; login `<modelo> login:` → senha → `intelbras-olt>`; `enable` → `#`.
- Comandos (de `?`): `olt` (GPON OLT), `onu` (GPON ONU), `card`, `cpe`, `gpon-traffic-profile`, `bridge-profile`,
  `firmware`, `backup` (**backup da configuração**), `restore`, `interface`, `port`, `sfp`, `shelfctrl`, `snmp`.
- Para o driver: descoberta/leitura/autorização via `onu ...`; backup de config via `backup ...`.
- GPON (olt8820plus).

## Pendências do reconhecimento
- **VSOL**: telnet conecta mas não manda prompt de login (testado com resposta IAC e CR). Tentar: outra porta/credencial,
  SSH, ou sequência de login específica da VSOL. Há ~19 OLTs VSOL ativas no inventário.
- **Parks**: SSH abre mas o shell interativo cai (BusyBox "Aiee, segfault!"). Provável: usar `exec_command` por comando em vez
  de shell interativo.
- **EPON antigo**: confirmar comandos numa OLT EPON real (não localizada ativa entre os alvos testados).
- Próximos drivers sugeridos por base instalada: **ZTE** e **Datacom/Intelbras** (CLIs já mapeadas), depois FiberHome (árvore).
