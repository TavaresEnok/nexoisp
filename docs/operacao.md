# NexoISP — Instalação e operação (preparação do piloto)

Documento único de operação. O que está marcado **não exercitado** ainda precisa ser provado no ambiente do piloto.

## 1. Instalação central (nuvem/servidor do SaaS)

Requisitos: Linux com Docker e Docker Compose; domínio apontando para o host; portas 80/443 (painel) e 8443 (agentes).

```bash
cd infra/prod
cp .env.example .env && chmod 600 .env      # gerar cada segredo NESTE host (comandos no próprio arquivo)
# certificados da API de agentes: CA própria do operador + certificado do servidor
NEXO_API_SAN=DNS:agentes.exemplo.com.br ../../scripts/dev-certs.sh init    # gera em infra/certs; copie ca.crt, server.crt, server.key para infra/prod/certs
docker compose up -d --build
docker compose exec -e NEXO_NEW_PASSWORD='<12+ caracteres>' api node apps/api/dist/cli.js create-operator voce@empresa.com "Seu Nome"
```

- Produção sobe com `NEXO_DEMO_MODE=0`: sem dados sintéticos, sem driver/gateway de demonstração.
- `NEXO_REQUIRE_ADMIN_MFA=1`: administradores e operadores só usam o sistema depois de ativar a verificação em duas etapas (Minha conta).
- O banco tem dois papéis: `nexo_owner` (migrations, backup) e `nexo_app` (aplicação; sem superusuário, sem `BYPASSRLS`, não é dono das tabelas).
- Sessão do painel em cookie `HttpOnly`/`SameSite=Strict`/`Secure` (`NEXO_COOKIE_SECURE=1`); o navegador nunca expõe o token ao JavaScript.
- **Exercitado localmente em 10/10/2026** (`NEXO_DOMAIN=localhost`, portas alternativas): subida do zero, HTTPS pelo Caddy com redirecionamento, criação do operador,
  MFA obrigatório, criação de provedor, acesso de suporte, bloqueio do driver/gateway de demonstração, agente com mTLS, backup + `restore-check`, rotação da chave de segredos.
  **Não exercitado:** host público com domínio e certificado reais. A CA de `dev-certs.sh` serve ao piloto se a `ca.key` for guardada fora do servidor.

### Segredos

| Segredo | Uso | Se perder/vazar |
|---|---|---|
| `NEXO_SECRET_KEY` | Cifra senhas PPPoE e segredos de MFA no banco | Perda: senhas PPPoE irrecuperáveis (redigitar). Vazamento/rotina: **rotacionar** (abaixo) |
| `NEXO_OP_SIGNING_KEY` | Assina operações enviadas aos agentes | Troca: agentes recusam a nova chave até removerem o pin local (`kv.signing_public_key` no SQLite) — procedimento manual |
| `POSTGRES_PASSWORD` / `NEXO_APP_DB_PASSWORD` | Banco | Trocar no `.env` e reiniciar (a senha do `nexo_app` é reaplicada na subida) |
| Token + certificado de cada agente | Identidade do agente | Painel → Rede → Rotacionar token / Revogar |

Guardar cópia de `.env` e de `infra/prod/certs` em cofre separado do backup do banco.

**Rotação de `NEXO_SECRET_KEY`:** (1) backup; (2) no `.env`, mover a chave atual para `NEXO_SECRET_KEY_PREVIOUS` e gerar a nova em `NEXO_SECRET_KEY`; (3) `docker compose up -d api`;
(4) `docker compose exec api node apps/api/dist/cli.js rotate-secrets` até mostrar "0 pendente(s)"; (5) remover `NEXO_SECRET_KEY_PREVIOUS` e reiniciar. A aplicação segue funcionando durante o processo.

### Módulos por provedor

Um provedor novo nasce só com o núcleo: cadastro, planos, contratos, acesso PPPoE, financeiro, portal, importação, auditoria e agentes.
Atendimentos/prospectos, ordens de serviço e estoque, avisos, avisos ao assinante (mensagens só de saída), NOC, rede óptica, IP/CGNAT e OLT são **módulos** que o operador do SaaS libera em
Provedores → Módulos. Sem o módulo, o item some do menu **e o servidor recusa a chamada** (`module_disabled`). O módulo de OLT libera um driver
não homologado em equipamento real: a conferência de produção avisa quando ele está ligado.

### Avisos ao assinante (módulo `messages`)

Só de saída. Em Avisos ao assinante: (1) **Canal**: endereço HTTPS do serviço de envio do provedor e, se houver, o cabeçalho `Authorization` (guardado cifrado);
use *Enviar teste* para um número seu; (2) **Modelo**: texto com `{nome}`, `{valor}`, `{vencimento}`, `{plano}`, `{link}`; (3) **Regra**: dias em relação ao vencimento,
janela de horas e filtros. A rotina periódica envia **uma vez por título e regra**, só a contatos com consentimento (mobile/WhatsApp, finalidade cobrança ou geral),
com até 3 tentativas. O histórico mostra enviado, falhou e sem consentimento. "Rodar agora" respeita as mesmas regras.

### Conferência antes de entrar em produção

```bash
docker compose exec api node apps/api/dist/cli.js preflight
```

Não altera nada. **FALHA** impede a entrada (modo demonstração ligado, MFA não obrigatório, cookie sem HTTPS, contas ou equipamentos de demonstração,
gateway de demonstração, migration pendente, operação incerta). **AVISO** é uma decisão que alguém precisa ter tomado (provedor sem gateway,
suspensão automática ligada, módulo de OLT ligado, agente que não conecta, alerta sem webhook). Sair sem falhas não substitui a homologação no
equipamento nem o ensaio do ciclo completo.

### Homologação local

`./nexo homolog up` sobe, nesta máquina, uma instância com **a mesma configuração de produção** (`infra/prod`), em outro projeto do Docker, outro
banco, segredos e certificados próprios e outras portas (painel em https://localhost:28443, agentes em 28444). A senha do operador fica em
`infra/homolog/operador.txt`. `./nexo homolog preflight` roda a conferência; `./nexo homolog destroy` apaga tudo.
Exercitado em 10/10/2026: MFA obrigatório para operador e administrador, provedor novo só com o núcleo, driver e gateway de demonstração recusados,
recorrência sem duplicar, agente recusado sem certificado de cliente, backup + `restore-check`, conferência sem falhas.
**Não é o ambiente do provedor**: host público, domínio e certificado reais continuam por exercitar.

## 2. Instalação no provedor (agente + RADIUS)

Ver `docs/lab-pppoe.md` (passos 1 e 2). Resumo: `infra/site/` com `.env`, `certs/` (certificado individual `CN=agent:<id>`) e `config/credentials.json`.

- **Emissão:** `./nexo agent-cert <agent_id> <dir>` (validade 398 dias). **Rotação:** emitir novo certificado, substituir os arquivos em `certs/`, `docker compose restart agent`. Token: Painel → Rotacionar token, atualizar `.env`, reiniciar.
- **Certificado fixado:** o primeiro certificado apresentado por um agente passa a ser o único aceito (impressão digital no painel). Ao rotacionar: Painel → Rede → "Aceitar novo certificado" e só então reiniciar o agente com o novo. Um certificado antigo ou copiado é recusado e a tentativa fica na auditoria (`agent.certificate_rejected`).
- **Revogação:** Painel → Rede → Revogar (bloqueia token e identidade imediatamente).
- **Senha PPPoE no site:** em `config/credentials.json`, `"password_storage": "nt_hash"` grava só o hash NT no RADIUS local (sem senha em claro no disco). Exige o PPPoE server do NAS apenas com `authentication=mschap2`. Sem a opção, o padrão é texto claro (necessário para CHAP).
- **IP fixo:** o endereço alocado ao contrato em Endereços IP é entregue pelo RADIUS local (`Framed-IP-Address`). Exige agente **0.3.0 ou superior**: um agente anterior recusa a operação (“envelope fora do schema”) em vez de ignorar o endereço. Use endereços fora da faixa dinâmica do NAS.
- **Suspensão por perfil de bloqueio (agente 0.4.0+):** em Política de cobrança, a modalidade "Manter conectado com o perfil de bloqueio" faz a suspensão entregar ao
  assinante o perfil PPP informado (`Mikrotik-Group`), em vez de negar a autenticação. **O perfil e o que ele faz (velocidade mínima, pool de endereços de aviso,
  redirecionamento para a página de aviso) precisam existir no concentrador: o NexoISP não os cria.** Conta encerrada sempre é rejeitada. Sem IP fixo durante a
  suspensão (o assinante precisa cair no endereço do bloqueio). A API recusa a suspensão se o agente do equipamento for anterior à 0.4.0.
- **Vínculo de MAC (agente 0.4.0+):** Contrato → Acesso → "Vincular" grava `Calling-Station-Id == <MAC>` no RADIUS local; o equipamento com outro MAC não autentica.
  Formato canônico: maiúsculas com dois-pontos, como o RouterOS envia. Troque o MAC antes de trocar o equipamento do assinante.
- **Consumo mensal (agente 0.4.0+):** lido do accounting do RADIUS local (`radacct`) a cada 15 min, mês corrente e anterior, em UTC. Exige o accounting ligado no NAS
  (`/ppp aaa set accounting=yes`) e o NAS apontando para este RADIUS. Aparece no contrato e no portal do assinante.
- **Limpeza automática:** o agente remove accounting encerrado e registros de autenticação com mais de `NEXO_RADIUS_KEEP_DAYS` (padrão 90) a cada 6 h.
- O agente só abre conexões de saída (8443). O NAS fala com o RADIUS local (UDP 1812/1813); restrinja por firewall ao IP do NAS.

### Atualização autenticada do agente

```bash
# uma vez: chave de release (privada fica com o time de engenharia)
scripts/agent-release.sh keygen ~/nexo-release-keys
# a cada versão
scripts/agent-release.sh build 0.2.0 ~/nexo-release-keys/agent-release.key releases/
# no site (copiar .tar, .manifest, .manifest.sig e ter a .pub instalada previamente)
scripts/agent-release.sh install nexoisp-agent-0.2.0.tar agent-release.pub   # recusa pacote com assinatura ou SHA-256 inválidos
```

Procedimento no site: (1) modo manutenção no equipamento pelo painel; (2) aguardar fila vazia; (3) `cp -a data data.bak-<data>`; (4) `install`; (5) ajustar a tag da imagem no compose e `docker compose up -d agent`; (6) conferir agente online e sincronizado; (7) encerrar manutenção.

Schema local: ao iniciar sobre um banco de schema anterior, o agente grava uma cópia íntegra (`data/agent.sqlite.bak-v<schema>`) e só então migra, em transação. Para voltar ao binário anterior, com o agente parado: `docker compose run --rm agent python -m nexo_agent.rollback <schema do binário antigo>`. O comando recusa se houver tentativa interrompida ou resultado não entregue (perder esse registro impediria a consulta antes de repetir) e guarda o banco substituído ao lado. Exercitado: migração 1 → 2 no site do laboratório (16 tentativas preservadas, operação seguinte concluída). Rollback: coberto por teste; **não exercitado num site**.

Compatibilidade: o manifesto traz `protocol_schema` (envelope) e `local_schema` (SQLite). O agente **recusa iniciar** sobre um SQLite de schema mais novo — reverter binário exige restaurar `data.bak-<data>` do passo 3. Não há rollback automático. Exercitado: geração, instalação, rejeição de pacote/manifesto adulterados e **atualização 0.1.0 → 0.2.0 no site do laboratório** (estado local preservado, agente voltou a operar); recusa de iniciar sobre SQLite de schema mais novo coberta por teste. **Não exercitado:** atualização que altere de fato o schema local, e site remoto real.

## 3. Monitoramento básico

**Limite de login:** as tentativas ficam no banco (8 falhas por e-mail e 40 por endereço de origem, em janela de 10 minutos), então valem para todas as réplicas e sobrevivem a reinício. Atrás do Caddy a instalação define `NEXO_TRUST_PROXY=1` para usar o endereço real do cliente; **sem proxy confiável essa variável não deve ser ligada** (o cabeçalho seria forjável).

| O quê | Onde |
|---|---|
| API e banco | `GET /api/health` (200 = ok; 503 = banco indisponível) — apontar o monitor externo |
| Agente offline, atraso de sincronização, fila | Painel → Rede (por provedor) e Provedores (visão do operador) |
| Operação incerta, falha, expirada, divergência | Painel → Início / Operações → "Com problema ou atrasadas" |
| Alerta em log | Linha `ALERTA tenant=… agentes_offline=… operacoes_incertas=…` a cada minuto enquanto durar |
| Alerta por webhook | `NEXO_ALERT_WEBHOOK_URL`: recebe `POST` JSON `{text, alerts}` quando o conjunto de alertas muda e quando normaliza (compatível com webhooks de chat que aceitam `text`). Implementado; **não exercitado contra um serviço real** |
| Financeiro | Conciliação: eventos divergentes/sem cobrança e faturas "em conciliação" |

Não há envio nativo por e-mail/WhatsApp: use o webhook com o serviço escolhido pela operação do provedor.

## 4. Backup e restauração

```bash
./nexo backup [dir]                 # pg_dump custom + SHA-256 (diário via cron; copiar para fora do host)
./nexo restore-check <arquivo>      # restaura em banco temporário e confere contagens e políticas RLS
./nexo restore <arquivo> --yes      # substitui o banco principal (para a API durante a operação)
```

Em produção use `scripts/backup.sh` com `NEXO_DB_CONTAINER=nexoisp-prod-db-1` e `NEXO_BACKUP_COPY=<comando ou script>` para levar cada backup para **fora do host**
(o comando recebe o arquivo e o `.sha256`; se falhar, o script termina com erro para o agendador alertar). Sem ele o script avisa que o backup está no mesmo domínio de falha do banco.
Exercício feito em 10/10/2026 (ambiente local): backup → criação de um registro → `restore-check` → `restore` → registro posterior ausente, login e consultas funcionando, 31 políticas RLS presentes; arquivo adulterado recusado pela soma de verificação.

- O backup do banco **não** inclui: `.env`, certificados, SQLite dos agentes e do RADIUS (ficam nos sites).
- Site: copiar `infra/site/data/` (SQLite do RADIUS e do agente) periodicamente. Perda do site: reinstalar, subir o RADIUS, "Aceitar novo certificado" se o certificado mudou, e Rede → **"Reaplicar todas as contas"** no equipamento (o agente regrava autorização e política; as senhas vêm da nuvem) — exercitado no laboratório.
- RPO/RTO não definidos (dependem do provedor). Restaurar um backup desfaz pagamentos registrados depois dele: após um `restore`, executar Conciliação → "Consultar gateway agora".

## 5. Limites e procedimentos

| Situação | Comportamento | Ação |
|---|---|---|
| Nuvem indisponível | RADIUS local segue autenticando com a última política conhecida; agente não recebe escritas | Nenhuma no site. Pagamentos/suspensões ocorridos no período só chegam quando a nuvem voltar |
| Agente parado | Operações ficam "Aguardando agente" (validade 24 h; depois "Expirada") | Subir o agente; reexecutar as expiradas pelo contrato |
| RADIUS local parado | **Clientes não autenticam** (sessões ativas continuam) — comprovado no laboratório | Reiniciar o serviço. Com a segunda instância (`docker compose --profile ha up -d`, porta 1822/1823, cadastrada no NAS como segundo servidor RADIUS) a autenticação continua — comprovado no laboratório. Ela lê o mesmo banco no mesmo host: **não cobre perda do host ou do disco** |
| Disco cheio no site | Agente não consegue registrar a tentativa e **não escreve** no equipamento; a operação não é dada como concluída nem como falha e segue quando houver espaço (testado com o erro real “database or disk is full” do SQLite). RADIUS pode falhar no accounting | Liberar espaço; a limpeza automática do accounting reduz o risco. Não exercitado com um disco de verdade cheio |
| Manutenção no NAS | Painel → Rede → Modo manutenção: ERP não envia escritas | Encerrar ao final; operações retomam |
| Troca do host do agente | Nunca dois agentes com a mesma identidade: parar e **revogar** o antigo, criar agente novo, associar o equipamento, instalar | Operações em execução no antigo ficam "Incertas" e são verificadas pelo novo antes de repetir |
| Operação incerta | Bloqueia novas escritas no equipamento até ser verificada pelo agente | Se o agente não voltar: decidir manualmente e usar "Reaplicar" depois |
| Alteração manual no RADIUS/NAS | Painel mostra divergência; nada é corrigido sozinho | "Reaplicar" ou ajustar a intenção |

### Cobrança avançada (opcional; com os padrões nada muda)

Todos os recursos abaixo ficam desligados até o provedor configurá-los em Política de cobrança.

- **Liberação por confiança (promessa de pagamento):** religa um acesso suspenso por até N dias, pela equipe (Contrato → Acesso) ou pelo assinante (portal).
  Intervalo mínimo entre liberações configurável. Enquanto vale, a suspensão automática não age; ao vencer sem pagamento volta a valer a política. Sem política
  de suspensão automática configurada, a liberação apenas vence: nada é suspenso sozinho.
- **Multa e juros:** percentuais configurados pelo provedor; entram só na baixa manual (a equipe escolhe cobrá-los) e no acordo. Juros: ao mês, pro rata por dia
  de atraso. **Cobranças já emitidas no gateway não mudam de valor.**
- **Baixa parcial e desconto:** a baixa manual pode ser parcial (a fatura continua em aberto com o saldo) e aceitar desconto com motivo. Valor diferente do devido,
  sem marcar como parcial, continua indo para a conciliação.
- **Estorno:** só de baixa manual. Grava uma linha de estorno (o histórico de pagamentos nunca é alterado) e reabre a fatura. **Não desfaz o que a baixa causou na
  rede** (reativação): quem suspende de novo é a política. Baixa vinda do gateway só volta pelo gateway.
- **Acordo de pagamento:** reúne faturas em aberto do contrato, cancela as originais e gera as parcelas. O que já foi pago parcialmente é descontado. As parcelas
  nascem com cobrança no gateway, se houver. Pagamentos que cheguem para as faturas canceladas vão para a conciliação.
- **Primeiro mês proporcional:** opcional; vale para contratos que começam depois do dia 1º.
- **Aviso de manutenção:** Rede → Manutenções. Aparece no portal do assinante atingido; **não envia SMS nem e-mail**.

## 6. Medição curta (volume sintético)

Volume do piloto ainda desconhecido. Medição local única — ver números na seção de progresso do documento 04. Não representa SLA nem capacidade garantida.

## 7. Lista de entrada em produção (preencher com o provedor)

- [ ] Grupo piloto autorizado por escrito (quais assinantes/NAS) e responsáveis (provedor, engenharia, plantão).
- [ ] Roteiro PPPoE repetido no equipamento físico do piloto (já aprovado em laboratório virtual com CHR 7.24.5; ver `docs/lab-pppoe.md`).
- [ ] Gateway real escolhido, adaptador implementado e validado em sandbox (hoje só existe o de demonstração).
- [ ] Política comercial configurada pelo provedor (dias para suspensão, reativação automática) — e modalidade de suspensão confirmada.
- [ ] Processo fiscal definido (emissão de nota não implementada).
- [ ] Amostra real do MK-Auth convertida/mapeada; prévia conferida: clientes, contratos, soma dos títulos, contas sem senha.
- [ ] MFA ativo para administradores; senhas de demonstração inexistentes (produção não tem seed).
- [ ] Backup automático configurado e um `restore-check` feito no ambiente de produção; cópia do `.env` em cofre.
- [ ] Fonte autoritativa por grupo definida; reversão combinada (`docs/importacao-csv.md`, "Corte e reversão").
- [ ] Monitor externo em `/api/health` e responsável por olhar "Operações com problema".

**Ação de virada que depende de autorização explícita:** importar a base real, clicar "Provisionar N conta(s)" no lote e reapontar o RADIUS do NAS do grupo piloto para o RADIUS local. Nada disso foi executado.
