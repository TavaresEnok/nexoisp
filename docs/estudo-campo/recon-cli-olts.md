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

## Lição de transporte (como o backup center fala com os equipamentos difíceis)

Descoberto lendo o próprio backup center: para OLTs antigas ele **não usa biblioteca Python de SSH** (paramiko/netmiko),
e sim o **binário real `ssh`/`telnet` do sistema**, dirigido por `pexpect`. Isso importa para o nosso agente, porque o
`cli_transport` atual (paramiko) esbarra nos mesmos casos:

- **SSH legado** (firmwares antigos): precisa de opções que o OpenSSH novo só liga sob demanda —
  `-o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa`
  `-o KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1`
  `-o Ciphers=+aes128-cbc,3des-cbc,aes256-cbc`. (ssh-dss foi removido do OpenSSH 9/10 — não incluir.)
- **Parks**: o SSH é um BusyBox/dropbear que **quebra ("Aiee, segfault!")** com paramiko (shell e exec). Com o `ssh`
  real + PTY funciona. → driver Parks deve usar o `ssh` do SO, não paramiko. Backup via `show running-config` e afins.
- **VSOL**: via telnet **rodado dentro do jump host** (`ssh -T jump` e `telnet <ip> <porta>` por stdio), não por túnel TCP;
  pelo socket local o equipamento fica mudo. O login usa um `_login` tolerante; backup por comandos do perfil VSOL.
- **Conclusão para o NexoISP**: além do transporte paramiko (moderno + legado já existentes), prever um transporte
  "OS `ssh`/`telnet`" (subprocess/pexpect) com as opções legadas acima, para OLTs antigas e BusyBox. É o que torna
  VSOL/Parks/ONTs EPON antigas alcançáveis de forma confiável.

> Reconhecimento ao vivo concluído para Huawei, ZTE, FiberHome, Datacom e Intelbras. VSOL e Parks têm o método de conexão
> mapeado (acima), faltando só a captura ao vivo com o transporte OS-ssh/telnet. EPON antigo pende de uma OLT EPON ativa.

## Transporte OS-ssh/telnet (implementado)

`services/network-agent/nexo_agent/os_cli.py` dá ao agente o transporte pelo **cliente real do sistema** (só biblioteca
padrão): SSH pelo binário `ssh` atrás de um pty (com os algoritmos legados acima), e telnet em Python puro com resposta à
negociação IAC. O `openssh-client` foi adicionado ao Dockerfile do agente. 8 testes de unidade (montagem do comando,
IAC, limpeza ANSI/backspace, paginação, login). **Provado em campo:** o `ssh` real conecta e autentica num Parks
(dropbear/BusyBox) **sem o "Aiee, segfault!"** que o paramiko provocava.

Limites do que dá para validar pelo meu caminho de acesso (túnel pelo jump):
- **Parks (UltraNet):** conecta e loga, mas o shell daquele equipamento **ecoa e não responde** a nenhum comando
  (device quebrado para uso interativo). Precisa de outro Parks ou do método exato do backup center para a coleta.
- **VSOL:** o telnet fica **mudo por túnel TCP**; o backup center roda o `telnet` **dentro do jump host**. Em produção o
  agente fala direto com a OLT (sem túnel), então isso deve se comportar diferente — confirmar com uma VSOL alcançável.

Ou seja: o transporte está pronto e provado na conexão; os drivers VSOL/Parks por cima dependem de confirmar a CLI de
cada um por um caminho de acesso representativo da produção.

## Como cada marca entrega o backup de configuração (achado que define o próximo passo)

Dois grupos, confirmados em campo:

| Grupo | Marcas | Como o backup é feito | Status no NexoISP |
|---|---|---|---|
| **Despeja na tela** (`show running-config`/`display current-configuration`) | Huawei, ZTE, Datacom, MikroTik | O driver lê a saída e guarda | **Pronto** (drivers Huawei, ZTE, Datacom; MikroTik já existia) |
| **Por arquivo (TFTP/FTP)** | Intelbras (cmd `backup`), FiberHome (`upload ftp config`), VSOL, Parks | O equipamento ENVIA o arquivo a um servidor TFTP/FTP; não há `show` que despeje a config | **Pendente**: exige um subsistema de recebimento (o agente sobe um TFTP/FTP efêmero, manda o equipamento enviar e guarda o arquivo) |

No Intelbras OLT8820 confirmado: `show running-config` volta vazio e `show configuration` só devolve o banner — a config sai pelo comando `backup` para TFTP. O backup center implementa esses fluxos por arquivo. Para o NexoISP cobrir essas marcas no backup semanal, o próximo passo é um **coletor TFTP/FTP no agente**, reaproveitando o transporte OS já pronto para disparar o comando de envio no equipamento.

## Cobertura de LEITURA de ONU (além do backup)

Validado AO VIVO em equipamento real, só leitura:

| Marca | Lista/estado de ONU | Comando | Status |
|---|---|---|---|
| Huawei | sim (estado + sinal) | display ont info/optical | driver completo |
| ZTE | sim (estado + sinal) | show gpon onu state/detail-info + pon power | driver completo |
| Datacom | sim (estado + sinal) | show interface gpon f/s/p onu (+ optical-info) | validado ao vivo |
| Intelbras | sim (presença/porta) | onu inventory (+ onu show p/ autofind) | validado ao vivo; online/óptico por-ONU (`onu status <id>`) ainda não mapeado |
| FiberHome | pendente | `cd onu` + comando a confirmar | precisa de `enable` COM senha antes; **cuidado: 5 falhas de senha bloqueiam o login por alguns minutos** |
| VSOL / Parks | pendente | — | não validável pelo meu túnel (VSOL mudo por túnel TCP; o Parks testado tem shell quebrado). Transporte OS pronto; confirmar por acesso igual ao de produção |

Provisionamento de ONU (autorizar/remover) só é homologável em laboratório; nos drivers novos fica recusado. EPON antigo
pende de uma OLT EPON ativa para reconhecimento.
