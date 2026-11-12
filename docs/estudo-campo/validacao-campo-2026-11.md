# Validação dos drivers de OLT em equipamento real — rodada 2026-11-11/12

Registro de campo da validação dos drivers de leitura de OLT contra equipamentos **reais** de provedores
que autorizaram o teste (via acesso do backup center). Serve para as próximas rodadas: o que foi testado, qual
**erro** deu, o **diagnóstico**, a **decisão** e **como foi corrigido** (com o commit). Complementa
[`recon-cli-olts.md`](recon-cli-olts.md).

> Nada aqui contém serial, MAC, IP de cliente, senha ou config de terceiro. Só contagens, modelos/firmware,
> faixas de sinal e formatos de CLI (anonimizados). Os dados crus ficaram em temporários apagados ao fim.

## Regras da rodada (inegociáveis)

- **Só leitura.** A sonda recusa comando mutante; autorização/escrita de ONU **não** é homologada e fica fora.
- **Só provedores que autorizaram nominalmente:** Cyber Net, GL Soluções, Ponto Net, TC+ Fibra e Vibe. Não
  estender para outros dos ~132 do backup center sem autorização nominal.
- **Nada de marca do produto nos equipamentos** (sem "NexoISP" em descrição/comentário/usuário — nome ainda indefinido).
- **Não deixar nada:** apagar todos os temporários (sonda, scripts, export) do container, do host e do scratch.
- **Não martelar a mesma OLT em rajada.** FiberHome bloqueia login após ~5 falhas; com a senha correta (login não
  falha), o risco é baixo. Uma OLT por vez, com intervalo.
- **Não apagar log de acesso/auditoria** no equipamento de produção do provedor nem no backup center.

## Como a sonda roda (ambiente)

- Inventário e credenciais no Postgres `backup_sys_db` (tabela `devices`: `password_encrypted` Fernet). Decifra com
  `app.core.security.decrypt_password` **dentro de um container** (nunca imprimir a senha; só o comprimento).
- **Runner:** container `backup_sys_celery` (tem netmiko, pexpect, telnet, ssh e alcança as OLTs). O `backup_sys_app`
  travou sob carga alta (load ~69 durante o backup diário) — preferir o celery.
- Porta-se o pacote `services/network-agent/nexo_agent` para `/tmp/sonda` no container; roda com `PYTHONPATH=/app`
  e `cwd=/tmp/sonda/network-agent`; apaga ao fim.
- **Armadilhas de ambiente:**
  - Kernel do host é customizado (pnetlab): a imagem oficial do Playwright e o `python:3.11` precisam de
    `--security-opt seccomp=unconfined`; o Docker às vezes falha no bridge (usar `--network none` para testes offline).
  - `docker exec -i` dentro de um `while read` **come o stdin** do laço (a lista de alvos). Redirecionar com `</dev/null`.
  - O painel em execução é o projeto compose **`nexoisp-painel`** (:18380, demo off), **separado** do projeto
    **`nexoisp`** que o `./nexo` opera. Rodar testes unitários do agente em `python:3.11` com `--network none`.

## Resultado por fabricante

### Huawei (MA5600/MA5800) — OK, sem correção
- **Testado:** Vibe (MA5683T R017), GL (MA5683T R015), TC+ (MA5608T R018), Cyber Net (MA5800-X2 R022).
- **Resultado:** identidade, autofind, export de config e **leitura de sinal** OK. Ex. real: Rx −28,86 / Tx 2,55 dBm.
- **Achado aberto:** a única OLT por **SSH** (Ponto Net) deu `SSH trust file is not configured` — o caminho SSH do
  Huawei precisa do arquivo de confiança configurado (as demais são telnet). **Pendente.**

### FiberHome (AN5516) — CORRIGIDO (commit `84a5c10`)
- **Erro:** leitura de ONU trazia `rx/tx = null`.
- **Diagnóstico:** o driver mandava `show onu optical-info slot all pon all onu all`, que **não existe** neste
  firmware (`% Unknown command`); e `show onu opticalpower-info` sem argumento volta vazio. O help da OLT
  (`show onu ?`) revelou que a potência é **por ONU**: `show onu opticalpower-info phy-id <serial>`, com saída
  `SEND POWER` (tx) e `RECV POWER` (rx) em dBm. A tabela de autorização (`show authorization slot all pon all`) já
  era lida certa.
- **Decisão/correção:** `read_onus` passou a consultar a óptica **por ONU** (só das online); novo
  `parse_optical_power` substituiu o `parse_optical_table` (tabela em massa inexistente).
- **Validação ao vivo:** Cyber Net CENTRAL (2.146 autorizadas) e ACUDE (1.600) — ex. Rx −16,67 / Tx 2,50 dBm.

### ZTE (ZXA10, inclui XGSPON) — CORRIGIDO (commits `8eca244` e `c3faf2c`)
- **Erro 1 — inventário:** `check` voltava "0 placas / 0 GPON".
  - **Diagnóstico:** o `show card` do firmware **XGSPON** usa `Shelf Slot CfgType CardName Port HardVer Status`
    (2 inteiros no início, **sem** coluna Rack), enquanto o `parse_card` só entendia o layout C300 de 3 inteiros.
  - **Correção (`8eca244`):** `parse_card` trata os dois layouts (com e sem Rack) e linhas OFFLINE sem CardName;
    `check` conta placas de acesso PON pelo prefixo "G". Validado: 9 placas, 4 PON.
- **Erro 2 — leitura de ONU/sinal:** `read_onu` voltava "não autorizada" para índices reais.
  - **Diagnóstico:** o `detail-info`/`pon power` recusavam o token `gpon-onu_f/s/p:id` (`%Error 140303 Invalid input`);
    o XGSPON usa `gpon_onu-f/s/p:id` (separadores invertidos). O detail-info e as potências em si já batiam com os parsers.
  - **Correção (`c3faf2c`):** `_read_index` tenta os dois formatos de interface e usa o aceito; `parse_power` tolera
    ambos no onu-rx.
  - **Validação ao vivo:** NOBRE, IGARASSU, PAU AMARELO — ex. Rx −31,55 / Tx 3,22 dBm.
- Observação: `show gpon onu state` sempre funcionou (listou 1.022 ONUs no NOBRE); o problema era só placas e token.

### VSOL (BDCOM — EPON e GPON) — CORRIGIDO (commit a seguir, mesma rodada)
- **Erro:** TC+ Itapissuma conectava mas `parse_authorized` voltava **0 autorizadas** (a GL, EPON, lia 51).
- **Diagnóstico:** o tipo "VSOL" no backup center cobre EPON **e GPON**. A GL é EPON (`interface epon`, autoriza com
  `confirm onu mac <MAC> onuid <N>`); a TC+ é **GPON** (`interface gpon`, autoriza com
  `onu add <N> profile <perfil> sn <SERIAL>`). O parser só casava a forma EPON.
- **Decisão/correção:** `parse_authorized` passou a reconhecer **as duas formas**, associando à seção
  `interface epon/gpon f/p` corrente (uma interface não-PON encerra a seção). A busca em `read_onus` tenta
  `norm_mac(sn)` **e** o SN cru (um SN GPON de 12 hex seria mal normalizado como MAC).
- **Validação ao vivo:** TC+ Itapissuma passou de 0 para **83 autorizadas** (gpon 0/1..0/8); amostra lida como
  autorizada. **online/sinal continuam indisponíveis via CLI** (limitação do modelo; exigiria SNMP).
- Observação: VSOL Ponto Net (23023) deu `connection refused` no momento (porta/transporte, não é código).

### Datacom (DmOS) — CORRIGIDO (commit a seguir, 2026-11-12)
- **Erro:** `check` identificava (DmOS 10.8.0) mas a leitura de ONU estourava `Pattern not detected '[>#]'`.
- **Diagnóstico:** o DmOS pagina a saída (`--More--`) e o prompt nunca retornava. O modificador correto para
  suprimir a paginação é **`| nomore`** (sem hífen; `| no-more` é inválido e dispara o help de modificadores).
  Os parsers (`parse_onu_list`, `parse_optical` com `Rx/Tx Optical Power [dBm]`) já estavam corretos; e `_ports`
  dependia de um comando que neste firmware devolve o detalhe da ONU, não a lista de portas.
- **Correção:** `DatacomCli.run` anexa `| nomore`; `_ports` enumera a faixa do DM4615 (1/1/1..1/1/16) e o
  `_onu_index` pula portas que dão erro. `optical-info` dá o sinal da ONU; há ainda `rssi` (potência no OLT).
- **Validação ao vivo (AtivaTec):** 767 ONUs em 13 portas GPON, 644 online, sinal real (ex. rx −15,33 / tx 2,50 dBm).

## Huawei por SSH (Ponto Net) — RESOLVIDO (operacional, 2026-11-12)
Não era bug: o `ssh_trust.py` nunca auto-aceita a chave do host — exige a chave fixada num known_hosts, verificada
fora de banda. "SSH trust file is not configured" = trust file ausente. Com a chave fixada, a leitura por SSH
funcionou (MA5800-X7 R018). Produção: conferir o fingerprint por canal independente e usar
`python -m nexo_agent.ssh_trust --known-hosts ... --host ... --public-key ... --fingerprint ... --reason ...`.

## Itens abertos para a próxima rodada

1. **VSOL GPON — sinal:** investigar se o BDCOM GPON expõe potência óptica por CLI (hoje online/sinal = indisponível).
2. **Autorização/escrita de ONU (autorizar/desautorizar):** NÃO fazer em cliente real. Os drivers recusam escrita de
   propósito (sintaxe por firmware não testada); desautorizar corta internet de cliente e um re-auth não testado
   pode deixá-lo offline. Homologar no laboratório (radius-lab-pnetlab / OLT de lab) com rollback e, para teste ao
   vivo, só numa ONU de TESTE que o provedor separe (não cliente pagante), em janela.

## Índice de commits desta rodada

| Commit | Fabricante | Correção |
|---|---|---|
| `84a5c10` | FiberHome | leitura óptica por ONU (`opticalpower-info phy-id`) |
| `8eca244` | ZTE | parser de placas (layout XGSPON sem Rack) |
| `c3faf2c` | ZTE | leitura de ONU/sinal (token de interface `gpon_onu-`) |
| `2bd5a79` | VSOL | lista de autorizadas GPON (`onu add ... sn`) + busca por SN |
| (este) | Datacom | leitura de ONU + sinal (paginação `\| nomore`, enumeração de portas) |
