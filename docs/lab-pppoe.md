# Roteiro de laboratório — PPPoE real (E3)

**Situação: EXECUTADO em laboratório virtual em 10/10/2026 — os 12 casos passaram.**
Ambiente: MikroTik CHR **RouterOS 7.24.5 (stable)** em QEMU/KVM, cliente PPPoE real (`pppd` 2.4.9), **FreeRADIUS 3.2.10**, autenticação CHAP.
Reproduzir: `./nexo lab-up` (com o painel de demonstração rodando) e seguir a seção 3; `./nexo lab-down` remove tudo.

O que isso comprova e o que não comprova:
- Comprova o ciclo completo contra um RouterOS real: provisionar, autenticar, aplicar perfil, suspender, reativar e os casos de falha.
- **Não** substitui a homologação no equipamento físico e na versão do provedor piloto (ADR-012), nem mede desempenho: a licença gratuita do CHR limita cada interface a 1 Mbps e o teste usou um único cliente.

## Topologia

```
[cliente PPPoE] --L2-- [MikroTik CHR v7: PPPoE server] --IP-- [host do site: radius + agent] --saída 8443--> [NexoISP]
```

## 1. Site (agente + RADIUS)

```bash
cd infra/site
cp .env.example .env            # NEXO_API_URL, NEXO_AGENT_TOKEN, RADIUS_NAS_SECRET, RADIUS_NAS_NET=<IP do CHR>/32
cp config/credentials.example.json config/credentials.json && chmod 600 config/credentials.json
# certificado do agente (dev): na raiz do projeto ->  ./nexo agent-cert <agent_id> infra/site/certs
docker compose up -d --build
```

No painel: Rede → Novo agente (guarde token/id) → Novo equipamento com integração "MikroTik + RADIUS",
endereço do CHR, porta 8729 e a referência da credencial (`mikrotik-principal`).

## 2. MikroTik CHR (RouterOS v7) — registrar a versão exata usada

```routeros
/ip pool add name=pool-clientes ranges=100.64.0.10-100.64.0.250
/ppp profile add name=plano-200m local-address=100.64.0.1 remote-address=pool-clientes rate-limit=100M/200M
/ppp profile add name=plano-500m local-address=100.64.0.1 remote-address=pool-clientes rate-limit=250M/500M
/ppp aaa set use-radius=yes accounting=yes interim-update=5m
/radius add service=ppp address=<IP do site> secret=<RADIUS_NAS_SECRET> timeout=3s
/interface pppoe-server server add service-name=nexo interface=<porta dos clientes> authentication=mschap2,chap disabled=no
# API para o agente: usuário restrito + api-ssl com certificado
/user group add name=nexo-agent policy=api,read,write
/user add name=nexo-agent group=nexo-agent password=<senha> address=<IP do site>
/certificate add name=api common-name=<IP ou nome do CHR>; /certificate sign api
/ip service set api-ssl certificate=api address=<IP do site>/32 disabled=no; /ip service set api disabled=yes
```

Exporte o certificado do CHR para `infra/site/config/routeros-ca.crt` (referenciado em `credentials.json`).
Os nomes dos perfis PPP devem ser iguais ao "Perfil de velocidade no NAS" dos planos.

## 3. Casos e resultado (10/10/2026, CHR 7.24.5)

Comandos úteis: `infra/lab/lab.sh client up <usuario> <senha>` · `client status` · `client down` · `lab.sh ros ppp/active`.

| # | Caso | Como foi feito | Resultado observado |
|---|---|---|---|
| 1 | Provisionar | Contrato → Provisionar acesso | ✅ Operação concluída; `radcheck`/`radreply` gravados; verificação por leitura |
| 2 | Autenticar | `pppd` disca no segmento dos assinantes | ✅ `CHAP authentication succeeded`; IP 100.64.0.250; `/ppp active` com `radius=true`; fila 100M/200M criada pelo perfil; ping ok; painel mostra sessão e IP |
| 3 | Suspender com cliente online | Botão Suspender | ✅ Autorização → Reject, sessão removida (`sessions_removed: 1`), verificação ok; cliente passa a receber `authentication failed` |
| 4 | Reativar | Botão Reativar | ✅ Concluída; cliente reconecta sozinho |
| 5 | Troca de plano | Trocar para Fibra 500 com sessão online | ✅ Novo `Mikrotik-Group`; sessão antiga derrubada; reconexão com fila 250M/500M |
| 6 | Nuvem indisponível | API parada; cliente reconecta | ✅ Autentica pelo RADIUS local |
| 7 | Agente parado | Agente e API parados; cliente reconecta | ✅ Autentica |
| 8 | Suspensão obsoleta | Agente parado → Suspender → Reativar → subir agente | ✅ Suspensão "Substituída"; reativação concluída; nenhuma desconexão no log do cliente |
| 9 | Agente morto no meio da execução | NAS pausado, suspensão iniciada, `docker kill` no agente após gravar a autorização | ✅ Ao voltar: consultou, **não regravou** a autorização ("já aplicada nesta versão"), só derrubou a sessão e verificou |
| 10 | Posse expirada | Agente fora por mais de 2 min durante a execução | ✅ Operação "Incerta" no painel e na saúde da rede; resolvida pela verificação do caso 9 |
| 11 | NAS inacessível | VM pausada + Suspender | ✅ Tentativa falha por timeout, **não** é dada como concluída; nova tentativa consulta antes de repetir |
| 12 | Alteração manual | `Auth-Type` apagado direto no SQLite do RADIUS | ✅ Painel mostra divergência; nenhuma operação criada sozinha; "Suspender" de novo corrige |
| + | API com TLS | `api-ssl` (8729) com certificado e CA exportada | ✅ Operações funcionam; CA errada é recusada (`CERTIFICATE_VERIFY_FAILED`) |
| + | Perda do site | Laboratório destruído e recriado (RADIUS vazio) | ✅ Painel mostra "sem autorização local"; "Reaplicar" regrava a conta e o cliente autentica |

| + | MS-CHAPv2 sem senha em claro | `LAB_PPP_AUTH=mschap2 ./nexo lab-up`: NAS só MS-CHAPv2, RADIUS guarda `NT-Password` | ✅ Cliente autentica; a senha em claro não aparece no arquivo do RADIUS |
| + | Vários clientes | Lote importado (`samples/assinantes.csv`) → "Provisionar lote" → 6 clientes `pppd` com MACs distintos | ✅ 8 contas provisionadas em 7 s; 6 sessões simultâneas, cada uma com a fila do seu plano; suspender uma derruba só ela |
| + | RADIUS local parado | `docker stop lab-radius` por 20 s | ✅ Sessões existentes continuam; nova autenticação falha; volta ao normal ao religar (sem redundância: esperado) |
| + | Reaplicar todas as contas | Site recriado → Rede → "Reaplicar todas as contas" | ✅ Contas regravadas no RADIUS; cliente autentica |
| + | IP fixo do contrato (agente 0.3.0) | Alocar 100.64.0.5 ao contrato em Endereços IP, com o cliente online em endereço dinâmico | ✅ `Framed-IP-Address` gravado no `radreply`; sessão derrubada; cliente reconectou com 100.64.0.5 (antes 100.64.0.247); `/ppp active` confirma. Ao liberar: atributo removido, sessão mantida até reconectar, depois volta ao dinâmico |
| + | Segunda instância do RADIUS (`./nexo lab radius-ha`) | Segunda instância sobre o mesmo banco cadastrada no CHR; principal parada; sessão de um cliente derrubada | ✅ Cliente reautenticou em 13 s com a principal parada (sem a segunda instância, o mesmo cenário deixa o cliente fora) |
| + | Atualização do agente com mudança de schema local (1 → 2) | Reconstruir o agente do laboratório sobre o banco em uso | ✅ Cópia `agent.sqlite.bak-v1` criada; 16 tentativas preservadas; agente online; operação seguinte concluída |
| + | Atualização assinada do agente | 0.1.0 → 0.2.0 com manutenção, cópia do SQLite, `agent-release.sh install` | ✅ Painel mostra a nova versão; estado local preservado (13 tentativas); operação seguinte concluída |

Não exercitado: mais de um NAS, dezenas/centenas de clientes, IPv6, CoA, desempenho (licença gratuita do CHR limita a 1 Mbps).

## 4. Ao repetir no equipamento do piloto

Registrar versão do RouterOS, modelo, método de autenticação, resultado de cada caso e data, e só então considerar o equipamento homologado.
Os passos 1 e 2 abaixo valem para o equipamento real; no laboratório eles são feitos por `infra/lab/lab.sh` e `infra/lab/setup_chr.py`.

## Pendências conhecidas do driver

- Suspensão implementada só na modalidade de demonstração "negar autenticação + derrubar sessão". Modalidade real (ex.: perfil restrito/aviso) depende da política comercial.
- Sessão é lida pela API (`/ppp/active`); CoA/Disconnect-Request por RADIUS não é usado.
- Com o NAS sem resposta, troca de plano, IP fixo e suspensão **não** são dadas como concluídas (a sessão é desconhecida); a operação fica como falha e a nova tentativa consulta antes de repetir. Só o primeiro provisionamento de uma conta conclui sem o NAS.
- Segredo PPPoE fica em `Cleartext-Password` no SQLite local (exigido por CHAP/MS-CHAP). Proteção do arquivo: permissões 660 + disco do host; criptografia do SQLite **não** implementada (ADR-008).
