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

> Proporção SGP × IXC por provedor: _(medida pelo classificador; ver §5)._

## 2. Como o SGP/IXC integram (camada de rede)

### MikroTik (autenticador/NAS) — RADIUS
- MikroTik configurado como NAS: `/radius add service=ppp[,hotspot,wireless] timeout=3s`, `/ppp aaa use-radius=yes`,
  accounting com `interim-update=20m`. **O usuário/senha/plano NÃO fica no `/ppp secret`** — mora no RADIUS do ERP.
- **Suspensão/liberação por RADIUS CoA/Disconnect** (`/radius incoming set accept=yes`): o ERP derruba a sessão; o
  próximo login cai no perfil bloqueado ou é negado. Bloqueio no plano de dados por **firewall address-list** + CGNAT.
- O ERP **etiqueta os objetos que cria com `comment`** (o SGP marca ~todos; o IXC também) e provavelmente usa a
  **API do RouterOS** para ler estado e empurrar firewall/queue.
- **Não instala scheduler/script próprio de rotina** no MikroTik (os agendadores vistos são de backup): age em
  tempo real (CoA + API), não por cron no equipamento. **Não instala VPN por equipamento** (nenhum
  l2tp/ovpn/sstp/wireguard-client): alcança o MikroTik pela rede/IP do provedor.

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
> Risco baixo: é o mesmo paradigma. O ponto de atenção é a **janela de corte** (repontar o `/radius` desconecta as
> sessões; refazer com os assinantes já importados).

### Huawei — readotar as ONUs que o SGP deixou
1. Ler as ONUs com nosso driver (já validado em campo); as do SGP estão marcadas `desc "importacao_sgp"`.
2. Readotar cada uma com o nosso marcador `nexo:<id>:v1` (reautorizar na mesma config, como o laboratório prova),
   trocando a descrição — em janela, numa ONU de teste primeiro.
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

**Realidade de campo (amostra de 160 configs MikroTik com NAT):** `netmap` = **0**, PAT por faixa fixa = **0**,
`masquerade` em todas — ou seja, **não se usa CGNAT determinístico** no campo (o `masquerade` ubíquo é o NAT básico de
WAN, não prova CGNAT, mas a ausência de `netmap`/faixa-fixa indica que o CGNAT real é **PAT dinâmico**). As 160 têm
logging ligado. **Conclusão para o ofício:** no provedor migrado, a rastreabilidade sai do **log de NAT**, não do
cálculo — o cálculo determinístico vale para o CGNAT que o *próprio NexoISP* gerar. Por isso a **ingestão de log de
NAT (§6, tarefa 4) é a prioridade** para atender ofício em base migrada.

## 5. Medições

- **CGNAT (amostra 160 MikroTik):** netmap 0 · src-nat por faixa 0 · masquerade/dinâmico predominante; todas com
  logging. Hillstone 23 e A10 5 (boxes dedicados) usam PAT dinâmico → rastreáveis por log. _Classificação por box
  dedicado (não por amostra genérica) fica como refino._
- **Proporção SGP × IXC:** qualitativa por ora — **SGP é claramente dominante** (assinatura forte e ampla no Huawei:
  usuários `sgp*`, `importacao_sgp`; e comentários em ~todos os MikroTik da amostra), **IXC presente** (scripts
  `IXCProvedor-*`). A contagem exata por provedor precisa de um scan mais rápido (grep só nos arquivos certos, ou pela
  tabela `backups` do banco) — o grep recursivo em 134 provedores é lento demais.

## 6. Tarefas concretas de preparação

1. **Preset de importação SGP e IXC**: mapear os cabeçalhos do export de cada um para os `importFields` (hoje o CSV é
   genérico; um preset por ERP evita mapear à mão). Precisa de um export real de cada para fixar os nomes.
2. **Gerador de repoint MikroTik**: a partir do `radius_setup`, emitir o `.rsc` que troca o `/radius` do SGP/IXC pelo
   nosso, preservando CoA e service, para colar em janela.
3. **Readoção de ONU Huawei em lote**: ler ONUs `importacao_sgp` e reautorizar com marcador nosso (usa o fluxo do
   laboratório; homologar antes em lab real).
4. **Ingestão de log de NAT (CGNAT dinâmico)**: receber o syslog de NAT de Hillstone/A10/RB-masquerade e indexar
   (IP+porta+hora → IP privado), para o ofício ficar rastreável mesmo sem cálculo determinístico.
5. **Cadastro de plano de CGNAT por box**: assistente que lê a config do box (netmap/src-nat/masquerade) e já sugere
   `layout`/`nat_log`.

**Nada disso toca equipamento de terceiro**: importação e repoint rodam na instância do provedor, em janela; a
análise do backup center é só leitura e anonimizada.
