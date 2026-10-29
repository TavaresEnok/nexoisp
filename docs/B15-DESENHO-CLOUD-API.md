# B15 — desenho do adapter Cloud API de avisos, desligado por padrão

O adendo do lote 33 está no final deste arquivo e decide os refinamentos de consentimento, de retry e de linearização. Os parágrafos seguintes permanecem o desenho do lote 32 e não são reescritos.

Este recorte é só desenho e matriz. A base lida é `6963214927aa45ae1963c58d4c14ba540d78c2f0`. Não há migração, código, conta, token, ativação, chamada à Meta, chamada a PSP, publicação, `main` nem homologação. A matriz futura está em [docs/B15-ACEITE-CLOUD-API.json](B15-ACEITE-CLOUD-API.json). Cada caso de lá está `planned/not_run`. O comando indicado é o argv da implementação futura. Skip não é execução.

NexoISP continua com avisos de saída. A fronteira está escrita em `db/migrations/00027_avisos_ao_assinante.sql`. O comentário dessa migração nomeia cobrança, manutenção e OS. Na fila que o claim realmente lê, cobrança e manutenção são linhas de `notice_log`. OS segue outro caminho: `domain.QueueNotice` grava `notifications` para o webhook interno do tenant. `notice_log` não tem coluna de ordem de serviço. A migração 51 acrescenta `maintenance_notice_id` e `phase`. O adapter Cloud API envia cobrança e manutenção que já estejam nessa fila. Não lê `notifications`, não cria aviso de OS e não puxa OS para `notice_log`. Webchat, inbox e CRM de conversa pertencem a outro projeto. `provider_notices` (migração 72, `finance.AcceptPixNotices`) é a caixa de aviso de PSP e não recebe evento de WhatsApp. `notifications` e `webhook_deliveries` (`outbound.Notifications`, `outbound.Webhooks`) continuam sendo o webhook genérico do tenant. O adapter não os substitui e não nasce dentro deles.

## Fatos já fixados

A fila de avisos já existe e permanece a fila dos dois adapters.

| Peça | Onde | Comportamento que o desenho preserva |
| --- | --- | --- |
| Módulo | `apps/api-go/internal/outbound/sql/69b06ce3_0.sql` | `enqueueNotices` segue com o módulo `messages` do tenant, salvo `force` |
| Varredura de incerteza | `69b06ce3_1.sql`, chamada com 10 minutos | `sending` antigo vira `uncertain`, apaga `message` e não reenvia sozinho |
| Candidatos | `69b06ce3_3.sql` | Fatura `open`, contrato e assinante ativos, dia relativo, no máximo 500. Exclui log em `sent`, `skipped_no_consent`, `queued`, `sending`, `uncertain` ou `attempts >= 3` |
| Consentimento na entrada | `69b06ce3_4.sql`, migração 25 | `allow_notices` verdadeiro, `kind` `mobile` ou `whatsapp`, `purpose` `billing` ou `general`, `billing` primeiro. Sem contato: `skipped_no_consent` |
| Upsert | `69b06ce3_5.sql` | Uma linha por `(rule_id, invoice_id)`. Conflito incrementa `attempts` |
| Claim | `69b06ce3_6.sql` | Um `queued` por tenant, qualquer origem, `for update skip locked`, passa a `sending` |
| Manutenção na mesma fila | `aee9567a_3.sql`, migração 51 | Insert com `maintenance_notice_id`, `phase`, `invoice_id` nulo. Contato com `allow_notices` e `kind` `mobile` ou `whatsapp`, ordenado por `purpose = technical` primeiro. Sem contato: `skipped_no_consent`. Único `(maintenance_notice_id, subscriber_id, phase)` |
| Contagem no notify | `rotinas.go` `maintenanceNotify` | Conta só o `returning` desse insert: `queued` e o restante, que nesse SQL é `skipped_no_consent`. Não observa status gravado depois pelo worker |
| Fecho | `69b06ce3_7.sql` | Atualiza só se ainda está `sending`. Sucesso apaga `message` |
| Retenção | `radius.Purge`, `b2808f33_1.sql` (`purgeRadius` índice 1) | Apaga `sent`, `failed`, `skipped_no_consent`, `uncertain`, `test` pelo prazo do tenant, limite 5000. `queued` e `sending` ficam |
| Canal genérico | `notice_channels`, `outbound.Message`, `POST /api/notice-channels` | URL escolhida pelo provedor, corpo JSON com `phone_field` e `message_field`, `headers_enc` via `cryptox.EncryptSecret` / `DecryptSecret`, timeout 10s |
| SSRF do canal genérico | `outbound.safeURL`, `postBytes` | HTTPS fora de demo, sem usuário na URL, sem IP interno, sem redirect, corpo de resposta limitado a 4096 bytes e descartado |
| Lock de fatura | `finance.LockInvoices`, sal `7411005` | `pg_advisory_xact_lock(hashtextextended(tenant:invoice:id, 7411005))` em ordem de UUID e só então `for update` na mesma ordem. `enqueueNotices` chama isso antes de reler o candidato e `noticeInvoicePayable` |
| Pagável | `noticeInvoicePayable` em `notices.go` | `status = open` e `amount_cents + fee_cents - discount_cents - sum(signed_cents) > 0` |
| Interface | `apps/web/features/admin/message-channels.tsx` | Cria canal genérico com nome, URL, campos e Authorization. A cifra não volta na consulta |
| Estados atuais | migrações 27 e 35 | `queued`, `sending`, `sent`, `failed`, `uncertain`, `skipped_no_consent`, `test` |

`outbound.Notices` enfileira numa transação curta e envia fora dela, no máximo 500 itens. `Message` trata HTTP 2xx como fim do envio genérico e qualquer outro status ou erro de transporte como `failed`. Esse contrato do canal genérico permanece. O adapter Cloud API é outro caminho, escolhido por coluna, e não altera `Message`.

A corrida que o código já fecha é a da entrada na fila: sob `LockInvoices`, fatura cancelada ou quitada não entra. A corrida que permanece aberta é pagamento ou opt-out depois do commit do enqueue e antes do HTTP. O trecho Cloud API abaixo fecha essa corrida até o ponto de linearização. O HTTP já iniciado fica de fora dessa promessa.

## Fora deste lote

Não há conta WABA, número, token, segredo de webhook nem linha ativa. A variável de processo ainda não existe no código. Allowlist de versão Graph nasce vazia na implementação futura. Nenhuma versão numérica é declarada suportada. Teste offline com HTTP falso não homologa WABA, template, canal real nem entrega no aparelho. Planos 29, 30 e 31 permanecem como estão. Este arquivo não reexecuta B04 nem reenvia a candidata.

## Protocolo consultado

Fontes primárias registradas pela gerência em 29/10/2026:

- Coleção pública Meta no Postman: `https://www.postman.com/meta/whatsapp-business-platform/overview` e `https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api`, request nomeado `send-message-template-text`.
- Forma do endpoint nessa coleção: `graph.facebook.com/{{Version}}/{{Phone-Number-ID}}/messages`, token bearer, resposta com `messages[].id`.
- A presença de `messages[].id` não é prova de idempotência do provedor.
- `developers.facebook.com` em messages e `graph-api/webhooks/getting-started` responderam 429 nessa consulta. Este desenho não os reconta.
- `https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/` descreve assinatura e challenge de uma SDK arquivada. Serve como histórico. Não define a versão Graph atual, o nome do cabeçalho vigente nem o algoritmo vigente.

Em 29/10/2026 a leitura deste executor sobre a URL da coleção devolveu somente o título da página, sem corpo de request e sem versão. Por isso o desenho não copia um JSON de template.

Verificado para o desenho, via registro da gerência: método POST, host `graph.facebook.com`, caminho `/{Version}/{Phone-Number-ID}/messages`, autenticação bearer, identificador em `messages[].id` quando a coleção o mostra.

Pendente, sem invenção no código futuro até fonte primária atual sem 429:

- string da versão Graph e lista de versões suportadas;
- esquema do corpo de template, nomes de idioma, componentes e parâmetros;
- cabeçalho de idempotência e campo `biz_opaque_callback_data`;
- nome do cabeçalho de assinatura, algoritmo e handshake de challenge vigentes;
- vocabulário oficial de status (`sent`, `delivered`, `read` e falhas);
- alfabeto oficial de `Phone-Number-ID`;
- semântica de corpo em 429 e 5xx.

O cliente futuro não envia cabeçalho de idempotência nem `biz_opaque_callback_data`. A chave de correlação fica só no journal local. O autenticador de webhook de produção permanece com `Proven() == false` até um lote de operador gravar a fonte vigente. Com `Proven() == false` o webhook responde recusa e não grava.

## Seleção explícita e flag

O canal genérico continua valendo quando `notice_channels.adapter` está ausente na linha antiga ou é `generic_http`. URL contendo `graph.facebook.com` não muda o adapter. `Message` segue sendo o único envio desse valor.

A implementação futura acrescenta `adapter text not null default 'generic_http'` com verificação `generic_http` ou `cloud_api`, e `cloud_account_id uuid` nulo no genérico. `cloud_api` exige conta no mesmo tenant. A tela oficial não ganha campo de token neste desenho. Criar a coluna não cria conta.

Duas travas independentes, as duas necessárias para qualquer byte à Meta:

1. `NEXO_CLOUD_API` igual a `on`. Ausente, vazio ou outro valor deixa o cliente desligado. Este lote não define a variável no ambiente.
2. `provenGraphVersions` vazio no código. Versão fora dessa lista, inclusive qualquer versão enquanto a lista estiver vazia, recusa antes do transporte.

Conta com `active = false` também recusa antes do transporte. A migração futura não insere conta e o default de `active` é falso.

`NEXO_DEMO_MODE` não abre exceção para este adapter. O cliente Cloud API não chama `outbound.Post` nem `SafeURL` do canal genérico, porque esse caminho aceita URL arbitrária e, em demo, HTTP. O endpoint é montado por `cloudapi.Endpoint`.

## Raiz R1 — cliente HTTP puro

Pacote novo `apps/api-go/internal/outbound/cloudapi`. Não importa `database/sql`, `db`, `cloudjournal`, `finance` nem `notices`. O teste desse pacote aprova sozinho, com `http.RoundTripper` falso no processo. Transporte nulo em produção usa o pino de DNS descrito abaixo. Teste que aponta transporte falso não abre rede.

```go
type Config struct {
    Enabled          bool
    AllowVersions    []string
    Transport        http.RoundTripper
    Timeout          time.Duration
    MaxResponseBytes int
}

type Request struct {
    Version       string
    PhoneNumberID string
    To            string
    TemplateName  string
    TemplateLang  string
    BodyParams    []string
    Bearer        string
    AttemptKey    string
}

type Result struct {
    HTTPStatus        int
    ProviderMessageID string
    Submitted         bool
    Uncertain         bool
    Refused           bool
    BodyExcerpt       string
}

func New(cfg Config) (*Client, error)
func Endpoint(version, phoneNumberID string) (*url.URL, error)
func Redact(s string) string
func (c *Client) Send(ctx context.Context, in Request) (Result, error)
```

`AttemptKey` é correlação interna. `Send` não a coloca em cabeçalho. `Bearer` entra na memória do request e sai do texto de erro por `Redact`. `To` sai do texto de erro pelo mesmo redator. `BodyExcerpt` tem no máximo 300 unidades UTF-16, o mesmo teto de `notice_log.error`.

`Endpoint` aceita somente `https`, host `graph.facebook.com`, sem usuário, sem porta, sem query e sem fragmento. O caminho tem três segmentos: versão, identificador e `messages`. Versão vazia, identificador vazio, `/`, `?`, `@` ou host diferente recusam com erro e zero `RoundTrip`. O alfabeto fino do identificador continua pendente: até a fonte, o cliente recusa vazio e qualquer caractere fora de `[0-9]`, com tamanho de 1 a 32. Esse intervalo é trava local, não citação da Meta.

`Send` devolve erro e zero transporte quando `Enabled` é falso, quando a versão não está em `AllowVersions`, quando `Endpoint` recusa ou quando o bearer está vazio. `AllowVersions` nulo ou vazio equivale a nenhuma versão.

Resolução, só depois dessas travas: lookup do host fixo, recusa se algum endereço for interno pelo mesmo critério de `privateAddress` em `http.go` (loopback, privado, link-local, CGNAT `100.64.0.0/10`, documentação e os demais prefixos já listados). O `DialContext` liga só nos endereços já aceitos, com `Proxy` nulo e redirect recusado. Timeout padrão 10s, igual a `Message`. Corpo de resposta lido com limite 4096 bytes. Excesso é descartado. JSON acima do corte, sem `messages[].id` completo, não vira sucesso.

Classificação, local, sem tratar status de webhook:

| Resposta | `Submitted` | `Uncertain` | `Refused` | `ProviderMessageID` |
| --- | --- | --- | --- | --- |
| 2xx e `messages[].id` não vazio | verdadeiro | falso | falso | o id |
| 2xx sem id, ou corpo cortado | falso | verdadeiro | falso | vazio |
| 429 | falso | falso | verdadeiro | vazio |
| outro 4xx, inclusive template recusado | falso | falso | verdadeiro | vazio |
| 5xx | falso | verdadeiro | falso | vazio |
| timeout ou erro depois que `Do` foi chamado | falso | verdadeiro | falso | vazio |
| recusa antes de `Do` | falso | falso | falso | vazio, com erro |

`Submitted` significa que o HTTP foi aceito e devolveu id. Entrega no aparelho é outro fato, gravado só pelo journal quando um webhook autenticado e um parser provado existirem. O cliente não tem estado `delivered`.

429 e 4xx não disparam segundo `RoundTrip` dentro de `Send`. 5xx e timeout também não. Não há exactly-once externo: a Meta não documentou, na fonte usada, idempotência desse POST.

O corpo enviado é o menor JSON que a implementação conseguir assim que a fonte primária do template estiver anexada ao lote que preencher `AllowVersions`. Enquanto o esquema estiver pendente, `Send` com versão não allowlisted nem monta o corpo. O lote que adicionar uma versão cita a URL, a data e o esquema no mesmo cambio. Este desenho não escolhe essa versão.

Segredo: o caller entrega o bearer já decifrado com `cryptox.DecryptSecret`. O cliente não cifra e não registra o cipher. Erro e excerpt passam por `Redact`, que remove o bearer, o prefixo `Bearer`, o telefone do request e sequências `EAA` longas típicas de token de página. O teste usa o literal falso `test-token-not-real` e o telefone `5500000000001`.

## Raiz R2 — journal, consentimento e corrida

Pacote novo `apps/api-go/internal/outbound/cloudjournal`. Não importa `cloudapi`. O sender dos testes é um falso declarado no próprio pacote de teste. R2 aprova sem o cliente real e sem a rota HTTP.

```go
type Decision string

const (
    DecisionSend        Decision = "send"
    DecisionOptOut      Decision = "opt_out"
    DecisionSettled     Decision = "settled"
    DecisionLockTimeout Decision = "lock_timeout"
    DecisionIneligible  Decision = "ineligible"
)

type LogKind string

const (
    LogKindBilling     LogKind = "billing"
    LogKindMaintenance LogKind = "maintenance"
    LogKindOther       LogKind = "other"
)

func Classify(invoiceID, maintenanceNoticeID string) LogKind
func ConsentBilling(ctx context.Context, tx *db.Tx, tenant, subscriberID, contactValue string) (bool, error)
func ConsentMaintenance(ctx context.Context, tx *db.Tx, tenant, subscriberID, contactValue string) (bool, error)

type Sender interface {
    Send(ctx context.Context, attemptKey string) (started bool, err error)
}

type Authenticator interface {
    Proven() bool
    Verify(headers map[string]string, body []byte) error
}

type StatusEffect struct {
    Applied     bool
    Duplicate   bool
    MoneyWrites int
    Sends       int
}

func Revalidate(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64) (Decision, error)
func MarkWire(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64) (Decision, error)
func RecordResult(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64, httpStatus int, providerMessageID string, uncertain, refused bool, excerpt string) error
func SweepReserved(ctx context.Context, tx *db.Tx, tenant string) error
func AcceptStatus(ctx context.Context, tx *db.Tx, tenant, accountID string, headers map[string]string, body []byte, auth Authenticator) (StatusEffect, error)
```

`Sender.Send` do teste de R2 não é o cliente Meta. `started == true` significa que o falso entrou na zona equivalente a `Do`. O gate futuro adapta `cloudapi.Client` a essa interface. R1 não precisa passar para R2 passar.

### Migração futura

Arquivo previsto: `db/migrations/00079_cloud_notice_journal.sql`, o inteiro livre depois de `00078_import_batch_compensations.sql`. Se outro lote ocupar `00079` antes, o dono renomeia antes de gravar. A migração cria tabela e não insere conta, canal nem aviso.

`cloud_accounts`: `id`, `tenant_id`, `name`, `phone_number_id`, `graph_version`, `token_enc`, `webhook_secret_enc`, `active boolean not null default false`, `created_at`. Único `(tenant_id, id)` e `(tenant_id, phone_number_id)`. RLS `tenant_id = app_tenant()` e política restritiva com `app_subscriber()` nulo, no mesmo espírito de `notice_channels`. Grants para `nexo_app` sem um papel que grave token em claro. `token_enc` e `webhook_secret_enc` usam o formato `v1.` de `cryptox.EncryptSecret`.

`cloud_notice_attempts`: `id`, `tenant_id`, `cloud_account_id`, `notice_log_id`, `attempt_no`, `state`, `provider_message_id`, `http_status`, `excerpt`, `created_at`, `wire_at`. Único `(notice_log_id, attempt_no)` e único `(tenant_id, cloud_account_id, provider_message_id)` quando o id não é nulo. `state` em `reserved`, `wire`, `submitted`, `refused`, `uncertain`, `not_sent`.

`cloud_notice_status`: `id`, `tenant_id`, `cloud_account_id`, `provider_message_id`, `body_hash`, `raw_status`, `created_at`. Único `(cloud_account_id, body_hash)`. Append-only. Não há coluna de centavos.

`notice_log` ganha o status `skipped_settled` no check já existente. Os status antigos permanecem. `skipped_settled` só é resultado do ramo billing, quando a fatura deixa de estar pagável. Manutenção não grava esse status.

### Classificação e consentimento

`Classify`: `invoice_id` não vazio devolve `billing`. `invoice_id` vazio e `maintenance_notice_id` não vazio devolve `maintenance`. Os dois vazios devolvem `other`. `Revalidate` e `MarkWire` chamam o mesmo classificador e o mesmo par de funções de consentimento.

`ConsentBilling` é verdadeiro quando existe contato daquele assinante com `value` igual ao `contact_value` já gravado no log, `allow_notices`, `kind` em `mobile` ou `whatsapp` e `purpose` em `billing` ou `general`. É o filtro de `69b06ce3_4.sql` aplicado ao número que o sender vai usar. A função não troca o telefone por outro contato da família `billing`.

`ConsentMaintenance` é verdadeiro quando existe contato daquele assinante com `value` igual ao `contact_value` do log, `allow_notices` e `kind` em `mobile` ou `whatsapp`. É o filtro do `where` de `aee9567a_3.sql`. A inserção ordena `purpose = technical` primeiro e aceita outro purpose se for o único contato. A releitura preserva isso: purpose `technical` passa, e purpose `billing` ou `general` também passa. A função não aplica o filtro de `69b06ce3_4.sql` e não exige purpose `technical`.

`LogKindOther` devolve `DecisionIneligible`. O log vai a `failed`, o attempt fica `not_sent`, e não há `LockInvoices` nem sender. O insert de teste `ecc86eff_1.sql` grava status `test`, e o claim não o seleciona. O ramo cobre uma linha `queued` sem fatura e sem manutenção.

### Ordem e ponto de linearização

O claim atual (`69b06ce3_6.sql`) continua dono de passar `queued` para `sending`. Só a réplica que recebeu a linha segue. A outra recebe zero linhas por `skip locked`. O claim não filtra `invoice_id`.

`attempt_no` novo é `1 + coalesce(max(attempt_no), 0)` daquele `notice_log_id`. A linha nasce em `reserved` na transação A quando a decisão segue para envio. Estados terminais do attempt: `submitted`, `refused`, `uncertain`, `not_sent`. Número terminal não volta a `reserved` e não é reutilizado.

Para `adapter = cloud_api` e `LogKindMaintenance`, a ordem depois do claim é:

1. Transação A sem `finance.LockInvoices` e sem `noticeInvoicePayable`. A leitura é `ConsentMaintenance`. Sem consentimento: `DecisionOptOut`, `skipped_no_consent`, attempt `not_sent`, sem sender. Com consentimento: attempt `reserved`, `wire_at` nulo. Commit. Este commit é o ponto de linearização L deste ramo. `DecisionSettled` não é retorno deste ramo. O estado do aviso de manutenção não é relido aqui. O worker genérico também envia a linha que já entrou na fila, e este desenho não acrescenta essa releitura.
2. Transação B, de novo só `ConsentMaintenance`. Consentimento ausente: o mesmo terminal de A, sem sender. Consentimento presente: `state` passa a `wire` e `wire_at` recebe o relógio. Commit.
3. Fora de transação, uma chamada ao sender. Para o cliente real, é um `Do`.
4. Transação C, igual à do ramo billing abaixo.

Não há advisory de fatura nem orçamento de 2s neste ramo. Pagamento de outra fatura do mesmo assinante não entra na decisão. Se o consentimento cai em B, B atualiza o attempt `reserved` já commitado para `not_sent` e o log para `skipped_no_consent`. B não insere outro `attempt_no`.

Para `adapter = cloud_api` e `LogKindBilling`, a ordem depois do claim é:

1. Transação A, orçamento 2s no lock, com savepoint em volta de `finance.LockInvoices` no id da fatura. Lock obtido: leitura de pagável, igual a `noticeInvoicePayable`, e `ConsentBilling`, no instante desta transação. Opt-out ou contato ausente: `skipped_no_consent`, attempt `not_sent`, sem sender. Fatura fora de `open` ou sem saldo: `skipped_settled`, attempt `not_sent`, sem sender. Pagável e com consentimento: attempt `reserved`, `wire_at` nulo. Commit. Este commit é o ponto de linearização L deste ramo.
2. Transação B, de novo `LockInvoices` sob savepoint e as mesmas leituras, orçamento 2s. Se o título deixou de estar pagável ou o consentimento caiu depois de L, B atualiza o mesmo attempt `reserved` para `not_sent` e o log para `skipped_settled` ou `skipped_no_consent`. B não insere outro `attempt_no`. O sender não corre. Se ainda vale, `state` passa a `wire` e `wire_at` recebe o relógio. Commit.
3. Fora de transação, uma chamada ao sender. Para o cliente real, é um `Do`.
4. Transação C grava `submitted`, `refused` ou `uncertain` somente se o log ainda está `sending`, no mesmo espírito de `69b06ce3_7.sql`. `submitted` deixa `notice_log.status = sent` e apaga `message`. `refused` deixa `failed`. `uncertain` deixa `uncertain`.

No ramo billing, pagamento ou opt-out que commita antes do commit de B é visível em B e cancela o envio com zero HTTP. Pagamento que commita depois do commit de B corre em paralelo ao HTTP. Não há chamada para desfazer o POST. A fonte consultada não trouxe operação de cancelamento de mensagem já aceita, e um request em voo não é recolhido pelo lock. O worker grava o resultado que chegar. O pagamento permanece. O webhook não estorna.

O `lock_timeout` de 2s abortaria a transação inteira se ficasse sem savepoint, e a volta a `queued` se perderia. Por isso o lock fica num savepoint. No estouro, a transação desfaz só o savepoint, zera o `lock_timeout` local e grava o desfecho abaixo. Isso vale só para o ramo billing.

Estouro em A, antes de existir attempt commitado: A não insere attempt. O log, ainda `sending`, volta a `queued`. Sender não corre. O próximo claim pode criar `attempt_no` 1.

Estouro em B, com o attempt de A já commitado em `reserved` e `wire_at` nulo: esse attempt passa a `not_sent`. Esse é o estado final desse número. O log volta a `queued`. Sender não corre. Não é reenvio de HTTP. O próximo claim, se `Revalidate` de novo seguir para envio, insere o número seguinte. Se o estouro foi do `attempt_no` 1, o seguinte é 2. A unicidade `(notice_log_id, attempt_no)` permanece. C01 vê um único attempt porque a fixture não estoura o lock. C21 vê o estouro e o `not_sent`.

Morte do processo depois do commit de A e antes do commit de B deixa o log em `sending` e o attempt em `reserved` com `wire_at` nulo. A varredura `69b06ce3_1.sql`, chamada com 10 minutos, continua dona desse `sending`: passa o log a `uncertain`, apaga `message` e não olha adapter nem `wire_at`. Este desenho não altera essa sentença. `SweepReserved`, ao achar attempt `reserved` com `wire_at` nulo e o log já `uncertain`, grava o attempt como `not_sent`, não cria outro número e não chama o sender. O HTTP não chegou a começar. Também não há volta automática a `queued`, porque a varredura compartilhada já fechou o log. Reenvio automático de `uncertain` continua proibido. Uma conferência humana posterior pode existir noutro lote. Este desenho não a cria.

Timeout depois de `wire`, perda da resposta, ou morte do processo com `wire_at` preenchido: `SweepReserved` e a varredura de 10 minutos marcam `uncertain` e não chamam o sender. O attempt permanece o mesmo número. C09 cobre essa linha.

### Leitores do status novo

`skipped_settled` precisa entrar em dois literais que hoje listam status terminais, e só nesses dois.

| Leitor | Dono da edição | O que fica |
| --- | --- | --- |
| check em `notice_log`, migração de R2 | R2 | passa a aceitar `skipped_settled` |
| `69b06ce3_3.sql` | G | `skipped_settled` entra ao lado de `skipped_no_consent`, para a mesma regra e a mesma fatura não voltarem sem decisão nova |
| `b2808f33_1.sql` | G | `skipped_settled` entra na lista do `delete`. Sem isso, `radius.Purge` nunca apaga a linha. Prazo, limite 5000, `queued` e `sending` permanecem |
| `rotinas.go` | ninguém | o contador lê o `returning` de `aee9567a_3.sql`. `skipped_settled` não é valor dessa sentença |
| `readc502f577` | ninguém | conta `status = sent`. `skipped_settled` fica de fora desse número |
| `69b06ce3_1.sql` | ninguém | só atualiza `sending` |
| `import_compensate.go` | ninguém | seleciona `notice_log` por `invoice_id`, qualquer status. A linha billing `skipped_settled` continua ligada à fatura |

Até o gate, R2 grava `skipped_settled` pela própria sentença. O teste de R2 não executa `radius.Purge` e não depende do embed de retenção nem de `69b06ce3_3.sql`. O teste do gate executa o purge e falha se `b2808f33_1.sql` omitir o status. `notices.go` e `executor.go` leem a lista de arquivos desses JSON e ignoram o campo `sha256`. A fórmula desse campo não está no repositório. G edita o texto SQL e deixa o `sha256` como está. R2 não edita esses JSON.

`RecordResult` com `submitted` guarda o id e não afirma entrega. Segunda chamada com o mesmo `(notice_log_id, attempt_no)` não insere outro attempt e não chama o sender.

O journal não importa escritor de pagamento, não dá `insert` em `payments` e não chama `finance.Event`. `StatusEffect.MoneyWrites` e `Sends` são zero em todo retorno de `AcceptStatus`.

### Webhook de status

Rota futura, só no gate: `POST /api/webhooks/cloud-api/{account}`. O handler autentica e chama `AcceptStatus`. Assinatura inválida ou `Proven() == false`: rollback, zero linha em `cloud_notice_status`, zero mudança de `notice_log`, resposta de recusa. Corpo limitado a 4096 bytes. Acima disso, recusa sem gravar o corpo.

Corpo repetido com o mesmo `body_hash` no mesmo `cloud_account_id`: `Duplicate = true`, sem linha nova e sem aviso novo. Corpos diferentes do mesmo `provider_message_id`, em qualquer ordem, acrescentam observações. Nenhum deles cria `notice_log`, chama `enqueueNotices` nem altera `payments`. Status cru fica na coluna `raw_status`. O mapa sent/delivered/read não é aplicado enquanto o vocabulário oficial estiver pendente. `notice_log` não volta de `sent` para `queued`.

Conta de outro tenant não é visível sob RLS. Conta do mesmo tenant com outro `cloud_account_id` não atualiza attempt alheio: a busca do id de provedor inclui tenant e conta. Id desconhecido não cria aviso.

## Chaves

| Chave | Uso |
| --- | --- |
| `(rule_id, invoice_id)` | já existe em `notice_log` |
| `(tenant_id, id)` do claim com `skip locked` | uma réplica por linha |
| advisory `tenant:invoice:id` sal `7411005`, depois `for update` | mesma ordem dos escritores de fatura |
| `(notice_log_id, attempt_no)` | uma tentativa lógica; número seguinte depois de `not_sent` por estouro de lock, sem reabrir o número velho |
| `(tenant_id, cloud_account_id, provider_message_id)` | uma aceitação HTTP |
| `(cloud_account_id, body_hash)` | dedupe de webhook |
| `AttemptKey` local | não sai no HTTP |

Isolamento: toda sentença de R2 filtra `tenant_id` e corre em `WithScope`. Segredo de webhook é por conta. Assinatura válida da conta B não grava journal da conta A.

## DAG e donos

As raízes leem os fatos desta página e da matriz. Nenhuma espera a outra para o seu `go test`. O gate espera as duas e não é critério de aceite delas.

| Nó | Arquivos donos | Aceite | Depende |
| --- | --- | --- | --- |
| R1 cliente | `apps/api-go/internal/outbound/cloudapi/client.go`, `redact.go`, `client_test.go` | `go test -count=1 ./internal/outbound/cloudapi/` | nenhuma |
| R2 journal | `db/migrations/00079_cloud_notice_journal.sql`, `apps/api-go/internal/outbound/cloudjournal/journal.go`, `journal_test.go` | `go test -count=1 ./internal/outbound/cloudjournal/` com PostgreSQL de teste | nenhuma de R1 |
| G gate | `apps/api-go/internal/outbound/notices_cloud.go`, `apps/api-go/internal/outbound/sql/69b06ce3_3.sql`, `apps/api-go/internal/radius/sql/b2808f33_1.sql`, registro da rota de webhook, teste `notices_cloud_test.go` | `go test -count=1 -run TestCloudNoticeGate ./internal/outbound/` com PostgreSQL. O caso de retenção chama `radius.Purge` | R1 e R2 já aprovados |

`notices.go`, `message.go`, `http.go`, `delivery.go`, `integracoes.go`, `avisos.go` e a tela de canais ficam de fora de R1 e de R2. O gate chama `Message` quando o adapter é `generic_http` e chama R2+R1 quando é `cloud_api`. Adapter desconhecido falha fechado, sem HTTP. O gate não é heurística de URL.

Comandos de integração reais, futuros, fora do MVP offline de R1:

- aplicar a migração 79 num PostgreSQL descartável e contar zero linhas em `cloud_accounts`;
- `python3 tests/contrato/go_integration.py` no commit que integrar o gate, sem `-I`, quando esse commit existir. Skip por falta de `NEXO_GO_TEST_DATABASE_URL` não aprova R2 nem G. R1 não usa esse URL.

Homologação de operador, também futura e separada, sem comando que chame a Meta neste repositório: conta WABA do operador, template aprovado no gerenciador da Meta, versão Graph citada de fonte primária atual, e um envio real deliberado. O exit 0 de R1, R2 ou G não preenche esses quatro itens. O CI `40877414874` citado pela gerência para a candidata `6963214` é corrida de outra frente. Este desenho não o consulta e não o trata como homologação de WhatsApp.

## Impossibilidades

- Não há exactly-once da Meta no material verificado. O journal garante uma linha lógica por tentativa e não reenvia `uncertain` sozinho.
- Não há cancelamento do HTTP depois do commit de B. Quitação nessa janela convive com um POST que pode terminar em `submitted`.
- `messages[].id` não é confirmação de entrega ao aparelho.
- Webhook autenticado não move dinheiro e não dispara outro aviso.
- Lista vazia de versões e flag diferente de `on` produzem zero HTTP, mesmo com teste que injeta transporte: o cliente devolve antes de chamar o `RoundTripper`.

## Adendo do lote 33 — refinamentos decididos

Este adendo não reabre o histórico do lote 32. A implementação offline que o segue está desligada por padrão. Não há exactly-once externo, não há publicador automático, não há conta, não há chamada à Meta e não há homologação WABA. O CI `40877414874` continua sendo o verde da candidata `6963214`. Não cobre este lote. A base documental ancestral conferida neste clone é `f42256b558288590f8e804b558982f15651981fb`. O objeto `33f42256b` não existe neste clone.

As raízes continuam donas dos próprios arquivos. Nenhuma depende de factory de produção nem de consumidor futuro para o próprio aceite. R1 é o cliente puro. A raiz dos tipos é a única dona de `Classify` e de `MaxLockRequeues = 3`. Consentimento, máquina de envio, status, HTTP e worker permanecem em arquivos disjuntos. Este adendo não os edita.

### Última barreira

`Revalidate` reserva. O commit de `MarkWire` é a transação B e o único ponto de linearização da autorização. A não é essa barreira. Depois do commit de B o código não promete cancelar um HTTP já iniciado nem desfazer um pagamento. Quitação nessa janela convive com um POST que pode terminar em `submitted`. Morte do processo antes desse commit continua sem chamada ao sender.

### Consentimento

`ConsentBilling` e `ConsentMaintenance` relêem o contato com `FOR SHARE`, não com `FOR KEY SHARE`. O lock bloqueia `UPDATE` e `DELETE` do contato autorizado até o commit e fecha o opt-out depois da releitura e antes do commit. `allow_notices` não é coluna de chave, então `FOR KEY SHARE` não segura esse `UPDATE`.

O lock da fatura continua sendo o advisory `7411005` e só depois o `FOR UPDATE` da linha. A linha da fatura não é adquirida antes do advisory. A consulta inicial de `notice_log` pode ser só leitura. A serialização da linha vem na ordem compatível com os escritores já existentes. O orçamento local é 2 segundos, com savepoint, para o estouro não abortar a transação inteira.

### Orçamento de três estouros

`notice_log.cloud_lock_timeouts` nasce em 0 pela migração 79. Não é o contador `attempts` do enqueue. No máximo três requeues por estouro, persistidos nessa coluna. No terceiro timeout o estado é `failed`, terminal, e não há HTTP.

Estouro em A: nenhum attempt. Estouro em B: o attempt `reserved` passa a `not_sent`, o número não é reutilizado e o próximo, se houver, é o máximo já usado mais um.

### Retenção

A retenção apaga `skipped_settled`. A chave de `cloud_notice_attempts` para `notice_log` remove o attempt em cascata, para a linha expirada não ficar presa por essa FK. `cloud_notice_status` permanece append-only para a aplicação: sem `UPDATE` nem `DELETE` direto. A função de retenção autorizada pode remover o grafo de observação expirado, sem attempt vivo. Pagamentos, faturas e movimentos não entram nesse delete. O isolamento é por tenant, com RLS nas tabelas novas.

### Status não verificado

A assinatura `AcceptStatus` permanece. Produção usa `UnprovedAuthenticator`, cujo `Proven` é falso, e não instala decoder. Sem `Authenticator.Proven`, sem `Verify` aceito e sem um `StatusDecoder` da mesma instância com `DecoderProven`, a recusa acontece antes de qualquer escrita. O decoder é interface por instância: `DecodeStatus(body) (providerID, rawStatus, error)`. O falso de teste pode implementá-la. Isso não é parser de corpo, cabeçalho ou algoritmo da Meta. Não há versão Graph homologada. `BodyParams` não vazio continua recusado enquanto o esquema do corpo não estiver verificado. O corpo mínimo já citado na coleção oficial continua sendo `messaging_product=whatsapp`, `to`, `type=template` e `template.name` / `template.language.code`. A versão de fixture `v0.0` não é versão homologada.

### O que este lote não fecha

R1 tem corrida local com sender falso, sem rede. R2 e o gate G só fecham quando a gerência executar `NEXO_CLOUD_PG_REQUIRED=1` em `python3 tests/contrato/go_integration.py`, sem runner novo. Skip por falta de URL não aprova. H01, protocolo Meta, WABA, versão Graph e API real permanecem abertos. O contrato `tests/contrato/cloud_notices_contract.py` entra em `nativo.py` e não substitui esse PostgreSQL.
