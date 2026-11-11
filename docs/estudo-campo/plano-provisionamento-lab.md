# Plano de provisionamento de ONU (autorizar/desautorizar) — a validar em laboratório

Status: **PENDENTE**. Autorizar e desautorizar ONU são **escritas** na OLT e **não** são executadas em
equipamento de terceiro em produção. Os drivers hoje **recusam** essas ações. Este documento deixa o terreno
pronto: as famílias de comando observadas no reconhecimento/`running-config` reais de cada marca, o passo de
verificação (read-back) e o procedimento de homologação num lab. Nada aqui foi executado em OLT.

## Regra de segurança (vale para todas as marcas)
- Só homologar numa **OLT de laboratório** (ou numa ONU de teste dedicada). Nunca na OLT de um provedor em produção.
- Toda autorização termina com **read-back** pelo driver (`read_onu(sn)`) confirmando `authorized=True` e, quando online, sinal plausível.
- O comando só é liberado no driver depois de validado em lab; até lá `authorize`/`deauthorize` continuam levantando erro.
- Idempotência: antes de autorizar, checar se a SN já está autorizada (evita duplicar `onuid`).

## Por marca — comandos candidatos (confirmar em lab)

### Huawei SmartAX (MA5600T/MA5800) — já há código no driver, falta homologar
- Autorizar: `interface gpon 0/<frame>/<slot>` → `ont add <port> <ontid> sn-auth <SN> omci ont-lineprofile-id <lp> ont-srvprofile-id <sp> desc <nome>` (ou `ont confirm <port> sn-auth <SN> ...` para ONU em autofind).
- Serviço: `ont port ...`, `service-port ... gemport ... vlan ...` conforme o perfil do provedor.
- Desautorizar: `ont delete <port> <ontid>`.
- Read-back: `display ont info by-sn <SN>`.

### ZTE ZXA10 (C300/C320)
- Autorizar: `configure terminal` → `interface gpon-olt_1/<shelf>/<slot>/<port>` → `onu <id> type <perfil> sn <SN>`; depois `interface gpon-onu_1/<shelf>/<slot>/<port>:<id>` → `tcont`, `gemport`, `service-port`.
- Desautorizar: sob a `interface gpon-olt_...`, `no onu <id>`.
- Read-back: `show gpon onu detail-info gpon-onu_1/s/sl/p:<id>` (já implementado na leitura).

### Datacom DmOS (DM46xx)
- Autorizar: `config` → `interface gpon <f/s/p>` → `onu <id> serial-number <SN>` + `line-profile`/`service` conforme perfil; `commit`.
- Desautorizar: `interface gpon <f/s/p>` → `no onu <id>`; `commit`.
- Read-back: `show interface gpon <f/s/p> onu` (já implementado na leitura).

### Intelbras OLT (8820i/4820)
- Autorizar: `enable` → candidato `onu authorize gpon <link> onu <id> type <modelo> sn <SN>` (confirmar a forma exata em lab; o `onu ?` lista `authorize`/`add`).
- Desautorizar: candidato `onu deauthorize gpon <link> onu <id>` / `no onu ...`.
- Read-back: `onu status` (já implementado na leitura).

### FiberHome AN5516
- Autorizar (whitelist): `enable` → `cd onu` → candidato `set whitelist phy_addr address <SN> password null action add slot <s> pon <p> onutype <type> onuid <id>`.
- Desautorizar: candidato `set whitelist phy_addr address <SN> action delete` (ou `del_whitelist ...`).
- Read-back: `show authorization slot <s> pon <p>` (já implementado na leitura).

### VSOL / Parks
- Reconhecimento de leitura ainda pendente (acesso). Mapear leitura primeiro; só então os comandos de escrita.

## Procedimento de homologação (quando houver lab)
1. Conectar o driver ao OLT de lab (cadastrar como device com o driver da marca).
2. Autofind: `discover()` deve listar a ONU de teste não autorizada.
3. Autorizar via o comando da marca; conferir echo sem erro.
4. `read_onu(<SN>)` → `authorized=True`; subir a ONU e confirmar `online` + sinal.
5. Desautorizar; `read_onu` → `authorized=False`; autofind volta a listar.
6. Só depois de 1–5 OK, trocar `authorize`/`deauthorize` de "recusado" para a implementação, com teste unitário de formatação do comando e read-back obrigatório.
