# Estudo de backups reais de OLT Huawei — o que muda no NexoISP

Data: 10/11/2026. Fonte: backups diários de configuração (`display current-configuration`) de OLTs Huawei de terceiros, lidos somente no servidor de backup, em modo leitura. Nada foi copiado; este documento traz apenas contagens e formas normalizadas (textos entre aspas → `<txt>`, números → `N`, seriais → `<SN>`). Nenhum provedor, equipamento, nome, serial, IP, senha ou descrição real aparece aqui.

## 0. Qualidade da base (ler antes dos números)

- 138 pastas de dispositivo com arquivos `.cfg` (não 386: as demais estão vazias). **13 pastas são cópias da mesma OLT** (mesmo conjunto de ONTs) e **15 arquivos trazem a coleta repetida** (a primeira cópia vem truncada; o comando é reenviado e a segunda é a completa). Sem esse cuidado os totais incham 25–40%.
- Depois de deduplicar: **124 OLTs distintas com ONTs, 129.938 ONTs, 131.249 service-ports.**
- Correção para `docs/expansao-olt-onu.md` (linha 73): o texto fala em "134 OLTs reais conferidas (164.816 ONUs)". Esse total provavelmente inclui pastas e coletas duplicadas (a contagem bruta de linhas `ont add` dá 182.546). O correto é **124 OLTs / 129.938 ONTs**. Os 84% de user-vlan diferente da VLAN de saída se confirmam: **83,9%** (110.135 de 131.249).

## 1. Números principais

### Plataforma
| Item | Valor |
|---|---|
| Família/firmware (OLTs) | MA5600 V800R015: 25 · R017: 19 · R018: 14 (**58 OLTs, 47%**) — MA5800 V100R018: 29 · R022: 13 · R019: 9 · R021: 7 · R023: 4 · R024: 2 · R020: 1 · R017: 1 (**66 OLTs, 53%**) |
| ONTs por família | MA5600 ≈ 68.500 (53%) · MA5800 ≈ 61.400 (47%) |
| Controladoras | H802SCUN, H801MCUD1, H801SCUK/H (MA5600/5608); H901MPSC/MPSG/MPSA, H90xMPLA/MPLB (MA5800) |
| Placas GPON | H805GPFD (114), H903GPSF (33), H901GPHF (31), H807GPBD (21), H901GPUF (20), H902GPLF (16)… |
| Slots GPON por OLT | p50 = 2, p90 = 4, máx = 14 |
| PONs usadas por OLT | p50 = 20, p90 = 55, p95 = 64, máx = 189 |
| ONTs por OLT | p50 = 724, p90 = 2.184, p95 = 3.019, máx = 6.756 |
| ONTs por PON | p50 = 29, p90 = 80, p95 = 94, p99 = 117, **máx = 128 (PON cheia, 4 casos)** |

### `ont add`
| Item | Valor |
|---|---|
| Forma | `ont add N N sn-auth <txt> omci ont-lineprofile-id N ont-srvprofile-id N desc <txt>` em **129.937 de 129.938** ONTs |
| Autenticação | sn-auth 100% (1 caso sn+password); **LOID: 0** |
| Gerência | OMCI 100% |
| ONT-ID | começa em 0 em 95,4% das PONs; 60,6% das PONs sem buracos; **nenhum ID ≥ 128** |
| Descrição | presente em 95,8%; 65% contêm espaço; 11,4% têm mais de 32 caracteres; máximo observado 126 |
| Descrição repetida dentro da OLT | p50 = 6 ONTs, p90 = 112 por OLT (não é chave) |

### Perfis
| Item | Valor |
|---|---|
| Perfis de linha definidos por OLT | p50 = 6, p90 = 43, máx = 104 |
| Perfis de linha **usados** por OLT | p50 = 3, p90 = 17, máx = 48 |
| Fatia do perfil de linha mais usado | p50 = **92,9%** das ONTs da OLT |
| Perfis definidos e não usados | p50 = 3 por OLT (linha), 2 (serviço) |
| Nome padrão Huawei (`line-profile_N`/`srv-profile_N`) | **63% das ONTs** usam perfil com nome padrão (o operador pensa no ID) |
| Nome com espaço (reprovado pelo validador da API) | 44 ONTs |
| GEMs por perfil de linha | 1 em 82%; 0 em 8%; 2+ em 10% |
| Índice de GEM nos perfis | 100, 1, 500, 0, 400, 200, 600, 700, 800… |
| `gem mapping` | `vlan N` em 94%; `eth N` 3,5%; `priority N` 1,8% |
| DBA usado (ponderado por ONT) | **type4 max=1024000 em 86%**; type4 ≈1,0–1,2 Gbps em 98%; type1/2/3 < 2% |
| Serviço: `ont-port eth adaptive` | maioria; `port vlan eth N translation N user-vlan N` 3.358 linhas |

### `service-port`
| Item | Valor |
|---|---|
| Forma | `service-port N vlan N gpon N/N/N ont N gemport N multi-service user-vlan N tag-transform translate` em 99,5% |
| tag-transform | translate 130.601 · transparent 267 · default 225 · translate-and-add (QinQ) 156 |
| **gemport** | **100: 56,6% · 400: 16,8% · 1: 9,4%** · 500: 4,3% · 600: 2,6% · 10: 2,1% · 300: 1,6%… |
| gemport existe no perfil de linha da ONT | **100%** |
| user-vlan = VLAN do `gem mapping` do perfil | **99,3%** |
| user-vlan | 100 em 63,8%; ≠ VLAN de saída em 83,9% |
| user-vlan dominante (≥99%) na OLT | só 42 de 124 OLTs; <90% em 55 |
| gemport dominante (≥99%) na OLT | 46 de 124; <90% em 49 |
| (gem, user-vlan) único por perfil de linha | 74 de 124 OLTs |
| SP por ONT | 1: 98,6% · 0: 276 ONTs (49 OLTs) · 2–5: 1.493 ONTs (**40 OLTs**) |
| Tabela de tráfego no SP | 1,7% (2.230), em 18 OLTs |
| Índice do SP | gerado pela OLT, com buracos (p50 de 45% de índices livres; máx 17.764) |
| VLANs de saída distintas por OLT | p50 = 25, p90 = 84, máx = 255 |

### Esquema de VLAN (por OLT)
| Esquema | OLTs | ONTs |
|---|---|---|
| VLAN por PON (1 VLAN por porta, não compartilhada) | 57 | 54.209 |
| Misto (várias VLANs por PON: serviço/plano) | 60 | 71.290 |
| VLAN única por OLT | 5 | 4.241 |
| VLAN por cliente | 2 | 198 |

Fórmula da VLAN quando há 1 por PON: `base + slot×16 + porta` em 43 OLTs, `base(slot) + porta` em 39, sem regra em 24. **82 de 124 OLTs (66%) têm VLAN calculável pela porta PON.** Considerando todas as OLTs, em 90 de 124 a VLAN de saída fica determinada pelo trio (PON, perfil de linha, user-vlan) em ≥ 80% das ONTs; a mediana é 1 VLAN por PON.

### ONU em bridge x roteador
| Comando por ONT | OLTs | ONTs |
|---|---|---|
| `ont port native-vlan … eth N vlan N priority 0` | **123 de 124** | **116.971 (90,0%)**; 200.018 linhas; prioridade sempre 0; = user-vlan do SP em 96,1% |
| nº de portas com native-vlan | 1: 67,5% · 4: 19,5% · 0: 10,0% · 3: 1,8% · 2: 1,1% · 8: 0,1% |
| ONTs sem native-vlan | 12.967; 10.132 delas com `port vlan eth` no perfil de serviço |
| `ont tr069-server-config` (ACS via OMCI) | 15 (12%) | 16.878 (13%); dentro dessas OLTs, cobertura p50 = 95% |
| Perfis TR-069 (`ont tr069-server-profile`) | 18 | URLs: http, porta 7547 (25 de 25), caminho vazio, `/` ou `/tr069` |
| `ont ipconfig … pppoe … user-account` (PPPoE na ONU por OMCI) | 7 | 381 (0,3%) |
| `ont wan-config` / `ont internet-config` / `ont policy-route-config` | 7 / 7 / 5 | 379 / 379 / 366 |
| `ont port route … enable` | 7 | 381 |
| `ont port vlan … q-in-q … user-encap PPPoE` | 4 | 1.942 |
| `ont deactivate` | 3 | 84 |
| Wi-Fi/VoIP por OMCI | 0 | 0 |

### Práticas gerais (OLTs com)
SNMP community (v2c) 113 · SNMPv3 0 · trap host 10 · NTP unicast 19 (15%) · syslog 69 (56%) · HWTACACS 20 · RADIUS de gerência 10 · telnet habilitado 37 (30%) · timezone 41 · autosave 95 · auto-backup FTP/SFTP 24 · `ont-auto-find enable` 124 (100%) · `ont-password-renew` 35 · `auto-add-policy` 1 · `ont autofind timeout` 4 · `gpon ont home-gateway config-method omci` 22 · alarme/limiar óptico configurado na OLT 0 (só limiares de CPU/memória/MAC) · IGMP/multicast 4 · DHCP option82/PITP 2 · MPLS/VPLS 73 · OSPF/BGP 16.

### Descrições (formas normalizadas; `a` = palavra, `Nk` = k dígitos)
Classes: contém `@` (login PPPoE/e-mail) **37%** · código + texto 30% · várias palavras (nome) 12% · palavra minúscula 10% · login com separador 6% · só dígitos 1,6% · `ONT_NO_DESCRIPTION` 1,2% · serial 0,3%.
Formas mais comuns: `a` · `N4 - a` · `N5 - a` · `a@a` · `N5 - a@a` · `N5 - a.a@aN1a` · `a a a a` (nome completo) · `N5 - a@a.a.a` · `N6 - N11@a`. **O padrão dominante é "<nº do contrato/cliente> - <login PPPoE>"**; o nome do cliente aparece em seguida. Em `service-port desc` (11 OLTs, 4.634 SPs) o texto é o nome do cliente (`a a a a`).

### Rotatividade diária
Comparação do último backup de cada dia, dia contra dia, nos últimos 45 dias de cada OLT: 120 OLTs, **4.445 pares OLT-dia** válidos (54 dias ignorados por coleta incompleta e 86 por intervalo diferente de 1 dia). A coleta roda às 03h, então cada arquivo reflete o dia anterior.

| Medida por OLT-dia | média | p50 | p90 | p95 | p99 | máx |
|---|---|---|---|---|---|---|
| ONTs adicionadas | 0,83 | 0 | 2 | 3 | 7 | **35** |
| ONTs removidas | 0,60 | 0 | 2 | 3 | 6 | 26 |
| Mesmo serial em outra PON/ID | 0,21 | 0 | 1 | 1 | 2 | 33 |
| Troca de perfil (mesma ONT) | 0,05 | 0 | 0 | 0 | 1 | 33 |
| Troca de descrição | 0,15 | 0 | 1 | 1 | 2 | 18 |
| Troca de service-port (mesma ONT) | 0,01 | 0 | 0 | 0 | 1 | 4 |

- Taxa da frota: **0,81 adições e 0,58 remoções por 1.000 ONTs por dia** (crescimento líquido ≈ 0,23‰/dia ≈ 7‰/mês). São ~100 adições e ~72 remoções por dia nas 120 OLTs.
- Média por OLT: adições p50 = 0,6/dia, p90 = 1,9, máx = 10; pico diário por OLT p50 = 3, p90 = 6, máx = 35.
- Dia da semana (eventos por OLT): domingo ≈ 0,16; segunda a sábado entre 1,2 e 2,0.
- **Reuso de ONT-ID:** das 3.705 adições, 870 (23%) usaram um ID liberado no mesmo dia e 426 (11%) um ID liberado antes.
- **Troca de ONU:** 1.206 pares remoção + adição na mesma PON e no mesmo dia (≈ 33% das adições). 459 adições (12%) são de um serial que tinha sido removido no período: o próprio operador apaga e recria.

## 2. Achados que afetam o NexoISP

Prioridade: **alta** = autorização/leitura falha ou estraga serviço em OLT real; **média** = funciona, mas gera erro operacional ou não escala; **baixa** = melhoria ou confirmação. Esforço: P (≤1 dia), M (2–4 dias), G (1–2 semanas).

### A1. `gemport` fixo por OLT (padrão 1) está errado para ~91% dos service-ports — alta, M
- **Evidência:** gemport 1 aparece em só 12.387 de 131.249 SPs (9,4%); 100 em 56,6%, 400 em 16,8%. O gemport do SP existe no perfil de linha da ONT em **100%** dos casos e varia por perfil: só 46 de 124 OLTs têm um gemport em ≥ 99% dos SPs, e em 49 OLTs o mais comum cobre < 90%. Num mesmo backup há perfis com GEM 1, 100 e 410 lado a lado.
- **O que muda:** `HuaweiOltDriver.authorize` (`services/network-agent/nexo_agent/drivers/olt_huawei.py`) não deve usar `self.gemport` da credencial. Deve ler o perfil escolhido (`display ont-lineprofile gpon profile-name <x>` ou `profile-id`) e pegar o GEM (e a VLAN do `gem mapping`, ver A2). Se o perfil tiver mais de um GEM com VLAN, recusar e pedir a escolha. Assim o valor de `credentials.json` vira só a última alternativa, e a documentação (`docs/expansao-olt-onu.md`, "padrão `gemport 1`") precisa ser corrigida. Com o padrão atual, numa OLT típica o `service-port` falha e a ONT fica criada sem serviço.
- **Emulador** (`olt_huawei_emulator.py`): os perfis passam a ter GEMs (`residencial` → GEM 100/VLAN 100, outro → GEM 1/VLAN 1000). `service-port` com GEM que não existe no perfil deve devolver `Failure`. Também falta `display ont-lineprofile gpon profile-name X`.

### A2. `user_vlan` por OLT resolve o caso comum, mas o certo é por perfil de linha — alta, P (junto com A1)
- **Evidência:** confirma-se a correção já feita: user-vlan ≠ VLAN de saída em 83,9% e vale 100 em 63,8% dos SPs. Mas só 42 de 124 OLTs têm uma user-vlan em ≥ 99% dos SPs; em 55 a mais comum cobre < 90% (por OLT: p50 = 3, p90 = 25 valores distintos). A user-vlan é igual à VLAN do `gem mapping` do perfil em **99,3%**, e (GEM, user-vlan) é único por perfil em 74 OLTs.
- **O que muda:** obter `user_vlan` do mesmo readback do perfil usado em A1, deixando `user_vlan` da credencial só como alternativa. Teste novo: duas ONTs na mesma OLT com perfis diferentes (GEM 100/VLAN 100 e GEM 1/VLAN 1000) recebem SPs diferentes.

### A3. Falta `ont port native-vlan`: ONU em bridge fica sem tráfego — alta, M
- **Evidência:** 116.971 ONTs (**90,0%**), em **123 de 124 OLTs**, têm `ont port native-vlan <P> <ID> eth <E> vlan <V> priority 0` (200.018 linhas). A prioridade é sempre 0 e a VLAN é igual à user-vlan do SP em 96,1%. Portas configuradas: só eth 1 em 67,5%, as 4 em 19,5%. Das 12.967 ONTs sem esse comando, 10.132 dependem de `port vlan eth N translation` no perfil de serviço. Os perfis de serviço usam `ont-port eth adaptive` na maioria, então o perfil não diz quantas portas existem.
- **O que muda:** em `authorize`, depois do `ont add`, rodar `ont port native-vlan <P> <ID> eth <E> vlan <user_vlan> priority 0` para as portas configuradas (padrão: eth 1; opção "todas as LAN do modelo", tirando o número de portas do catálogo `onu_catalogo.go`/`ports`). Na leitura, conferir a native-vlan; o comando de leitura e a saída exata precisam ser confirmados em equipamento real. Incluir no `docs/expansao-olt-onu.md`. O emulador aceita, guarda e mostra o comando. Teste: ONU autorizada sem native-vlan conta como "não aplicada".

### A4. Descrição `nexo:<id>:vN` contraria a prática e impede adotar ONTs existentes — alta, G
- **Evidência:** 95,8% das 129.938 ONTs têm descrição do operador e **nenhuma** usa marcador de máquina. 37% contêm `@` (login PPPoE); a forma dominante é `"<nº contrato> - <login>"` (`N5 - a@a`, `N4 - a`, `N5 - a.a@aN1a`…); 65% contêm espaço. Por isso **76,6%** reprovam o `_safe` do driver, que não aceita espaço. 11,4% passam de 32 caracteres.
- **Efeitos no código atual:** (1) `OnuFamily.execute` (`executor.py`, linha 178) recusa toda ONT já autorizada cuja descrição não seja `nexo:` ("adoção/remoção automática recusada"). As ONUs vindas do importador (`importOnlyKey`, `importacao_ampliada.go`) ficam presas: o primeiro "Reaplicar" falha e a leitura periódica as marca como divergência. (2) Cada ONU provisionada pelo NexoISP perde na CLI o contrato e o login, que é o que o técnico procura no campo.
- **O que muda:** (a) descrição composta e legível, p. ex. `<contrato>-<login> nx:<8hex>v<n>`, até 64 caracteres. O marcador vira um sufixo procurado por regex em `version_from_description` (`olt_base.py`) e em `envelope.py` (`description`). Validar o tamanho máximo por firmware em equipamento real. (b) Fluxo explícito de **adoção**: ler `ont info` + `service-port` da ONT existente, mostrar a diferença e gravar a intenção igual ao observado, sem nenhuma escrita na OLT. Só depois aplicar a descrição composta, em operação própria (`ont modify <P> <ID> desc`, sem recriar a ONT). Sem isso a migração de um provedor com ~700 ONTs por OLT (mediana) é inviável.

### A5. Leitura periódica uma a uma não escala para OLT real — alta, M
- **Evidência:** ONTs por OLT: p50 = 724, p90 = 2.184, máx = 6.756. Para cada ONU, `read_onus` envia 4–5 comandos (`display ont info by-sn`, `display service-port … ont`, `interface gpon`, `optical-info`, `quit`). São ~3.600 comandos por ciclo na OLT mediana e ~11.000 no p90, contra `poll_interval_s = 60`. Além disso, uma exceção numa ONU descarta o lote inteiro (`agent.py`, linha 109: `bulk = {}`), e a OLT fica sem estado relatado.
- **O que muda:** usar leitura agregada por placa/PON (`display ont info <F/S> all`, `display ont optical-info <P> all` em `interface gpon`, `display service-port all` ou `display current-configuration section bbs-config`). O custo vira proporcional às PONs (p50 = 20, máx = 189), não às ONUs. A falha passa a ser isolada por ONU. O emulador precisa das saídas `… all` com centenas de ONTs; um teste de carga com 2.000 ONTs deve fechar o ciclo em tempo limitado.

### A6. Reaplicar/alterar recria a ONT (delete + add) — média, M
- **Evidência:** `OnuFamily.execute` desautoriza e reautoriza sempre que a versão muda (troca de VLAN, perfil ou descrição). Na OLT real o ONT-ID volta ao menor livre (95% das PONs começam em 0 e 61% não têm buracos, então o ID pode mudar) e a ONU cai. Na base real, porém, a troca de perfil (0,05/OLT-dia) e a de service-port (0,01) são raras; a de descrição (0,15) é mais comum. E o próprio operador recria ONTs (12% das adições são de um serial removido antes).
- **O que muda:** separar as operações. VLAN: `undo service-port` + novo SP. Perfil: `ont modify <P> <ID> ont-lineprofile-id …`. Descrição: `ont modify … desc`. Recriar só na troca de serial ou de PON.

### A7. Leitura assume 1 service-port por ONT — média, P
- **Evidência:** 98,6% das ONTs têm 1 SP, mas **40 de 124 OLTs** têm ONTs com 2–5 SPs (1.493 ONTs: 895 com GEMs diferentes, ou seja, multisserviço como internet + IPTV/VoIP/gerência; 598 com o mesmo GEM e user-vlans diferentes). 49 OLTs têm ONTs sem SP (276).
- **O que muda:** `_read` devolve `service_vlan=None` quando há mais de um SP, e `onu_applied` nunca fica verdadeiro. Resultado: divergência permanente e, com A6, recriação em laço da ONT de um cliente IPTV. Identificar o SP "da intenção" pelo par (GEM, user-vlan) do perfil e relatar os demais em `extra` sem tocar neles. A desautorização deve continuar removendo todos. Teste no emulador: ONT com 2 SPs.

### A8. VLAN de serviço digitada à mão; 66% das OLTs têm regra por PON — média, M
- **Evidência:** 57 OLTs com VLAN por PON e 60 mistas (mediana de 1 VLAN por PON). A fórmula é `base + slot×16 + porta` (43 OLTs) ou `base(slot) + porta` (39). Em 90 de 124 OLTs a VLAN fica determinada por (PON, perfil, user-vlan) em ≥ 80% das ONTs. VLANs de saída distintas por OLT: p50 = 25, máx = 255. Só 5 OLTs usam VLAN única.
- **O que muda:** formulário de autorização (`apps/web/features/network/onus.tsx`, campos livres `line_profile`/`service_profile`/`service_vlan`) e `createONU` (`olt.go`). Ter por OLT um **mapa PON→VLAN** (aprendido dos SPs existentes na adoção ou definido por fórmula) e um **perfil padrão** (o mais usado cobre 92,9% das ONTs na mediana). O formulário vem preenchido e o operador só confirma. Validar que a VLAN existe na OLT antes de enfileirar.

### A9. Perfis: catálogo vindo da OLT, por ID e nome — média, M
- **Evidência:** 63% das ONTs usam perfis com nome padrão Huawei (`line-profile_N`), em que o operador pensa no ID. Por OLT há p50 = 6 perfis de linha definidos e só 3 usados (até 104 definidos e 80 sem uso). 44 ONTs usam nome com espaço, reprovado pela regex da API.
- **O que muda:** descobrir os perfis (`display ont-lineprofile gpon all`, `display ont-srvprofile gpon all`, com GEM/VLAN/portas de cada um), guardar como catálogo por OLT e oferecer uma lista (ID + nome + GEM/VLAN). Esse catálogo alimenta A1/A2/A3/A8. O emulador lista os perfis.

### A10. Rate limit fica no BNG, não na OLT — baixa (confirmação), sem esforço
- **Evidência:** tabela de tráfego em 1,7% dos SPs (18 OLTs); DBA type4 max=1024000 (≈1 Gbps) em 86% das ONTs; type1/2/3 em < 2%.
- **O que muda:** nada no driver. Não acrescentar `traffic-table` nem DBA por plano: a velocidade continua no RADIUS/BNG. Registrar em `docs/DECISOES.md`.

### A11. TR-069 pela OLT é minoria relevante; roteador por OMCI é raro — baixa/média, P–M
- **Evidência:** `ont tr069-server-config … profile-id N` em 16.878 ONTs (13%) de 15 OLTs (12%), cobrindo p50 = 95% das ONTs dessas OLTs. 18 OLTs têm perfil ACS, todos `http://…:7547`. PPPoE na ONU por OMCI (`ont ipconfig … pppoe`) em 381 ONTs (0,3%, 7 OLTs); `wan-config`/`internet-config` em 379; Wi-Fi/VoIP por OMCI em 0.
- **O que muda:** não implementar modo roteador por OMCI (fora do escopo, como hoje). Acrescentar um opcional por OLT, `tr069_profile_id`: na autorização roda `ont tr069-server-config <P> <ID> profile-id <N>`, para que a ONU chegue ao GenieACS sem DHCP opção 43. Isso complementa os templates ACS (`acs_templates.go`, `/rede/ftth/acs-template`). Observação de segurança: em 7 OLTs a senha PPPoE do cliente fica gravada na configuração da OLT.

### A12. Emulador: casos que a base real mostra e o emulador não cobre — média, M
1. **PON cheia:** 4 PONs têm 128 ONTs e o maior ID visto é 127. Hoje `ont add` no emulador lança `StopIteration` (`next(i for i in range(128) …)`, linha 108) em vez de responder com `Failure`.
2. **GEM/user-vlan por perfil** (A1/A2) e `Failure` para GEM inexistente.
3. **`ont port native-vlan`** (A3).
4. **Índices de service-port com buracos:** a OLT escolhe o índice; p50 de 45% de índices livres; máx 17.764. Hoje o emulador começa em 10 e só cresce.
5. **ONT com 2+ SPs e ONT sem SP** (A7).
6. **Descrição com espaço, `@`, `-` e até 64 caracteres**, e ONT preexistente com descrição de operador (A4/adoção).
7. **Saída de firmware MA5600 V800R015/R017/R018** (47% das OLTs; controladoras SCUN/MCUD1/SCUK). O emulador só imita MA5800 V100R019.
8. **Leituras agregadas `… all`** com ~2.000 ONTs (A5).
9. `ont autofind` com várias ONUs na mesma PON e PONs com IDs que não começam em 0 (4,6%).

### A13. Autenticação, gerência e descoberta: o desenho atual está certo — baixa (confirmação)
- **Evidência:** sn-auth em 100% (LOID 0, senha 1 caso); OMCI 100%; `ont-auto-find enable` em 124 de 124 OLTs; `auto-add-policy` em 1. `tag-transform translate` + `multi-service` em 99,5%.
- **O que muda:** nada. Não investir em LOID/senha nem em autoadição. A descoberta por `display ont autofind all` está correta.

### A14. Suspensão pela OLT é rara — baixa (confirmação)
- **Evidência:** `ont deactivate` em 84 ONTs de 3 OLTs.
- **O que muda:** manter a suspensão via RADIUS. Não acrescentar bloqueio pela OLT.

### A15. Limiares ópticos não existem na OLT — baixa (confirmação)
- **Evidência:** 0 OLTs com perfil de alarme óptico de ONT; só limiares de CPU/memória/MAC (11). `xpon ont optical-ddm quick-query` aparece em 35.
- **O que muda:** a decisão de configurar limiares no NOC está certa. Sugerir padrões por classe óptica no NOC (sem gravar na OLT).

### A16. Práticas de gerência que o NOC pode verificar — baixa, P
- **Evidência:** NTP em só 19 OLTs (15%); telnet habilitado em 37 (30%); SNMP só v2c (113, v3 em 0); syslog em 69 (56%); TACACS em 20.
- **O que muda:** checklist de conformidade por equipamento em `noc.go`/telemetria ("sem NTP", "telnet ativo"). Monitoramento por SNMP v2c é viável, mas a falta de NTP torna pouco confiáveis os horários da OLT (autofind time, last up time). Preferir o horário da leitura do agente, como já se faz.

### A17. Dimensionamento do motor de provisionamento — média (dado de projeto)
- **Evidência:** 0,83 adições e 0,60 remoções por OLT-dia em média; p99 = 7; pico de 35 adições numa OLT num dia. Na frota de 120 OLTs são ~170 operações de ONU por dia. 23% das adições reusam um ONT-ID liberado no mesmo dia; ~33% das adições são trocas (remoção + adição na mesma PON e no mesmo dia).
- **O que muda:** a vazão do provisionamento não é gargalo (dezenas de operações por OLT por dia, no máximo). Quem pesa é a leitura periódica (A5). Os testes de carga do motor (`apps/api-go/internal/network`, fila de operações) podem usar 50 operações/OLT/dia com picos de 35 em sequência. O reuso de ID confirma que a identidade precisa ser **sempre o serial**, com readback por `by-sn` antes de cada `ont delete`/`undo service-port`, como já faz `deauthorize`. Nunca guardar (PON, ONT-ID) ou índice de SP como chave durável. Teste no emulador: remover a ONU A e autorizar a B na mesma PON; B recebe o ID de A, e uma desautorização atrasada de A não pode atingir B.


## 3. Ordem sugerida

1. A1 + A2 + A9 (ler o perfil da OLT e tirar dele GEM e user-vlan). Sem isso a autorização falha na maioria das OLTs reais.
2. A3 (native-vlan). Sem isso a ONU bridge autoriza, mas não passa tráfego.
3. A5 (leitura agregada), antes de ligar o agente em OLT com centenas de ONTs.
4. A4 (descrição composta + adoção), condição para migrar provedor existente.
5. A7, A6, A8, A12 (emulador), A11 (TR-069 opcional).

## 4. Limites deste estudo

- Os backups são a configuração salva: não mostram saídas de `display` (formato de autofind, info, optical), estado online nem potência. A homologação dessas saídas continua dependendo de equipamento real.
- A sintaxe que aparece é a da configuração gravada (`-id` nos perfis). O fato de o firmware aceitar `-name` no comando continua não verificado aqui.
- Não foi possível ver modelos de ONT (a configuração não guarda o equipment-id).
- A rotatividade mede só diferenças diárias entre backups: o que é criado e removido no mesmo dia não aparece.
