# NexoISP × SGP — comparativo de funcionalidades

**Criado em:** 13 de outubro de 2026
**Fonte:** `docs/API-SGP-completa.txt` (documentação da API do SGP, cerca de 200 operações). O arquivo é material de terceiro e ficou **só como cópia local, não versionada**.
**Lado NexoISP:** inventário de rotas, migrações e drivers do `main` (`d486071`), conferido no código, não só nos documentos.

## 1. O que este comparativo mostra e o que não mostra

A documentação de API mostra **o que o SGP expõe por integração**. Ela não mostra telas, relatórios, BI, comissões, regras internas nem o desempenho.
Portanto: tudo o que está aqui como "o SGP tem" é confirmado; a ausência de algo aqui **não** prova que o SGP não o tenha.

Marcas usadas na coluna "NexoISP":

| Marca | Significado |
|---|---|
| ✅ | Existe e está testado (no nível de maturidade de `docs/05`: simulado ou validado em cenário virtual). **Novo** marca o que foi implementado depois deste comparativo (13/10/2026), ver a seção 7 |
| 🟡 | Existe em parte; a coluna "Lacuna" diz o que falta |
| ❌ | Não existe |

## 2. Dois achados que mudam prioridades

### 2.1 O SGP provavelmente é a origem da migração, não o MK-Auth

Nos concentradores do cenário do PNETLab, dois dos três provedores (`FOX-AUT` e `WORLD-MK4011`) têm perfis PPP com prefixo `SGP-` (`SGP-PLANO-ID<n>`, `SGP-BLOQUEADOS`)
e perfil `VPN-SGP`: eles são atendidos por um SGP hoje. O pedido original de ter "um servidor de autenticação tipo SGP para os 3 provedores" aponta o mesmo caminho.

- A API do SGP permite exportar clientes, contratos, títulos, serviços e sessões; é um caminho de migração mais rico que um CSV do MK-Auth.
- **Não verifiquei** se a API devolve a senha PPPoE de cada serviço em claro. Sem ela, a migração obriga o assinante a trocar a senha ou o provedor a exportá-la de outro lugar. Isso decide a viabilidade do corte e precisa de uma amostra real.
- O CSV intermediário de `docs/importacao-csv.md` serve de destino, mas hoje não tem mapeamento para o formato do SGP.

### 2.2 O SGP não suspende negando a autenticação

Os perfis `SGP-BLOQUEADOS` do cenário usam `rate-limit=1k/1k` e um pool próprio de endereços (`bloqueados`): o cliente **conecta**, cai num endereço de bloqueio
e vê uma página de aviso (a captura é feita no roteador). Nosso motor só implementa `Auth-Type := Reject` ("modalidade de demonstração", `apps/api/src/network/engine.ts:12`).

- Um provedor que hoje usa o perfil de bloqueio **perde a página de aviso** se migrar com a suspensão por rejeição.
- A modalidade por perfil de bloqueio é pequena no motor (outro `Mikrotik-Group` e, opcionalmente, `Framed-Pool`) e já está listada em `docs/lab-pppoe.md` como pendência do driver.
- O SGP ainda tem **Ativo com velocidade reduzida** como status de contrato (item 7 da lista), que é o mesmo mecanismo com outro perfil.

## 3. Comparativo por área

### 3.1 Cadastro e contrato

| Função do SGP | NexoISP | Lacuna |
|---|---|---|
| Cliente PF, PJ e estrangeiro; RG, nascimento, estado civil, filiação, profissão | 🟡 **Novo** | RG, órgão emissor, nascimento, nome da mãe e nome fantasia. Faltam estado civil, profissão e estrangeiro |
| Pré-cadastro (PF/PJ) com plano, vencimento, vendedor, instalação, fidelidade | 🟡 | CRM tem prospecto e conversão, sem vendedor, fidelidade nem parcelas de instalação |
| Documentos anexos do cliente | ❌ | |
| Observações de cliente e de contrato; anotações com histórico | 🟡 | Há notas em OS e chamado, não no cadastro |
| Etiquetas (tags) no contrato | ✅ **Novo** | Cadastro, edição no contrato e filtro na lista |
| Contratos unificados (vários contratos num cliente/título) | ❌ | |
| Status do contrato: Ativo, Inativo, Cancelado, Suspenso, Inviabilidade técnica, Novo, Ativo V. Reduzida, com **motivo** | 🟡 | Só `active`/`ended`; suspensão é política de acesso, sem motivo cadastrado |
| Vários serviços por contrato: Internet, TV, Telefonia, Multimídia, Genérico | 🟡 | Um acesso PPPoE por contrato |
| Alterar MAC, login, senha, endereço, serial e CPE do serviço | 🟡 **Novo** | Senha, IP fixo e **MAC (vínculo no RADIUS)**. Login, serial e CPE não |
| POP, NAS, AP, Fonte, Switch como inventário | 🟡 | Só equipamentos de rede; sem POP |
| Condomínio no endereço; latitude/longitude | ❌ | |
| Termo de aceite do contrato (exibir e aceitar) e impressão do contrato | ❌ | |
| Viabilidade técnica por endereço | ❌ | |
| Feriados (para vencimento) | ❌ | |

### 3.2 Financeiro

| Função do SGP | NexoISP | Lacuna |
|---|---|---|
| Gerar mensalidade (por contrato, ano e mês) e título avulso | ✅ | |
| Mensalidade proporcional no primeiro mês | ✅ **Novo** | Opcional por provedor |
| Listar título com filtros por vencimento, pagamento, cancelamento, acordo | 🟡 | Filtros menores; sem data de acordo |
| Cancelar e **descancelar** título | 🟡 | Cancela; não reabre |
| Liquidar manualmente, com forma de pagamento, tarifa e ponto de recebimento | 🟡 | Baixa manual com meio de pagamento, desconto e multa/juros. Sem tarifa nem caixa |
| **Liquidação parcial** com desconto e motivo | ✅ **Novo** | |
| **Estorno** de baixa | ✅ **Novo** | Só de baixa manual; a do gateway volta pelo gateway |
| **Acordo de pagamento** (renegociação em parcelas, com entrada) | 🟡 **Novo** | Parcelas e desconto; sem entrada separada |
| **Liberação por confiança / promessa de pagamento** | ✅ **Novo** | Equipe e portal; prazo e intervalo por provedor |
| Juros e multa por atraso | 🟡 **Novo** | Só na baixa manual e no acordo; cobrança do gateway não muda de valor |
| Forma de cobrança do contrato: boleto, débito, carnê, recorrente, PIX | 🟡 | Depende do gateway (pendente, 0.2) |
| Portador (conta bancária emissora), remessa e retorno CNAB240/400 | ❌ | Só se o provedor emitir boleto próprio; com gateway não é necessário |
| PIX por fatura; envio da fatura | 🟡 | Via gateway de demonstração |
| Cartão de crédito/débito e cobrança recorrente por cartão (cadastrar e remover cartão) | ❌ | Depende do gateway |
| Conciliação | ✅ | |
| Contas a pagar e a receber, plano de contas, tipos de documento, caixa por ponto de recebimento | ❌ | Back-office; decisão de escopo |
| Exportação contábil | ✅ | CSV; não é documento fiscal |
| NF-e e NFS-e (listar, importar, emitir) | ❌ | Item 3.1 de `docs/05` |
| Consulta de proteção de crédito (Serasa) | ❌ | |

### 3.3 Rede e acesso

| Função do SGP | NexoISP | Lacuna |
|---|---|---|
| Autenticação PPPoE por RADIUS | ✅ | FreeRADIUS local, validado em CHR |
| Outros tipos de conexão: IPoE, DHCP, Hotspot MikroTik, IP estático, switch | ❌ | Só PPPoE |
| Suspender negando acesso | ✅ | |
| **Suspender por perfil de bloqueio / velocidade reduzida** | ✅ **Novo** | Validado no CHR do cenário; a página de aviso e o redirecionamento são do concentrador |
| IP fixo | ✅ | |
| Sessões online, última sessão, filtros por NAS, POP, OLT, PON | 🟡 | Sessão por contrato e NOC; sem filtro por POP/PON |
| Tráfego e **extrato de uso** por mês, na central | ✅ **Novo** | Totais mensais do accounting local; sem consulta por período e sem gráfico |
| Consulta de respostas do RADIUS e log | ❌ | |
| **Manutenção programada** com mensagem ao assinante (central, URA, SMS) por POP, NAS, OLT, PON ou CTO | 🟡 **Novo** | Aviso no portal, para todos ou por NAS. Sem SMS/URA, sem POP/PON/CTO |
| Mais de um NAS e de um RADIUS | 🟡 | Modelo permite; só exercitado com um NAS |
| IPAM e CGNAT | ✅ | Gera script; não aplica |

### 3.4 OLT, ONU e FTTH

| Função do SGP | NexoISP | Lacuna |
|---|---|---|
| Listar OLT, PON, ONU por OLT, ONUs não autorizadas | ✅ | Só Huawei, sem homologação em equipamento |
| Autorizar ONU com **template**, tipo de ONU, modo (bridge, PPPoE, bridge WAN, DHCP), VLAN | 🟡 | Perfil e VLAN digitados; sem template nem modo |
| Configurar Wi-Fi e credenciais PPPoE na ONU pela autorização | ❌ | Fora do escopo declarado em `docs/expansao-olt-onu.md` |
| Resetar, remover, exportar, histórico da ONU | 🟡 | Remove e lê; sem reset nem histórico |
| CTO e splitter com portas, ONUs por CTO | ✅ | Mapa esquemático |
| **Vários fabricantes de OLT** | ❌ | Um driver (Huawei) |
| **CPE Manager** (TR-069): ping, speed test, reboot, Wi-Fi (SSID, senha, canal), WAN, sincronizar | ❌ | Fora do escopo; exige um servidor de gerência de CPE |

### 3.5 Atendimento, campo e estoque

| Função do SGP | NexoISP | Lacuna |
|---|---|---|
| Chamados e ocorrências com tipo, método, setor, classificação | 🟡 | Chamado e atendimento existem; sem catálogo de tipos, métodos e setores |
| Chamado com anexo e áudio | ❌ | |
| Ordem de serviço: status, técnico, anotações e comentários | ✅ | |
| OS com **checklist**, **imagens** (com descrição) e botão **"a caminho"** | 🟡 **Novo** | Só o checklist. Fotos exigem armazenamento de arquivos e decisão de LGPD; "a caminho" depende de mensagem ao assinante |
| Técnicos e agenda | 🟡 | Equipe existe; sem agenda |
| Estoque: produto, categoria, fabricante, NCM, saldo por local, lançamento, estorno | 🟡 | Item, movimento, série e técnico; sem NCM nem fabricante |
| Fornecedor, **compra** e **importação de NF-e de compra** | ❌ | |
| **Comodato** (equipamento emprestado ao cliente) e venda de equipamento | ✅ **Novo** | Modalidade na instalação pela OS e lista de recolhimento no contrato encerrado |
| Kit de instalação (produtos que saem juntos na OS) | ❌ | |
| Transferência entre locais | ✅ | Almoxarifado e técnico |

### 3.6 Canais e integração

| Função do SGP | NexoISP | Lacuna |
|---|---|---|
| Central do Assinante: contratos, faturas, 2ª via, PIX, chamado | ✅ | Portal do assinante |
| Central: promessa de pagamento, extrato de uso, cartão, termo de aceite | 🟡 **Novo** | Promessa e extrato sim; cartão e termo de aceite não |
| SMS (vários gateways) e envio por contrato | ❌ | Item 2.5 de `docs/05`; hoje só aviso ao provedor por webhook |
| URA telefônica (consulta, 2ª via, chamado, áudio) | ❌ | |
| **API pública** com token por aplicação, ou usuário e senha | ❌ | A API é interna, de sessão por cookie |
| Notificação no sistema para o operador | 🟡 | Avisos por webhook; sem notificação interna |

## 4. O que o NexoISP tem e esta documentação não mostra no SGP

Sem afirmar que o SGP não tenha: a documentação de API não expõe nada equivalente a estes pontos do NexoISP.

- Operação de rede **versionada e assinada**, com obsolescência (suspensão antiga não executa depois do pagamento) e verificação por leitura antes de repetir.
- **Divergência** entre o desejado e o encontrado no equipamento, sem correção automática.
- **Autenticação local** que continua com a nuvem e o agente parados.
- Isolamento por provedor garantido no banco, auditoria e módulos liberados por provedor.
- Diagnóstico do NOC por regras com evidência.

## 5. O que fazer com isto (proposta de 13/10/2026; o que foi feito está na seção 7)

Mantendo a regra do plano de sete dias (fechar o núcleo, sem módulo novo), a proposta é separar assim.

### 5.1 Entra no núcleo, antes do primeiro corte

Pequeno, e destrava a migração de um provedor que hoje usa SGP:

1. **Suspensão por perfil de bloqueio** (ver 2.2), como modalidade configurável por provedor, ao lado da rejeição. Exige validação no cenário do PNETLab e a política comercial (item 0.5).
2. **Amostra de exportação do SGP** (clientes, contratos, serviços e títulos) para mapear no CSV intermediário e responder a pergunta da senha PPPoE (ver 2.1).

### 5.2 Depois do primeiro grupo em produção, conforme a dor aparecer

Todos dependem de regra comercial do provedor, não de técnica nova:

- liberação por confiança / promessa de pagamento (é o que mais pesa no dia a dia: sem ela, o atendente religa à mão);
- liquidação parcial, estorno, juros e multa, acordo de pagamento;
- mensalidade proporcional;
- MAC do serviço e etiquetas de contrato;
- extrato de uso na central e manutenção programada com aviso ao assinante;
- comodato e checklist/fotos da OS.

### 5.3 Exige decisão sua antes de qualquer código

| Tema | Por que é decisão |
|---|---|
| Contas a pagar, plano de contas e caixa | É outro produto (back-office); o escopo atual é cobrança do assinante |
| Emissão fiscal (NFCom/NFS-e/SCM) | Item 3.1 de `docs/05`; depende do provedor e do emissor |
| TR-069 / CPE Manager | Precisa de um servidor de gerência de CPE e dos modelos do provedor |
| Outros tipos de conexão (IPoE, hotspot, DHCP) | Muda o motor de acesso; só vale se o piloto usar |
| API pública com token | Superfície nova de segurança; vale se terceiros do provedor (bot, URA) dependerem dela |
| Segundo fabricante de OLT | Item 3.2 de `docs/05`; precisa de um equipamento para homologar |
| Remessa/retorno CNAB | Só se o provedor emitir boleto próprio em vez de gateway |

## 6. Cuidados com a fonte

- O arquivo do SGP está em `docs/API-SGP-completa.txt` **sem commit**, por ser material de terceiro e o repositório ser público. Este comparativo só o resume.
- Nomes de perfis e de parâmetros citados aqui são os genéricos do produto; nada de assinantes, endereços, tokens ou configuração de provedor entra neste documento.

## 7. O que foi implementado depois deste comparativo (13/10/2026)

Classificação: **implementado** (código e testes automáticos), **validado no cenário** (repetido no CHR 7.17 do PNETLab) e **homologado em equipamento físico** (nenhum).

| Recurso | Implementado | Validado no cenário | Observação |
|---|---|---|---|
| Suspensão por perfil de bloqueio | sim | sim (rede real: reconexão no pool de bloqueio, fila 1k/1k) | Agente 0.4.0. Redirecionamento para a página de aviso não foi exercitado |
| Vínculo de MAC | sim | sim (MAC errado recusado, certo autenticado) | Agente 0.4.0 |
| Consumo mensal | sim | sim (valores conferidos com o `radacct`) | Agente 0.4.0; mês em UTC |
| Liberação por confiança (equipe e portal) | sim | só as operações de rede por baixo (suspender/reativar) | |
| Baixa parcial, desconto, estorno, multa e juros | sim | não se aplica (financeiro) | Só baixa manual; gateway real continua pendente |
| Acordo de pagamento | sim | não se aplica | Sem entrada separada |
| Primeiro mês proporcional | sim | não se aplica | |
| Dados da pessoa, etiquetas | sim | não se aplica | |
| Aviso de manutenção no portal | sim | não se aplica | Não envia SMS/e-mail |
| Checklist da OS, comodato | sim | não se aplica | |

**Ficou de fora, por decisão de escopo ou por depender de terceiro** (nada disso foi simulado):

- **Contas a pagar, plano de contas e caixa:** é outro produto (back-office); o escopo é a cobrança do assinante.
- **Emissão fiscal (NFCom, NFS-e, SCM):** depende do emissor e do município do provedor.
- **TR-069 / CPE Manager, outros tipos de conexão (IPoE, hotspot, DHCP), segundo fabricante de OLT, remessa/retorno CNAB:** exigem equipamento ou serviço de terceiro para homologar; ver a seção 5.3.
- **API pública com token, SMS e URA:** superfície nova de segurança e serviço de envio de terceiro.
- **Cartão de crédito, proteção de crédito (Serasa), termo de aceite, viabilidade técnica, feriados, documentos anexos, contratos unificados, vários serviços por contrato:**
  não implementados nesta rodada.
- **Fotos na OS:** exigem armazenamento de arquivos e decisão de LGPD.
