# Expansão 1 — OLT/ONU

Primeira expansão após o MVP (documento 04, seção 10). Limite adotado: **descoberta, autorização e leitura de estado**, um fabricante por vez.

**Situação em 10/10/2026:**

| Driver | Situação |
|---|---|
| `olt_demo` | OLT simulada. Fluxo completo validado. Só existe no modo demonstração |
| `olt_huawei` | **Primeiro fabricante: Huawei SmartAX (MA5600T/MA5608T/MA5800), CLI por SSH.** Implementado e testado **somente contra um emulador de CLI escrito por nós**. **Não homologado em equipamento real** |

## O que o sistema faz

| Função | Como funciona |
|---|---|
| Descoberta | O agente lê na OLT as ONUs presentes na fibra e ainda não autorizadas e relata a lista completa a cada ciclo (≈15 s). Aparecem em Rede → ONUs → "Aguardando autorização", com serial, porta PON e modelo |
| Autorização | O operador escolhe a ONU, o contrato, o perfil de linha e a VLAN de serviço. Vira uma operação assinada na mesma fila do PPPoE; o agente aplica, lê de volta e só então conclui |
| Leitura de estado | Autorizada ou não, online/offline e potência óptica (RX/TX), com a data da leitura. Visível na lista de ONUs e no contrato |
| Desautorização | Remove a ONU da OLT. Manual, com confirmação |
| Troca de ONU | Depois de desautorizada e confirmada como ausente, o contrato aceita outra ONU; o serial anterior fica no motivo da operação e na auditoria |
| Divergência | ONU removida ou alterada direto na OLT aparece como divergência; nada é corrigido sozinho ("Reaplicar" corrige) |

As garantias do motor do MVP valem para ONUs: intenção versionada, operação obsoleta não executa, efeito incerto é consultado antes de repetir,
resultado antigo não altera a intenção, isolamento entre provedores, evidência por etapa e auditoria. A versão da intenção é gravada na **descrição da ONU**
(`nexo:<id>:v<n>`), o que permite saber, lendo a OLT, qual operação produziu o estado.

## Demonstração

`admin@alfa.demo` → Rede → ONUs. A "OLT Demo (simulada)" traz quatro ONUs fictícias aguardando autorização.

```bash
./nexo demo-tool <id_da_olt> olt-plug DEMO12345678 0/3/7      # uma ONU nova aparece na fibra
./nexo demo-tool <id_da_olt> olt-manual-remove <serial>       # alguém remove direto na OLT -> divergência
./nexo demo-tool <id_da_olt> olt-lose-ack                     # próxima autorização perde a confirmação -> verificada por leitura
```

## Decisões e limites desta entrega

- **Perfil de linha e VLAN são digitados** na autorização e precisam já existir na OLT. O sistema não cria perfis, VLANs nem `service-port` genéricos:
  isso depende do fabricante e do desenho de rede do provedor.
- **Encerrar o contrato não remove a ONU automaticamente.** O painel avisa; a remoção é decisão do operador (regra comercial não definida).
- **Sem limiar de sinal:** o painel mostra os valores de RX/TX, mas não classifica como bom ou ruim (os limites dependem do equipamento e do projeto óptico).
- Uma ONU por contrato. Sem ONU em modo roteador/TR-069, sem Wi-Fi, sem VoIP, sem atualização de firmware.
- Sem IPAM/CGNAT (expansão 2) e sem inventário de rede óptica — caixas, splitters, portas (expansão 3).
- O driver `olt_demo` é bloqueado fora do modo demonstração. Em produção o único driver de OLT selecionável é o `olt_huawei`, marcado como não homologado.
- Perfil de serviço (`ont-srvprofile`) é um campo a mais na autorização, obrigatório na Huawei.

## Driver Huawei (`olt_huawei`)

Fabricante escolhido pelo proprietário; sem equipamento disponível para teste.

**Fontes dos comandos** (guias públicos de integradores, consultados em 10/10/2026 — não é a referência oficial da Huawei):
[Intelbras — provisionamento em OLT Huawei](https://guiasmanuais.intelbras.com.br/R1/res/pdf/HUAWEI.pdf),
[Splynx — Huawei GPON configuration](https://wiki.splynx.com/networking/huawei/config),
[ForoISP — comandos de diagnóstico de ONUs em OLT Huawei](https://foroisp.com/threads/1817-Comandos-de-Dianostico-de-Onus-en-OLT-Huawei).

| Função | Comandos usados |
|---|---|
| Conectividade | `display version` |
| Descoberta | `display ont autofind all` |
| Leitura | `display ont info by-sn <SN>`, `display service-port port <F/S/P> ont <ID>`, `interface gpon <F/S>` + `display ont optical-info <P> <ID>` |
| Autorização | `interface gpon <F/S>` + `ont add <P> sn-auth "<SN>" omci ont-lineprofile-name "<perfil>" ont-srvprofile-name "<perfil>" desc "<marcador>"`, depois `service-port vlan <V> gpon <F/S/P> ont <ID> gemport <G> multi-service user-vlan <V> tag-transform translate` |
| Desautorização | `undo service-port <INDEX>` (cada um) e então `ont delete <P> <ID>` |

O que está garantido pelo código e pelos testes: só esses comandos são enviados; todo valor é validado antes de entrar num comando (sem aspas, espaços ou
quebras de linha); resposta `Failure:` vira erro; autorização parcial (ONT criada sem `service-port`) é registrada como falha e a nova tentativa refaz por completo;
a sessão SSH é reaproveitada entre chamadas próximas e descartada após qualquer erro.

**O que NÃO está garantido** — só um equipamento real responde:

- O **formato exato das saídas** em cada versão de firmware (os interpretadores toleram variação de espaçamento, mas foram escritos sem uma saída real em mãos).
- A sintaxe aceita pelo firmware do provedor (`-name` x `-id` nos perfis; parâmetros de `service-port` como `tag-transform` e tabelas de tráfego).
- O comportamento do login/paginação/prompts interativos numa OLT real (hoje exercitado via netmiko `huawei_smartax` contra o emulador).
- Modo de operação diferente de ONU em bridge com uma VLAN e um `gemport` (padrão `gemport 1`, ajustável em `credentials.json`).

O emulador (`olt_huawei_emulator.py`, serviço `olt-huawei-emu` no ambiente de demonstração) imita a CLI a partir das mesmas fontes: **passar nele não é homologação**.
A interface mostra "não homologado em equipamento real" no equipamento e na autorização.

Roteiro de homologação quando houver uma OLT: (1) capturar a saída real de cada comando de leitura e comparar com os interpretadores; (2) repetir os casos de
`docs/lab-pppoe.md` adaptados — autorizar, ler sinal, desautorizar, trocar ONU, operação obsoleta, agente morto no meio, OLT inacessível, alteração manual;
(3) registrar modelo, firmware e resultado; (4) só então remover o rótulo.

## Para integrar outro fabricante

Informações indispensáveis:

1. Fabricante, modelo e versão de firmware.
2. Forma de acesso permitida: SSH/Telnet (CLI), SNMP ou API/NETCONF.
3. Como a rede usa a OLT hoje: nome dos perfis de linha/serviço, VLAN por PON ou única, modo bridge ou roteador, e um exemplo dos comandos que a equipe executa para autorizar uma ONU.
4. Uma OLT (ou emulador do fabricante) acessível pelo agente para homologar.

Trabalho previsto: um arquivo de driver em `services/network-agent/nexo_agent/drivers/` implementando o contrato de `olt_base.py`
(`check`, `discover`, `read_onu`, `authorize`, `deauthorize`), uma opção no cadastro de equipamento e um roteiro de laboratório como o do PPPoE.
O restante — fila, telas, auditoria, recuperação — já está pronto e não muda.

## Verificação

- API: ensaios nativos do backend Go — descoberta completa x parcial, isolamento, autorização, leitura, divergência, desautorização obsoleta, troca de ONU e permissões.
- Agente: `services/network-agent/tests/test_onu.py` (5 testes) — autorizar/ler/desautorizar, confirmação perdida, reinício no meio, mudança de VLAN, porta errada.
- Driver Huawei: `tests/test_olt_huawei.py` (5 testes, contra o emulador) — serial e interpretadores, ciclo completo, falhas da OLT, tentativa de injeção de comando, sessão reaproveitada, autorização parcial que converge.
- Caminho completo no ambiente rodando: painel → agente → SSH (netmiko) → emulador: descoberta, autorização (~3 s), sinal, e conferência direta na CLI.
- Ambiente rodando e interface: descoberta, autorização pela tela, sinal, ONU nova, remoção manual → divergência → reaplicar.
