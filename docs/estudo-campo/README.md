# Estudo de campo: configurações reais de provedores (10/11/2026)

## O que é

Lemos os backups diários de configuração de cerca de 2.278 equipamentos de 132 provedores, guardados no backup center da Ajust Consulting. São equipamentos de terceiros. **Nada foi importado nem copiado para fora do servidor.** A leitura foi só de configuração, e os relatórios trazem apenas contagens e formas normalizadas dos comandos, sem nomes, números de série, IPs ou senhas.

Base efetiva, depois de descartar pastas vazias e backups duplicados:

| Tipo | Equipamentos lidos | Volume |
|---|---|---|
| OLT Huawei | 124 | 129.938 ONUs |
| OLTs de outros fabricantes | 64 com backup | ZTE 13,6 mil · FiberHome 10,2 mil · Datacom 4,6 mil · VSOL 3,3 mil · Intelbras 2,6 mil · Parks 1,2 mil ONUs |
| MikroTik | 197 (102 concentradores PPPoE) | 20.588 contas PPPoE locais |
| Roteadores Huawei | 52 (41 concentradores PPPoE) | — |
| CGNAT | 9 Hillstone, 3 A10, 50 MikroTik com CGNAT | — |
| Switches | 70 Huawei, 24 Datacom e outros | — |

Relatórios completos, cada achado com evidência, arquivo afetado, prioridade e esforço:

- [olt-huawei.md](olt-huawei.md)
- [olts-outros-fabricantes.md](olts-outros-fabricantes.md)
- [mikrotik.md](mikrotik.md)
- [cgnat-roteadores-switches.md](cgnat-roteadores-switches.md)

Limite: os backups só têm configuração. O formato das saídas de `display`/`show` (descoberta, estado, sinal) continua dependendo de equipamento real.

## O que o NexoISP assumia errado (conferido no código)

1. **Consulta de IP para ofício com CGNAT.** `CGNATReverse` (`apps/api-go/internal/network/cgnat.go`) calcula o assinante por fórmula sequencial. Só acerta se o CGNAT foi montado pelo script do próprio NexoISP. Os provedores estudados usam Hillstone com blocos alocados sob demanda, A10 com deslocamento aleatório ou netmap no MikroTik. Para eles, a resposta sai errada com aparência de certa, e a tela não avisa.
2. **Driver de OLT Huawei.**
   - **Gemport padrão:** o padrão 1 só aparece em 9,4% dos service-ports. O gemport e a VLAN do cliente vêm do perfil de linha (99,3%).
   - **`native-vlan`:** falta `ont port native-vlan`, presente em 90% das ONUs. Sem ele, a ONU em bridge não passa tráfego.
   - **Descrição:** a regra de descrição recusa 76,6% das descrições reais.
   - **Leitura periódica:** consulta ONU por ONU e não escala para a mediana de 724 ONUs por OLT.
3. **Agente MikroTik.** Só conecta por `api-ssl` com CA, o que nenhum dos 197 equipamentos tem.
4. **Suspensão.** O mercado bloqueia por lista de endereços vinda do RADIUS (MikroTik) ou por pool de bloqueio (Huawei), com redirecionamento à página de aviso. No PPPoE, o NexoISP só rejeita o login ou troca o perfil.

## O que já estava certo

- RADIUS com senha em claro (91% dos concentradores aceitam PAP).
- Interim de 5 minutos e desconexão por DM na porta 3799.
- Velocidade enviada pelo RADIUS.
- Um serviço por ONU (mais de 97%).
- Autenticação por serial (100% nas Huawei).
- Tolerância a RouterOS 6 pela API.

## Situação (10/11/2026)

Grupo A feito, exceto a descrição legível e a adoção de ONUs existentes, que dependem de comando validado em OLT real (ver `docs/DECISOES.md`). Feito: layout e última porta do CGNAT, aviso e recusa de cálculo para CGNAT externo, IPv6 pelo accounting, gemport e VLAN do cliente por perfil, native-vlan, leitura com várias service-ports e leitura em lote que isola a ONU com resposta inesperada.

## Prioridades propostas

**A. Corrigir o que daria resultado errado**

1. **Consulta de ofício:**
   - informar a origem de cada plano de CGNAT;
   - bloquear ou avisar quando não houver como rastrear;
   - incluir o fim da faixa de portas;
   - usar o prefixo IPv6 do accounting.
2. **Driver Huawei:**
   - gemport e VLAN do cliente lidos do perfil de linha;
   - `native-vlan`;
   - descrição legível com marcador de controle;
   - leitura por PON;
   - várias service-ports por ONU;
   - emulador com PON cheia.

**B. Fazer funcionar nos equipamentos como estão**

3. **Agente MikroTik:** certificado fixado por impressão digital e assistente de certificado, com modo só RADIUS e desconexão por CoA quando não houver API.
4. **Suspensão:** modo por lista de endereços (MikroTik) e por pool (Huawei), e modelo de bloqueio com sites liberados e masquerade do pool.

**C. Ajustes pequenos**

- interim padrão de 300 s;
- aceitar todos os formatos reais de rate-limit;
- alerta de relógio sem NTP;
- serial EPON por MAC;
- aviso na tela para o modo `nt_hash`;
- VLAN de serviço sugerida pela regra da PON;
- catálogo de perfis lido da OLT;
- perfil TR-069 por OLT.

**D. Depois, com equipamento**

- Drivers ZTE, VSOL, FiberHome, Intelbras e Datacom, nessa ordem de base instalada.
- Transporte CLI com telnet e SSH legado.
- CoA para troca de plano.
- Switches passivos no NOC.
