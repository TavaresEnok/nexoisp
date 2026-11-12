# Migração da camada de REDE: SGP/IXC → NexoISP

Complementa [`10-migracao-sgp.md`](10-migracao-sgp.md) (camada de dados/ERP) e [`importacao-csv.md`](importacao-csv.md).
Aqui está **como o SGP e o IXC configuram os equipamentos** (autenticadores e OLTs) e **o que o NexoISP precisa fazer
na rede** para assumir um provedor, incluindo a **rastreabilidade de CGNAT para ofício**.

Levantado por análise SÓ-LEITURA das configs reais no backup center da Ajust (2026-11-12). Tudo anonimizado: nenhum
serial, IP, usuário ou senha de cliente saiu; só padrões estruturais.

## 1. Parque observado (backup center)

| Classe | Equipamentos | Com backup OK |
|---|---|---|
| MikroTik RouterOS (autenticador/CGNAT) | 329 | 170 |
| OLT Huawei | 204 | 123 |
| Switch Huawei | 211 | 117 |
| Router Huawei (borda/NE8000) | 70 | 52 |
| OLT VSOL / FiberHome / ZTE / Datacom / Intelbras / Parks | 49 / 24 / 21 / 20 / 10 / 4 | — |
| **CGNat Hillstone** | **23** | 11 |
| **CGNat A10** | **5** | 3 |
| Router/Switch Cisco (ex.: HomeNet) | 2 / 6 | — |

> Proporção SGP × IXC por provedor: **61 de 91 provedores só SGP**; IXC em ~8 (ver §5).

## 2. Como o SGP/IXC integram (camada de rede)

### MikroTik (autenticador/NAS) — RADIUS
- MikroTik configurado como NAS: `/radius add service=ppp[,hotspot,wireless] timeout=3s`, `/ppp aaa use-radius=yes`,
  accounting com `interim-update=20m`. **O usuário/senha/plano NÃO fica no `/ppp secret`** — mora no RADIUS do ERP.
- **Suspensão/liberação por RADIUS CoA/Disconnect** (`/radius incoming set accept=yes`): o ERP derruba a sessão; o
  próximo login cai no perfil bloqueado ou é negado. Bloqueio no plano de dados por **firewall address-list** + CGNAT.
- O ERP **etiqueta os objetos que cria com `comment`** (o SGP marca ~todos; o IXC também) e provavelmente usa a
  **API do RouterOS** para ler estado e empurrar firewall/queue.
- **Não instala scheduler/script próprio de rotina** no MikroTik (os agendadores vistos são de backup): age em
  tempo real (CoA + API), não por cron no equipamento.
- **VPN: é o MikroTik que disca até o ERP.** Em 76 de 199 MikroTik classificados há um **cliente** de VPN
  (`l2tp-client` 60, `pptp-client` 47, `ovpn-client` 18, `sstp-client` 14, `wireguard` com endpoint 8; vários têm
  mais de um), 51 deles rotulados "SGP", quase todos discando para um **IP público** do servidor de VPN que o ERP
  fornece. O RADIUS do ERP costuma ser um IP **privado** alcançado por esse túnel (41 casos). Ou seja: o ERP
  fornece o servidor e as credenciais; a interface cliente é criada **no MikroTik** (pelo técnico do provedor ou pela
  API do ERP). Na migração o túnel antigo fica de pé até o fim da transição e só então é desativado.

### Huawei (OLT e roteador de borda) — SSH/CLI direto
- Cria **usuários de serviço próprios** (SGP: `sgpacesso`, `sgpolt`, `sgpsgp`, por senha).
- **Provisiona ONU na CLI**: `ont add <pon> <id> sn-auth "<SN>" omci ont-lineprofile-id 100 ont-srvprofile-id 100
  desc "importacao_sgp"` — perfis de ID **fixo (100)** e **tag `importacao_sgp`** no que importa/provisiona.

## 3. O que o NexoISP faz para assumir (procedimento de rede)

### MikroTik — repontar para o nosso RADIUS
Já temos o modelo RADIUS integrado + CoA (`nexo_agent/drivers/mikrotik_radius.py`, `internal/radius/*`). Migrar =
trocar o destino, não reescrever o equipamento:
1. `/radius` → apontar para o host do RADIUS do NexoISP (o painel gera o `.rsc`: `/api/radius/devices/:id/setup`,
   ver `radius_setup.go`); manter `service=ppp`, `interim-update`, e `/radius incoming accept=yes` (CoA nosso).
2. `/ppp aaa set use-radius=yes` (já está).
3. Importar os assinantes/planos/senhas pelo CSV (`/api/import/apply`, campos em `importFields`: `pppoe_usuario`,
   `pppoe_senha`, `plano`, `ip_fixo`…) — a fonte é o export do SGP/IXC (a base, não o equipamento).
4. Replicar a suspensão: nosso CoA/disconnect + a address-list/queue equivalente.
> Risco baixo: é o mesmo paradigma. **O painel gera o plano de troca** a partir do `/export` do concentrador
> (`POST /api/radius/devices/:id/repoint-plan`): acrescenta o nosso RADIUS (e túnel), **desativa — não apaga** — o
> RADIUS do ERP, deixa o túnel antigo para a fase 2 (comentado) e entrega o **script de volta**. Segredos do ERP
> nunca voltam na resposta. Sessões PPPoE já conectadas continuam; só os logins novos passam a autenticar aqui
> (comportamento do RouterOS a reconfirmar no CHR do laboratório antes da primeira janela real).
> Usuários locais em `/ppp secret` (autenticam antes do RADIUS) viram CSV do importador:
> `POST /api/import/mikrotik-secrets` (exporte com `show-sensitive` para trazer as senhas).

### Huawei — readotar as ONUs que o SGP deixou
1. Ler as ONUs com nosso driver (já validado em campo); as do SGP estão marcadas `desc "importacao_sgp"`.
2. **Adotar sem derrubar**: `HuaweiOltDriver.foreign_onus()` lista as ONUs sem marcador nosso (lidas do
   running-config, aceitando perfil por ID como o SGP grava) e `adopt(serial, "nexo:<id>:v1")` troca **só a
   descrição** (`ont modify <P> <ID> desc ...`): ONU, perfis e service-ports intactos, cliente navegando. Recusa ONU
   que já é de outro recurso nosso; idempotente; exige `allow_writes` + modelo/firmware aprovados. Provado por SSH real
   no emulador (`tests/test_olt_huawei_adocao_lab.py`: nenhum `ont delete`/`undo service-port`/`ont add` chega à OLT).
   Em equipamento real: primeiro numa ONU de teste do provedor, em janela.
3. Perfis: o SGP usa IDs fixos (100). Mapear os IDs reais do equipamento para os nossos perfis antes.

## 4. Rastreabilidade de CGNAT para ofício (Hillstone / A10 / RouterBoard)

Nosso modelo (`internal/network/cgnat.go`) já separa:
- **Determinístico** (`layout=sequential` = script nosso; `layout=netmap` = regras netmap): o NexoISP **calcula** o
  titular de IP público + porta + horário (`CGNATForward`/`CGNATSharers`) → IP privado → assinante no IPAM.
- **Externo/dinâmico** (`layout=external`): **não calcula**; registra onde está o log de NAT (`nat_log`: syslog /
  equipment / none) e orienta o ofício a consultá-lo (`CGNATNatLog`). Marco Civil: guardar o registro por 1 ano.

**Para cada box de CGNAT do provedor, classificar e cadastrar um plano de CGNAT:**
- **MikroTik RB com `action=netmap`** → `layout=netmap`, preencher `private_cidr`, `public_cidr`,
  `ports_per_subscriber`, `port_start/end` → **rastreável por cálculo**, sem depender de log.
- **MikroTik RB com `src-nat` + `to-ports=<faixa>` por bloco** → determinístico (PAT por bloco) → modelar como
  `sequential`/`netmap` conforme a ordem dos blocos → **rastreável por cálculo**.
- **MikroTik RB com `masquerade`** ou **Hillstone/A10 com PAT dinâmico** → `layout=external` + `nat_log` (de
  preferência `syslog`) → rastreável **só pelo log do box**; idealmente **ingerir o syslog de NAT** para virar
  rastreável no painel (tarefa nova — ver §6).

**Realidade de campo (corrigida em 12/11/2026, leitura do último backup de cada equipamento):**
- **MikroTik: CGNAT determinístico é comum.** 48 de 95 MikroTik com `100.64/10` usam o padrão de mercado: um salto
  por bloco privado para uma cadeia `CGNAT_n` e, dentro dela, `netmap` do bloco privado (`/29` na maioria; também
  `/30`, `/27`, `/26`, `/28`, `/25`) para um bloco público **do mesmo tamanho** numa faixa de portas (1008 ou 2016
  portas por assinante na maioria; 504, 4032 e 8064 também aparecem), `tcp` e `udp`, mais uma regra sem portas.
  A primeira medição ("netmap = 0") estava errada — o filtro do classificador não casava as cadeias `CGNAT_n`.
- **Hillstone (13 configs):** `snatrule ... mode dynamicport fixed-block start/end/size` — bloco **fixo** de portas
  atribuído **dinamicamente**: só o registro de NAT identifica o titular. Várias regras sem `log`; `logging traffic nat
  on` em 4 de 13.
- **A10 (3 configs):** `cgnv6 fixed-nat ... ports-per-user N offset random` com `create-port-mapping-file`: é
  determinístico para o A10, mas o deslocamento aleatório impede o cálculo — o titular sai do **arquivo de
  mapeamento** do próprio A10.

**O que o NexoISP faz com isso:**
- `POST /api/cgnat/analyze` lê a configuração (MikroTik, Hillstone ou A10), diz como o titular é identificado e
  **sugere os planos** (`layout=netmap` quando os blocos são contíguos e cada um usa a faixa de portas seguinte,
  conferido regra a regra; `external` + `nat_log` para Hillstone/A10).
- `POST /api/cgnat/mappings` importa **regras exatas** (netmap fora de ordem), **registro de NAT** (alocação/liberação
  de bloco, com hora; syslog sem ano usa o ano/fuso informados), **arquivo de mapeamento do A10** (vigente a partir de
  uma data) ou **CSV neutro**. O rastreio (`GET /api/cgnat/trace`) usa esses mapeamentos quando nenhum plano calcula
  o titular, respeitando o horário. Lotes listados e apagáveis; tudo auditado e isolado por provedor (migração 00104).
- O leitor de log é tolerante (procura IP privado, IP público, faixa de portas e hora; "release/free/withdraw" fecha o
  período) e **rejeita** o que não tem tudo isso. Ainda **não foi visto um log real** de Hillstone/A10: antes da
  primeira migração, importar uma amostra real e conferir as linhas rejeitadas.

## 5. Medições (último backup de cada equipamento, tabela `backups`, 12/11/2026)

- **ERP por provedor (91 com MikroTik/Huawei/CGNat classificados):** 61 só SGP; IXC em ~8; o resto sem marca de ERP.
- **MikroTik (199 classificados):** `erp_sgp` 90 · CoA ligado 73 · CGNAT `100.64/10` 86 (48 em netmap determinístico)
  · cliente de VPN 76 (51 rotulados SGP) · RADIUS privado provavelmente via túnel 41.
- **OLT Huawei:** marca SGP em 109; ONUs `importacao_sgp` em 15.
- **CGNAT dedicado:** Hillstone `fixed-block` dinâmico (13 configs), A10 `fixed-nat offset random` (3 configs).

## 5b. Validação AO VIVO, só leitura (12/11/2026)

Com autorização da Ajust, o código de migração foi conferido contra equipamentos reais de provedores (só comandos
`print`/`show`/`display`, com trava que recusa qualquer outro; processamento dentro do backup center; só contagens
saíram). Ferramenta: `apps/api-go/cmd/sonda-rede` (usa o próprio pacote `internal/network`).

| Equipamento | O que se provou |
|---|---|
| CGNAT MikroTik (RouterOS 7.11, ~150 mil conexões) | 96 regras netmap `CGNAT_n` lidas, 2 planos sugeridos. Em **5.995 conexões reais traduzidas, o titular calculado bateu 100%** — pela regra exata e pela fórmula do plano `netmap` |
| CGNAT MikroTik (RouterOS 7.21) | Netmap **só de endereço** (sem faixa de portas, origem negada) — passou a ser reconhecido como não rastreável sem registro de NAT. O 7.2x também mudou a tabela de conexões (`src-port=` separado) |
| Autenticador MikroTik com IXC (RouterOS 6.49) | Plano de troca correto; um RADIUS do ERP atendia `ppp,hotspot,wireless` → agora só `ppp,hotspot` mudam e o wireless fica. 298 usuários locais em `/ppp secret` avisados |
| Autenticador MikroTik com SGP (RouterOS 6.48) | ERP SGP, sem CoA, 2 VPN cliente (L2TP + PPTP) do SGP; plano e volta sem nenhum segredo |
| Hillstone com registro por sessão | Formato real `PRIV:porta->DEST:porta(TCP), snat to PUB:porta`: **1.551/1.551** registros lidos (antes: 0%, o leitor pegava o destino como IP público) |
| Hillstone NAT444 | Formato real `[NAT444 user exhausted port N PRIV - PUB - início fim]`: **1.656/1.656** lidos |
| Huawei NE20E/NE8000 (VRP 8) | Leitura ao vivo ok (o login pede troca de senha inicial; responder "N"). Plano Huawei conferido em **49 configurações reais**: 47 redirecionam só domínios de grupos do ERP, 2 ficam com aviso; nenhum segredo nos scripts |
| Cisco ASR1000 (IOS-XE 16.6 e 16.9) | Leitura ao vivo ok (servidores RADIUS do ERP `UP`). Plano Cisco redefine as listas nomeadas (`aaa ... <lista> group NEXOISP`) sem tocar bba-group/virtual-template |

**Escrita só no laboratório próprio** (CHR 7.17 real em QEMU, 34 clientes PPPoE reais, `radius-lab-pnetlab`): o
script gerado pelo NexoISP foi aplicado — 3 s, sem erro do RouterOS, **34 sessões: 0 quedas, 0 reconexões**; os
logins seguintes autenticaram **só** no RADIUS novo (contador do antigo parado); o script de volta restaurou RADIUS,
CoA e `interim-update` originais, também sem queda. A volta agora restaura `/ppp aaa` e `/radius incoming`.

Limites: nenhum script foi aplicado em equipamento de provedor; Huawei/Cisco não foram exercitados (só conferidos
contra configurações reais); registro de NAT do Hillstone por syslog (formato do servidor de logs) não foi visto —
o que se viu é o buffer do próprio equipamento.

## 6. Tarefas concretas de preparação

| # | Tarefa | Situação |
|---|---|---|
| 1 | Plano de troca do RADIUS (`repoint-plan`) com script de volta — MikroTik, Huawei NE e Cisco ASR | **feito** — MikroTik provado em CHR real (0 quedas); Huawei/Cisco conferidos em configurações reais |
| 2 | Usuários locais `/ppp secret` → CSV do importador | **feito** — `POST /api/import/mikrotik-secrets` |
| 3 | Adoção de ONU Huawei do SGP sem derrubar (`ont modify desc`) | **feito** — driver + laboratório SSH |
| 4 | Leitura de configuração de CGNAT com planos sugeridos | **feito** — `POST /api/cgnat/analyze` |
| 5 | Importação de mapeamentos (regras, log de NAT, arquivo A10, CSV) + rastreio | **feito** — migração 00104, painel CGNAT; leitor validado em registros reais de Hillstone (100%) |
| 6 | Preset de colunas do export do SGP/IXC | **pendente de amostra real**: sem um export real, adivinhar nomes de coluna gravaria errado (mesma regra de `10-migracao-sgp.md`). O importador já aceita mapeamento coluna→campo |
| 7 | Receber syslog de NAT em tempo real (hoje é importação de arquivo) | pendente |
| 8 | Adoção em lote na tela (hoje: driver/agente) e homologação em ONU de teste real | pendente |

**Nada disso toca equipamento de terceiro**: importação e repoint rodam na instância do provedor, em janela; a
análise do backup center é só leitura e anonimizada.
