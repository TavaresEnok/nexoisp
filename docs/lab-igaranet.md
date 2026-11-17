# Laboratório IgaraNet (provedor simulado no PNETLab)

Provedor **de laboratório** criado no painel de avaliação (SaaS) para exercitar toda a parte técnica do NexoISP como se
estivesse em produção, sem equipamento físico. Montado em 16/11/2026. Pagamentos ficam de fora (não há gateway).

> Tudo aqui é fictício: os 30 assinantes, documentos, endereços e logins são inventados (`gerar_dados.py`, semente fixa).
> A OLT é um **emulador** da CLI Huawei MA5800 escrito por nós; o driver Huawei continua **não homologado** em equipamento real.

## Topologia (página `IgaraNet` do PNETLab)

```
 NexoISP (painel :18380)                  nuvem NAT do PNETLab 10.0.137.0/24 (host = 10.0.137.254)
  api  :18443 (canal mTLS dos agentes) ◄──────────── NEXO-AGENTE 10.0.137.4 (docker: agente do NexoISP)
  vpn  :51820 (WireGuard) ◄── túnel 10.250.0.3 ── IGARA-BRAS ether1 10.0.137.2 (MikroTik CHR 7.17, QEMU)
  radius (pela rede do túnel)                       │ ether2: servidor PPPoE "igaranet", pool 100.64.10.0/24
                                                    │ uplink
                                       OLT-HUAWEI-MA5800 eth1 ═ ponte ═ eth2   (docker; gerência eth3 10.0.137.3, SSH)
                                                    │ PON 0/1/0 (clientes 1–16) e 0/1/1 (17–30)
                                       CLIENTES-30-ONUS (docker: 30 roteadores com pppd, MAC 02:1a:2b:00:00:NN)
```

- O tráfego PPPoE dos clientes **atravessa** o nó da OLT. Uma regra de ponte (nftables) só deixa passar o MAC de um
  cliente quando a ONU dele está **autorizada e online** no emulador. Assim, ONU não autorizada não navega e
  "reiniciar ONU" derruba de fato a sessão PPPoE durante o reinício (75 s).
- Os clientes 7, 18 e 25 têm atenuação alta de propósito (−27,4 / −28,9 / −26,1 dBm). O limiar do NOC é −25 dBm.
- O MikroTik autentica no **RADIUS integrado** pelo túnel WireGuard, com os comandos gerados pelo próprio painel.

## Como subir (do zero)

```bash
cd infra/lab-igaranet
python3 provisionar.py base       # provedor, módulos, usuários, agente, POP, OLT, concentrador + túnel, planos, limiar do NOC
./igaranet.sh imagens             # imagens dos nós (token/certificado do agente embutidos só na imagem local)
./igaranet.sh lab                 # instala /opt/unetlab/labs/IgaraNet.unl
./igaranet.sh iniciar             # cria a sessão do lab (como a interface web do PNETLab faz) e liga os 4 nós
python3 chr_config.py             # MikroTik: IP de gerência, túnel, RADIUS e servidor PPPoE (pelo console 30181)
python3 provisionar.py clientes   # 30 assinantes: cadastro, contrato, POP, coordenadas e PPPoE
python3 provisionar.py onus       # vincula as 30 ONUs; o agente as autoriza na OLT por SSH
./igaranet.sh clientes            # deve mostrar 30/30 com sessão PPPoE ativa
```

Depois de reiniciar o servidor: `./igaranet.sh iniciar` (recria os serviços do painel se a porta do canal dos agentes
não estiver escutando e religa a placa do MikroTik à ponte do uplink, se preciso). O estado da OLT e o do agente ficam
nos volumes `igaranet-olt-state` e `igaranet-agente-data` e sobrevivem a `./igaranet.sh limpar`.

Segredos e progresso ficam fora do git, em `~/.local/share/nexoisp/igaranet/` (`estado.json`, `acesso.txt`, `build/`).
O acesso do dono ao provedor está em `acesso.txt` (`gestor@igaranet.lab`; MFA configurado no primeiro acesso).

## Dados de provedor em operação (`povoar.py`)

Depois da subida, `python3 infra/lab-igaranet/povoar.py` completa o IgaraNet para o painel parecer o de um provedor real
(tudo fictício, tudo pela API do painel, etapas retomáveis):

| Etapa | O que cria |
|---|---|
| `assinantes` | nascimento, RG, nome da mãe, WhatsApp/e-mail de cobrança/telefone fixo, observações, endereço de instalação com referência |
| `configuracao` | equipe (NOC, atendimento, financeiro, 2 técnicos; senha `Igara#Lab2026`), etiquetas, catálogos de atendimento/OS, blocos de IP (CGNAT, público de documentação, gerência), município ANATEL (IBGE 2606804), régua de bloqueio e aviso de manutenção |
| `comercial` | empresa (razão social e CNPJ fictícios), planos FTTH com fidelidade de 12 meses, multa 2% + juros 1%, vencimentos variados e fidelidade nos contratos |
| `rede` | modelos e template de ONU, CEO no POP, 12 CTOs 1:8 (uma por bairro e PON), cabos com traçado e fusão, drop de cada cliente na CTO |
| `estoque` | depósitos, fornecedores, itens, compras (uma recebida, com contas a pagar), 40 ONUs com série (30 em comodato) |
| `operacao` | SLAs, kit de instalação, 30 OS de instalação concluídas (checklist, materiais, ONU em comodato), contrato em PDF e anotação por cliente |
| `atendimento` / `crm` | chamados abertos, aguardando e encerrados; OS de reparo agendada, em rota e concluída; 6 prospectos no funil |
| `financeiro` | mensalidades de 12/2025 a 11/2026 geradas pelo faturamento (gateway `none`), baixas manuais com PIX/boleto/loja, alguns pagamentos atrasados e 4 clientes inadimplentes |
| `extras` | produtos adicionais (alguns contratados), modelos de aviso, token de API e duas OS na agenda do dia |

Datas históricas: a API não permite cadastrar no passado. Só para este provedor de laboratório, `povoar.py` e os
comandos registrados aqui ajustam direto no banco `start_date`/`created_at` de contratos e assinantes (cliente desde
2023–2026), datas das OS de instalação e `created_at` das mensalidades. Nada disso é feito em provedor real.

Ficam vazios por dependerem de serviço externo: cobrança emitida (boleto/PIX: sem gateway), envio de avisos ao
assinante (sem canal WhatsApp/SMS/e-mail), TR-069 do roteador e respostas de pesquisa de satisfação (portal do assinante).

## O que foi validado ao vivo (16/11/2026)

| Funcionalidade | Resultado |
|---|---|
| Autorização das 30 ONUs pela OLT (operação assinada → agente → SSH → `ont add`/`service-port`) | 30/30 autorizadas; ponte da PON liberou 30/30 |
| PPPoE dos 30 clientes autenticando no RADIUS integrado pelo túnel | 30/30 online (pool 100.64.10.0/24), velocidade do plano por `Mikrotik-Rate-Limit` |
| Sinal óptico (RX/TX) por ONU, média por PON e alerta de sinal fraco no NOC | Leitura periódica do agente; clientes com atenuação alta aparecem em `onu_weak` |
| **Reiniciar ONU** pela API e pela tela (botão novo) | `ont reset` + confirmação `(y/n)`; ONU offline com causa "ONT reset"; sessão PPPoE caiu em ~40 s e voltou sozinha após a ONU religar |
| Desconectar sessão (Disconnect-Request RFC 5176) | MikroTik respondeu ACK e derrubou a sessão em ~6 s |
| Suspender / reativar acesso | Suspenso: RADIUS recusa ("authentication failed"); reativado: cliente voltou a navegar |
| Sessões e consumo (accounting), "Online agora", mapa com 30 contratos em Igarassu | Visíveis no painel |
| Backup da configuração da OLT | Registrado (8 KB) |
| Recriação dos nós Docker | Estado da OLT e do agente preservados; 30/30 de volta sem intervenção |

Não coberto: cobrança/pagamentos (sem gateway), TR-069 do roteador do cliente (perfil `acs` não está no painel),
IPv6 nas sessões e homologação em OLT física.

## Verificar pela interface

`tour.mjs` entra no painel como a conta de automação (TOTP calculado do segredo em `estado.json`) e captura telas.
A imagem `nexo-fase1-playwright:local` e as dependências de `e2e/node_modules` são reaproveitadas:

```bash
S=~/.local/share/nexoisp/igaranet; python3 -c "import json;s=json.load(open('$S/estado.json'));print(f\"EMAIL=automacao@igaranet.lab\nSENHA={s['senha_automacao']}\nTOTP={s['mfa_automacao']}\")" > $S/tour.env
sudo docker run --rm --network host --ipc=host --security-opt seccomp=unconfined --env-file $S/tour.env \
  -e ROTAS="mapa=/rede/mapa,online=/rede/online,onus=/rede/onus,olts=/rede/olts" \
  -v "$PWD/e2e:/e2e" -v "$PWD/infra/lab-igaranet/tour.mjs:/e2e/tour.mjs:ro" -v /tmp:/out -w /e2e nexo-fase1-playwright:local node tour.mjs
```

## Comandos úteis dentro dos nós

- Clientes: `./igaranet.sh clientes`, ou no console do nó `clientes status | clientes log 7 | clientes reiniciar 7`.
- MikroTik: `python3 ../lab-pnetlab/ros_console.py 30181 '/ppp active print count-only'`.
- OLT: `sudo docker logs <container da OLT>` mostra quantas ONUs têm tráfego liberado; o estado fica em `/state/olt-state.json`.
