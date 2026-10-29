package outbound

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/outbound/cloudapi"
	"nexoisp/api-go/internal/outbound/cloudjournal"
	"nexoisp/api-go/internal/tenancy"

	"github.com/jackc/pgx/v5"
)

// provenGraphVersions é a allowlist de produção. Ela nasce vazia: nenhuma versão
// Graph está comprovada e este arquivo não lê versão de ambiente.
func provenGraphVersions() []string {
	return nil
}

type cloudLoaded struct {
	id            string
	phoneNumberID string
	graphVersion  string
	bearer        string
	active        bool
}

type cloudRequestFactory func(account cloudLoaded, contact, attemptKey string) (cloudapi.Request, error)

// noticeSender é o caminho generic_http. Nil chama Message. O teste injeta
// uma função nesta instância e não troca URL, ambiente nem a função global.
type noticeSender func(ctx context.Context, channel jsonx.Object, phone, message string) error

// noticeClaim lê a próxima linha queued. Nil usa o claim oficial. O teste
// restringe os ids da própria fixture para não consumir fila alheia.
type noticeClaim func(ctx context.Context, tx *db.Tx, tenant string) (jsonx.Object, error)

// noticeRuntime é a instância do laço. Produção não preenche send nem claim.
type noticeRuntime struct {
	gate  cloudGate
	send  noticeSender
	claim noticeClaim
}

func productionNoticeRuntime() noticeRuntime {
	return noticeRuntime{gate: productionCloudGate()}
}

// cloudGate é a instância do worker. Produção usa provenGraphVersions vazio e
// o transporte nulo do cliente. Teste injeta allowlist e RoundTripper nesta
// cópia, sem alterar a allowlist de produção.
type cloudGate struct {
	enabled   bool
	allow     []string
	transport http.RoundTripper
	factory   cloudRequestFactory
}

func productionCloudGate() cloudGate {
	return cloudGate{
		enabled:   os.Getenv("NEXO_CLOUD_API") == "on",
		allow:     provenGraphVersions(),
		transport: nil,
		factory:   productionCloudRequest,
	}
}

// productionCloudRequest não traduz o texto do aviso em parâmetros de template.
// BodyParams permanece nulo enquanto o esquema do corpo não estiver verificado.
func productionCloudRequest(account cloudLoaded, contact, attemptKey string) (cloudapi.Request, error) {
	return cloudapi.Request{
		Version:       account.graphVersion,
		PhoneNumberID: account.phoneNumberID,
		To:            contact,
		BodyParams:    nil,
		Bearer:        account.bearer,
		AttemptKey:    attemptKey,
	}, nil
}

func noticeAdapter(channel jsonx.Object) string {
	if channel == nil {
		return ""
	}
	adapter, _ := channel.Get("adapter").(string)
	return adapter
}

// sweepNotices roda a varredura genérica de sending e, em seguida, fecha
// attempts reserved que essa varredura já deixou uncertain. Não reenvia.
func sweepNotices(ctx context.Context, tx *db.Tx, tenant string) error {
	if err := tx.Exec(ctx, RoutineSQL("runNotices", 1), tenant, 10); err != nil {
		return err
	}
	return cloudjournal.SweepReserved(ctx, tx, tenant)
}

// deliverQueuedNotices é o laço de Notices depois do enqueue. Um claim, um
// dispatch. cloud_api não passa pelo fecho genérico de status.
func deliverQueuedNotices(ctx context.Context, database *db.DB, scope tenancy.Scope, tenant string, runtime noticeRuntime, out map[string]any) error {
	sql := func(i int) string { return RoutineSQL("runNotices", i) }
	for n := 0; n < 500; n++ {
		var job jsonx.Object
		err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if runtime.claim != nil {
				var e error
				job, e = runtime.claim(ctx, tx, tenant)
				return e
			}
			rs, e := tx.Objects(ctx, sql(6), tenant)
			if len(rs) > 0 {
				job = rs[0]
			}
			return e
		})
		if err != nil {
			return err
		}
		if job == nil {
			return nil
		}
		if err = dispatchClaimedNotice(ctx, database, scope, tenant, job, runtime, out); err != nil {
			return err
		}
	}
	return nil
}

func dispatchClaimedNotice(ctx context.Context, database *db.DB, scope tenancy.Scope, tenant string, job jsonx.Object, runtime noticeRuntime, out map[string]any) error {
	channel, _ := job.Get("channel").(jsonx.Object)
	adapter := noticeAdapter(channel)
	if adapter == "cloud_api" {
		counter, err := deliverCloudNotice(ctx, database, scope, tenant, job, runtime.gate)
		if err != nil {
			return err
		}
		if counter != "" {
			out[counter] = out[counter].(int) + 1
		}
		return nil
	}
	var sendErr error
	if adapter != "" && adapter != "generic_http" {
		sendErr = errors.New("adaptador de aviso desconhecido")
	} else if channel == nil {
		sendErr = errors.New("canal de envio removido ou desativado")
	} else {
		send := runtime.send
		if send == nil {
			send = Message
		}
		sendErr = send(ctx, channel, fmt.Sprint(job.Get("contact_value")), fmt.Sprint(job.Get("message")))
	}
	status := "sent"
	var message any
	if sendErr != nil {
		status = "failed"
		message = utf16cut(sendErr.Error(), 300)
	}
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, RoutineSQL("runNotices", 7), job.Get("id"), status, message)
	}); err != nil {
		return err
	}
	counter := "sent"
	if sendErr != nil {
		counter = "failed"
	}
	out[counter] = out[counter].(int) + 1
	return nil
}

// deliverCloudNotice é A, depois B, um Send fora da transação e C.
// O commit de MarkWire é a última barreira: este arquivo não cancela HTTP nem pagamento.
// Flag desligada, conta inativa ou versão fora da allowlist fecha failed antes de A e de B.
func deliverCloudNotice(ctx context.Context, database *db.DB, scope tenancy.Scope, tenant string, job jsonx.Object, gate cloudGate) (string, error) {
	id, err := cloudNoticeID(job.Get("id"))
	if err != nil {
		return "", err
	}
	contact, _ := job.Get("contact_value").(string)
	channel, _ := job.Get("channel").(jsonx.Object)
	accountID, _ := channel.Get("cloud_account_id").(string)
	if gate.factory == nil {
		gate.factory = productionCloudRequest
	}

	var (
		account cloudLoaded
		reason  string
	)
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		loaded, loadErr := loadCloudAccount(ctx, tx, tenant, accountID)
		if loadErr != nil {
			return loadErr
		}
		reason = cloudRefusal(gate, loaded)
		if reason != "" {
			return closeCloudNotice(ctx, tx, id, reason)
		}
		plain, decErr := cryptox.DecryptSecret(loaded.bearer)
		if decErr != nil {
			reason = "segredo cloud ilegível"
			return closeCloudNotice(ctx, tx, id, reason)
		}
		loaded.bearer = plain
		preview, previewErr := gate.factory(loaded, contact, "")
		if previewErr != nil || cloudRequestBlocked(preview) {
			reason = "template cloud não verificado"
			return closeCloudNotice(ctx, tx, id, reason)
		}
		account = loaded
		return nil
	})
	if err != nil {
		return "", err
	}
	if reason != "" {
		return "failed", nil
	}

	var decision cloudjournal.Decision
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var callErr error
		decision, callErr = cloudjournal.Revalidate(ctx, tx, tenant, id)
		return callErr
	})
	if err != nil {
		return "", err
	}
	if decision != cloudjournal.DecisionSend {
		return cloudTerminalCounter(ctx, database, scope, id)
	}

	var attemptNo int
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var callErr error
		decision, callErr = cloudjournal.MarkWire(ctx, tx, tenant, id)
		if callErr != nil || decision != cloudjournal.DecisionSend {
			return callErr
		}
		return tx.QueryRow(ctx, `
			select attempt_no
			from cloud_notice_attempts
			where notice_log_id = $1 and tenant_id = app_tenant() and state = 'wire'
			order by attempt_no desc
			limit 1`, id).Scan(&attemptNo)
	})
	if err != nil {
		return "", err
	}
	if decision != cloudjournal.DecisionSend {
		return cloudTerminalCounter(ctx, database, scope, id)
	}

	client, err := cloudapi.New(cloudapi.Config{
		Enabled:       gate.enabled,
		AllowVersions: append([]string{}, gate.allow...),
		Transport:     gate.transport,
	})
	if err != nil {
		return "", err
	}
	request, err := gate.factory(account, contact, fmt.Sprintf("%s:%d:%d", tenant, id, attemptNo))
	if err != nil || cloudRequestBlocked(request) {
		return "", errors.New("template cloud não verificado")
	}
	result, sendErr := client.Send(ctx, request)
	refused := result.Refused
	uncertain := result.Uncertain
	if sendErr != nil && !result.Submitted && !uncertain && !refused {
		refused = true
	}
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		return cloudjournal.RecordResult(ctx, tx, tenant, id, result.HTTPStatus, result.ProviderMessageID, uncertain, refused, "")
	})
	if err != nil {
		return "", err
	}
	return cloudTerminalCounter(ctx, database, scope, id)
}

func cloudRefusal(gate cloudGate, account cloudLoaded) string {
	if !gate.enabled {
		return "cloud api desligada"
	}
	if account.id == "" || !account.active {
		return "conta cloud inativa"
	}
	if !cloudVersionAllowed(gate.allow, account.graphVersion) {
		return "versão graph não comprovada"
	}
	return ""
}

func cloudVersionAllowed(allow []string, version string) bool {
	if version == "" {
		return false
	}
	for _, item := range allow {
		if item == version {
			return true
		}
	}
	return false
}

func cloudRequestBlocked(request cloudapi.Request) bool {
	return len(request.BodyParams) > 0 || strings.TrimSpace(request.TemplateName) == "" || strings.TrimSpace(request.TemplateLang) == "" || strings.TrimSpace(request.To) == "" || strings.TrimSpace(request.Bearer) == ""
}

func loadCloudAccount(ctx context.Context, tx *db.Tx, tenant, accountID string) (cloudLoaded, error) {
	if strings.TrimSpace(accountID) == "" {
		return cloudLoaded{}, nil
	}
	var row cloudLoaded
	err := tx.QueryRow(ctx, `
		select id::text, phone_number_id, graph_version, token_enc, active
		from cloud_accounts
		where id = $1::uuid and tenant_id = app_tenant() and tenant_id = $2::uuid`, accountID, tenant).Scan(
		&row.id, &row.phoneNumberID, &row.graphVersion, &row.bearer, &row.active)
	if errors.Is(err, pgx.ErrNoRows) {
		return cloudLoaded{}, nil
	}
	if err != nil {
		return cloudLoaded{}, err
	}
	return row, nil
}

func closeCloudNotice(ctx context.Context, tx *db.Tx, id int64, reason string) error {
	n, err := tx.Affected(ctx, `
		update notice_log
		set status = 'failed', error = $2, message = null
		where id = $1 and tenant_id = app_tenant() and status = 'sending'`, id, utf16cut(reason, 300))
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("aviso cloud fora de sending")
	}
	return nil
}

func cloudTerminalCounter(ctx context.Context, database *db.DB, scope tenancy.Scope, id int64) (string, error) {
	var status string
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status from notice_log where id = $1 and tenant_id = app_tenant()`, id).Scan(&status)
	})
	if err != nil {
		return "", err
	}
	if status == "sending" {
		return "", errors.New("aviso cloud sem desfecho")
	}
	return cloudOutCounter(status), nil
}

func cloudOutCounter(status string) string {
	switch status {
	case "sent":
		return "sent"
	case "skipped_no_consent", "skipped_settled":
		return "skipped"
	case "queued":
		return ""
	default:
		return "failed"
	}
}

func cloudNoticeID(v any) (int64, error) {
	switch n := v.(type) {
	case float64:
		if n <= 0 || n != float64(int64(n)) {
			return 0, errors.New("aviso cloud inválido")
		}
		return int64(n), nil
	case int64:
		if n <= 0 {
			return 0, errors.New("aviso cloud inválido")
		}
		return n, nil
	case int32:
		if n <= 0 {
			return 0, errors.New("aviso cloud inválido")
		}
		return int64(n), nil
	default:
		return 0, errors.New("aviso cloud inválido")
	}
}
