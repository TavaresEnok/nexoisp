// Máquina de envio do journal Cloud API. Não chama rede, não importa o cliente
// HTTP e não grava pagamento, fatura nem evento financeiro.
// O commit de MarkWire é a última barreira: um POST já iniciado depois dele não é recolhido.
package cloudjournal

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf16"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	// sweepMinutes é a mesma janela da varredura genérica de sending. Este arquivo não altera o SQL dela.
	sweepMinutes = 10
	// lockBudget é o teto local do ramo billing. O savepoint impede que o estouro aborte a transação.
	lockBudget = "2s"
	// interruptedError é a frase já usada pela varredura genérica. Não reenfileira uncertain.
	interruptedError = "envio interrompido: não se sabe se a mensagem chegou; confira antes de reenviar"
)

const loadNoticeSQL = `
select l.status,
       coalesce(l.invoice_id::text, ''),
       coalesce(l.maintenance_notice_id::text, ''),
       coalesce(l.subscriber_id::text, ''),
       coalesce(l.contact_value, ''),
       l.cloud_lock_timeouts,
       coalesce(ch.adapter, ''),
       coalesce(ch.active, false),
       coalesce(ca.id::text, ''),
       coalesce(ca.active, false)
from notice_log l
left join notice_channels ch on ch.id = l.channel_id and ch.tenant_id = l.tenant_id
left join cloud_accounts ca on ca.id = ch.cloud_account_id and ca.tenant_id = ch.tenant_id
where l.id = $1 and l.tenant_id = app_tenant() and l.tenant_id = $2::uuid`

// payableSQL lê o saldo depois do lock. Não leva for update: a linha já entrou por finance.LockInvoices.
const payableSQL = `
select i.status = 'open'
   and (i.amount_cents + i.fee_cents - i.discount_cents
        - coalesce((select sum(p.signed_cents) from payments p where p.invoice_id = i.id and p.tenant_id = i.tenant_id), 0)) > 0
from invoices i
where i.tenant_id = app_tenant() and i.tenant_id = $1::uuid and i.id = $2::uuid`

const sweepLogSQL = `
update notice_log l
set status = 'uncertain', message = null, error = $3
where l.tenant_id = app_tenant()
  and l.tenant_id = $1::uuid
  and l.status = 'sending'
  and exists (
    select 1 from cloud_notice_attempts a
    where a.tenant_id = l.tenant_id
      and a.notice_log_id = l.id
      and a.state = 'wire'
      and a.wire_at < now() - make_interval(mins => $2::int)
  )`

const sweepWireSQL = `
update cloud_notice_attempts a
set state = 'uncertain'
where a.tenant_id = app_tenant()
  and a.tenant_id = $1::uuid
  and a.state = 'wire'
  and (
    a.wire_at < now() - make_interval(mins => $2::int)
    or exists (
      select 1 from notice_log l
      where l.tenant_id = a.tenant_id and l.id = a.notice_log_id and l.status = 'uncertain'
    )
  )`

const sweepReservedSQL = `
update cloud_notice_attempts a
set state = 'not_sent'
where a.tenant_id = app_tenant()
  and a.tenant_id = $1::uuid
  and a.state = 'reserved'
  and a.wire_at is null
  and exists (
    select 1 from notice_log l
    where l.tenant_id = a.tenant_id and l.id = a.notice_log_id and l.status = 'uncertain'
  )`

var (
	errChannel    = errors.New("cloudjournal: canal cloud_api não verificado")
	errInactive   = errors.New("cloudjournal: conta cloud inativa")
	errNotSending = errors.New("cloudjournal: notice_log não está sending")
	errNoAttempt  = errors.New("cloudjournal: attempt ausente")
	errTerminal   = errors.New("cloudjournal: estado terminal não é reescrito")
	errNoResend   = errors.New("cloudjournal: reenvio de uncertain ou sent é proibido")
	errResult     = errors.New("cloudjournal: resultado contraditório")
)

type noticeRow struct {
	id            int64
	status        string
	invoice       string
	maintenance   string
	subscriber    string
	contact       string
	timeouts      int
	adapter       string
	channelActive bool
	accountID     string
	accountActive bool
}

type billingView struct {
	consent bool
	payable bool
}

// Revalidate é a transação A. Reserva attempt_no novo ou fecha sem HTTP.
func Revalidate(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64) (Decision, error) {
	row, kind, err := prepare(ctx, tx, tenant, noticeLogID)
	if err != nil {
		return "", err
	}
	if row.status != "sending" {
		return terminalDecision(row.status, row.timeouts, kind)
	}
	open, err := openAttempt(ctx, tx, row.id)
	if err != nil {
		return "", err
	}
	if open {
		return DecisionSend, nil
	}
	if row.timeouts >= MaxLockRequeues {
		return failLockBudget(ctx, tx, row.id)
	}
	switch kind {
	case LogKindBilling:
		return revalidateBilling(ctx, tx, tenant, row)
	case LogKindMaintenance:
		return revalidateMaintenance(ctx, tx, tenant, row)
	default:
		if _, _, err = lockNotice(ctx, tx, row.id); err != nil {
			return "", err
		}
		open, err = openAttempt(ctx, tx, row.id)
		if err != nil {
			return "", err
		}
		if open {
			return DecisionSend, nil
		}
		return finishNotSent(ctx, tx, row, "failed", "aviso fora de cobrança e manutenção", DecisionIneligible)
	}
}

// MarkWire é a transação B e o ponto de linearização. Depois do commit, o HTTP em voo não é desfeito.
func MarkWire(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64) (Decision, error) {
	row, kind, err := prepare(ctx, tx, tenant, noticeLogID)
	if err != nil {
		return "", err
	}
	if row.status != "sending" {
		return terminalDecision(row.status, row.timeouts, kind)
	}
	state, ok, err := latestState(ctx, tx, row.id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errNoAttempt
	}
	if state == "wire" {
		return DecisionSend, nil
	}
	if state != "reserved" {
		return "", errNoAttempt
	}
	switch kind {
	case LogKindBilling:
		return markBilling(ctx, tx, tenant, row)
	case LogKindMaintenance:
		return markMaintenance(ctx, tx, tenant, row)
	default:
		if err = closeReserved(ctx, tx, row.id); err != nil {
			return "", err
		}
		if err = setLog(ctx, tx, row.id, "failed", "aviso fora de cobrança e manutenção", true); err != nil {
			return "", err
		}
		return DecisionIneligible, nil
	}
}

// RecordResult é a transação C. Só grava se o log segue sending e o attempt segue wire.
// Excerpt do provedor não é armazenado: a coluna fica com a classificação estável.
func RecordResult(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64, httpStatus int, providerMessageID string, uncertain, refused bool, excerpt string) error {
	_ = excerpt
	if err := sameTenant(ctx, tx, tenant); err != nil {
		return err
	}
	state, logStatus, providerID, status, err := classifyResult(httpStatus, providerMessageID, uncertain, refused)
	if err != nil {
		return err
	}
	var currentLog, currentState string
	err = tx.QueryRow(ctx, `
		select l.status, a.state
		from notice_log l
		join cloud_notice_attempts a on a.notice_log_id = l.id and a.tenant_id = l.tenant_id
		where l.id = $1 and l.tenant_id = app_tenant() and l.tenant_id = $2::uuid
		order by a.attempt_no desc
		limit 1
		for update of l, a`, noticeLogID, tenant).Scan(&currentLog, &currentState)
	if errors.Is(err, pgx.ErrNoRows) {
		return errNoAttempt
	}
	if err != nil {
		return err
	}
	if currentState == state && currentLog == logStatus {
		return nil
	}
	if currentState != "wire" || currentLog != "sending" {
		return errTerminal
	}
	var http any
	if status != 0 {
		http = status
	}
	var provider any
	if providerID != "" {
		provider = providerID
	}
	var errorText any
	switch state {
	case "refused":
		errorText = "recusado"
	case "uncertain":
		errorText = "incerto"
	}
	n, err := tx.Affected(ctx, `
		update cloud_notice_attempts
		set state = $3, http_status = $4, provider_message_id = $5, excerpt = $6
		where notice_log_id = $1 and tenant_id = app_tenant() and tenant_id = $2::uuid and state = 'wire'`,
		noticeLogID, tenant, state, http, provider, cutUTF16(state, 300))
	if err != nil {
		return err
	}
	if n != 1 {
		return errNoAttempt
	}
	return setLog(ctx, tx, noticeLogID, logStatus, textOrEmpty(errorText), true)
}

// SweepReserved fecha attempt reserved cujo log a varredura de 10 minutos já marcou uncertain,
// e fecha wire antigo como uncertain. Não reenfileira e não cria attempt_no.
func SweepReserved(ctx context.Context, tx *db.Tx, tenant string) error {
	if err := sameTenant(ctx, tx, tenant); err != nil {
		return err
	}
	if err := tx.Exec(ctx, sweepLogSQL, tenant, sweepMinutes, interruptedError); err != nil {
		return err
	}
	if err := tx.Exec(ctx, sweepWireSQL, tenant, sweepMinutes); err != nil {
		return err
	}
	return tx.Exec(ctx, sweepReservedSQL, tenant)
}

func prepare(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64) (noticeRow, LogKind, error) {
	if err := sameTenant(ctx, tx, tenant); err != nil {
		return noticeRow{}, "", err
	}
	row, err := loadNotice(ctx, tx, tenant, noticeLogID)
	if err != nil {
		return noticeRow{}, "", err
	}
	if err = verifyAccount(row); err != nil {
		return noticeRow{}, "", err
	}
	return row, Classify(row.invoice, row.maintenance), nil
}

func loadNotice(ctx context.Context, tx *db.Tx, tenant string, noticeLogID int64) (noticeRow, error) {
	var row noticeRow
	row.id = noticeLogID
	err := tx.QueryRow(ctx, loadNoticeSQL, noticeLogID, tenant).Scan(
		&row.status, &row.invoice, &row.maintenance, &row.subscriber, &row.contact,
		&row.timeouts, &row.adapter, &row.channelActive, &row.accountID, &row.accountActive,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return noticeRow{}, fmt.Errorf("cloudjournal: aviso inexistente no tenant")
	}
	return row, err
}

func verifyAccount(row noticeRow) error {
	if row.adapter != "cloud_api" || row.accountID == "" || !row.channelActive {
		return errChannel
	}
	if !row.accountActive {
		return errInactive
	}
	return nil
}

func revalidateBilling(ctx context.Context, tx *db.Tx, tenant string, row noticeRow) (Decision, error) {
	view, timedOut, err := lockBilling(ctx, tx, tenant, row)
	if err != nil {
		return "", err
	}
	if timedOut {
		return noteLockTimeout(ctx, tx, row.id, false)
	}
	return decideBilling(ctx, tx, row, view, false)
}

func markBilling(ctx context.Context, tx *db.Tx, tenant string, row noticeRow) (Decision, error) {
	view, timedOut, err := lockBilling(ctx, tx, tenant, row)
	if err != nil {
		return "", err
	}
	if timedOut {
		return noteLockTimeout(ctx, tx, row.id, true)
	}
	return decideBilling(ctx, tx, row, view, true)
}

func decideBilling(ctx context.Context, tx *db.Tx, row noticeRow, view billingView, wire bool) (Decision, error) {
	status, _, err := lockNotice(ctx, tx, row.id)
	if err != nil {
		return "", err
	}
	if status != "sending" {
		return terminalDecision(status, row.timeouts, LogKindBilling)
	}
	if !wire {
		open, err := openAttempt(ctx, tx, row.id)
		if err != nil {
			return "", err
		}
		if open {
			return DecisionSend, nil
		}
	}
	if !view.consent {
		return closeOrInsert(ctx, tx, row, wire, "skipped_no_consent", "sem consentimento", DecisionOptOut)
	}
	if !view.payable {
		return closeOrInsert(ctx, tx, row, wire, "skipped_settled", "fatura não pagável", DecisionSettled)
	}
	if wire {
		if err = setWire(ctx, tx, row.id); err != nil {
			return "", err
		}
		return DecisionSend, nil
	}
	if _, err = insertAttempt(ctx, tx, row.accountID, row.id, "reserved"); err != nil {
		return "", err
	}
	return DecisionSend, nil
}

func revalidateMaintenance(ctx context.Context, tx *db.Tx, tenant string, row noticeRow) (Decision, error) {
	ok, err := consentOf(ctx, tx, tenant, row, false)
	if err != nil {
		return "", err
	}
	status, _, err := lockNotice(ctx, tx, row.id)
	if err != nil {
		return "", err
	}
	if status != "sending" {
		return terminalDecision(status, row.timeouts, LogKindMaintenance)
	}
	open, err := openAttempt(ctx, tx, row.id)
	if err != nil {
		return "", err
	}
	if open {
		return DecisionSend, nil
	}
	if !ok {
		return finishNotSent(ctx, tx, row, "skipped_no_consent", "sem consentimento", DecisionOptOut)
	}
	if _, err = insertAttempt(ctx, tx, row.accountID, row.id, "reserved"); err != nil {
		return "", err
	}
	return DecisionSend, nil
}

func markMaintenance(ctx context.Context, tx *db.Tx, tenant string, row noticeRow) (Decision, error) {
	ok, err := consentOf(ctx, tx, tenant, row, false)
	if err != nil {
		return "", err
	}
	status, _, err := lockNotice(ctx, tx, row.id)
	if err != nil {
		return "", err
	}
	if status != "sending" {
		return terminalDecision(status, row.timeouts, LogKindMaintenance)
	}
	if !ok {
		if err = closeReserved(ctx, tx, row.id); err != nil {
			return "", err
		}
		if err = setLog(ctx, tx, row.id, "skipped_no_consent", "sem consentimento", true); err != nil {
			return "", err
		}
		return DecisionOptOut, nil
	}
	if err = setWire(ctx, tx, row.id); err != nil {
		return "", err
	}
	return DecisionSend, nil
}

func consentOf(ctx context.Context, tx *db.Tx, tenant string, row noticeRow, billing bool) (bool, error) {
	if row.subscriber == "" || row.contact == "" {
		return false, nil
	}
	if billing {
		return ConsentBilling(ctx, tx, tenant, row.subscriber, row.contact)
	}
	return ConsentMaintenance(ctx, tx, tenant, row.subscriber, row.contact)
}

// lockBilling segura advisory 7411005, a linha da fatura e o FOR SHARE do contato, nesta ordem.
// O savepoint devolve o lock_timeout anterior quando o orçamento de 2s estoura.
func lockBilling(ctx context.Context, tx *db.Tx, tenant string, row noticeRow) (billingView, bool, error) {
	var previous string
	if err := tx.QueryRow(ctx, `select current_setting('lock_timeout')`).Scan(&previous); err != nil {
		return billingView{}, false, err
	}
	if err := tx.Exec(ctx, `savepoint cloud_journal_lock`); err != nil {
		return billingView{}, false, err
	}
	restore := func(rollback bool) error {
		stmt := `release savepoint cloud_journal_lock`
		if rollback {
			if err := tx.Exec(ctx, `rollback to savepoint cloud_journal_lock`); err != nil {
				return err
			}
		}
		if err := tx.Exec(ctx, stmt); err != nil {
			return err
		}
		return tx.Exec(ctx, `select set_config('lock_timeout', $1, true)`, previous)
	}
	if err := tx.Exec(ctx, `select set_config('lock_timeout', $1, true)`, lockBudget); err != nil {
		if rb := restore(true); rb != nil {
			return billingView{}, false, rb
		}
		return billingView{}, false, err
	}
	if err := finance.LockInvoices(ctx, tx, tenant, row.invoice); err != nil {
		return finishLockErr(err, restore)
	}
	var view billingView
	var err error
	view.consent, err = consentOf(ctx, tx, tenant, row, true)
	if err != nil {
		return finishLockErr(err, restore)
	}
	view.payable, err = invoicePayable(ctx, tx, tenant, row.invoice)
	if err != nil {
		return finishLockErr(err, restore)
	}
	if err = restore(false); err != nil {
		return billingView{}, false, err
	}
	return view, false, nil
}

func finishLockErr(err error, restore func(bool) error) (billingView, bool, error) {
	timedOut := isLockTimeout(err)
	if rb := restore(true); rb != nil {
		return billingView{}, false, rb
	}
	if timedOut {
		return billingView{}, true, nil
	}
	return billingView{}, false, err
}

func invoicePayable(ctx context.Context, tx *db.Tx, tenant, invoiceID string) (bool, error) {
	var payable bool
	err := tx.QueryRow(ctx, payableSQL, tenant, invoiceID).Scan(&payable)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return payable, err
}

func noteLockTimeout(ctx context.Context, tx *db.Tx, noticeLogID int64, closeOpen bool) (Decision, error) {
	if closeOpen {
		if err := closeReserved(ctx, tx, noticeLogID); err != nil {
			return "", err
		}
	}
	var status string
	err := tx.QueryRow(ctx, `
		update notice_log
		set cloud_lock_timeouts = cloud_lock_timeouts + 1,
		    status = case when cloud_lock_timeouts + 1 >= $2 then 'failed' else 'queued' end,
		    message = case when cloud_lock_timeouts + 1 >= $2 then null else message end,
		    error = 'lock de fatura estourou'
		where id = $1 and tenant_id = app_tenant() and status = 'sending' and cloud_lock_timeouts < $2
		returning status`, noticeLogID, MaxLockRequeues).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotSending
	}
	if err != nil {
		return "", err
	}
	return DecisionLockTimeout, nil
}

func failLockBudget(ctx context.Context, tx *db.Tx, noticeLogID int64) (Decision, error) {
	status, timeouts, err := lockNotice(ctx, tx, noticeLogID)
	if err != nil {
		return "", err
	}
	if status != "sending" {
		return terminalDecision(status, timeouts, LogKindBilling)
	}
	if err = setLog(ctx, tx, noticeLogID, "failed", "lock de fatura estourou", true); err != nil {
		return "", err
	}
	return DecisionLockTimeout, nil
}

func closeOrInsert(ctx context.Context, tx *db.Tx, row noticeRow, wire bool, status, errorText string, decision Decision) (Decision, error) {
	if wire {
		if err := closeReserved(ctx, tx, row.id); err != nil {
			return "", err
		}
		if err := setLog(ctx, tx, row.id, status, errorText, true); err != nil {
			return "", err
		}
		return decision, nil
	}
	return finishNotSent(ctx, tx, row, status, errorText, decision)
}

func finishNotSent(ctx context.Context, tx *db.Tx, row noticeRow, status, errorText string, decision Decision) (Decision, error) {
	if _, err := insertAttempt(ctx, tx, row.accountID, row.id, "not_sent"); err != nil {
		return "", err
	}
	if err := setLog(ctx, tx, row.id, status, errorText, true); err != nil {
		return "", err
	}
	return decision, nil
}

func insertAttempt(ctx context.Context, tx *db.Tx, accountID string, noticeLogID int64, state string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		insert into cloud_notice_attempts (tenant_id, cloud_account_id, notice_log_id, attempt_no, state)
		select app_tenant(), $1::uuid, $2::bigint,
		       coalesce((select max(attempt_no) from cloud_notice_attempts where notice_log_id = $2::bigint and tenant_id = app_tenant()), 0) + 1,
		       $3
		returning attempt_no`, accountID, noticeLogID, state).Scan(&n)
	return n, err
}

func closeReserved(ctx context.Context, tx *db.Tx, noticeLogID int64) error {
	n, err := tx.Affected(ctx, `
		update cloud_notice_attempts
		set state = 'not_sent'
		where notice_log_id = $1 and tenant_id = app_tenant() and state = 'reserved' and wire_at is null`, noticeLogID)
	if err != nil {
		return err
	}
	if n != 1 {
		return errNoAttempt
	}
	return nil
}

func setWire(ctx context.Context, tx *db.Tx, noticeLogID int64) error {
	n, err := tx.Affected(ctx, `
		update cloud_notice_attempts
		set state = 'wire', wire_at = now()
		where notice_log_id = $1 and tenant_id = app_tenant() and state = 'reserved' and wire_at is null`, noticeLogID)
	if err != nil {
		return err
	}
	if n != 1 {
		return errNoAttempt
	}
	return nil
}

func setLog(ctx context.Context, tx *db.Tx, noticeLogID int64, status, errorText string, clearMessage bool) error {
	var errText any
	if errorText != "" {
		errText = errorText
	}
	n, err := tx.Affected(ctx, `
		update notice_log
		set status = $2,
		    error = $3,
		    message = case when $4 then null else message end
		where id = $1 and tenant_id = app_tenant() and status = 'sending'`, noticeLogID, status, errText, clearMessage)
	if err != nil {
		return err
	}
	if n != 1 {
		return errNotSending
	}
	return nil
}

func lockNotice(ctx context.Context, tx *db.Tx, noticeLogID int64) (string, int, error) {
	var status string
	var timeouts int
	err := tx.QueryRow(ctx, `
		select status, cloud_lock_timeouts
		from notice_log
		where id = $1 and tenant_id = app_tenant()
		for update`, noticeLogID).Scan(&status, &timeouts)
	return status, timeouts, err
}

func openAttempt(ctx context.Context, tx *db.Tx, noticeLogID int64) (bool, error) {
	state, ok, err := latestState(ctx, tx, noticeLogID)
	if err != nil || !ok {
		return false, err
	}
	return state == "reserved" || state == "wire", nil
}

func latestState(ctx context.Context, tx *db.Tx, noticeLogID int64) (string, bool, error) {
	var state string
	err := tx.QueryRow(ctx, `
		select state
		from cloud_notice_attempts
		where notice_log_id = $1 and tenant_id = app_tenant()
		order by attempt_no desc
		limit 1`, noticeLogID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	return state, err == nil, err
}

func terminalDecision(status string, timeouts int, kind LogKind) (Decision, error) {
	switch status {
	case "skipped_no_consent":
		return DecisionOptOut, nil
	case "skipped_settled":
		return DecisionSettled, nil
	case "failed":
		if timeouts >= MaxLockRequeues {
			return DecisionLockTimeout, nil
		}
		if kind == LogKindOther {
			return DecisionIneligible, nil
		}
		return "", errTerminal
	case "uncertain", "sent":
		return "", errNoResend
	default:
		return "", errNotSending
	}
}

func classifyResult(httpStatus int, providerMessageID string, uncertain, refused bool) (state, logStatus, providerID string, status int, err error) {
	providerID = trim(providerMessageID)
	if uncertain && refused {
		return "", "", "", 0, errResult
	}
	if providerID != "" && (uncertain || refused) {
		return "", "", "", 0, errResult
	}
	if len(providerID) > 128 {
		return "", "", "", 0, errResult
	}
	status = httpStatus
	if status != 0 && (status < 100 || status > 599) {
		return "", "", "", 0, errResult
	}
	switch {
	case refused:
		// Redirects explicitly refused by the client are terminal too. A bare
		// 3xx without that classification still falls through to errResult.
		if status != 0 && (status < 300 || status > 499) {
			return "", "", "", 0, errResult
		}
		return "refused", "failed", "", status, nil
	case uncertain:
		if status >= 400 && status <= 499 {
			return "", "", "", 0, errResult
		}
		if status >= 200 && status <= 299 && providerID != "" {
			return "", "", "", 0, errResult
		}
		return "uncertain", "uncertain", "", status, nil
	case status >= 200 && status <= 299 && providerID != "":
		return "submitted", "sent", providerID, status, nil
	case status >= 200 && status <= 299:
		return "uncertain", "uncertain", "", status, nil
	case status == 429 || (status >= 400 && status <= 499):
		return "refused", "failed", "", status, nil
	case status >= 500 && status <= 599:
		return "uncertain", "uncertain", "", status, nil
	default:
		return "", "", "", 0, errResult
	}
}

func trim(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\n' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\n' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

func textOrEmpty(v any) string {
	s, _ := v.(string)
	return s
}

func cutUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func sameTenant(ctx context.Context, tx *db.Tx, tenant string) error {
	if tenant == "" {
		return fmt.Errorf("cloudjournal: tenant e assinante precisam ser explícitos")
	}
	var scope string
	if err := tx.QueryRow(ctx, `select coalesce(app_tenant()::text, '')`).Scan(&scope); err != nil {
		return err
	}
	if scope == "" || scope != tenant {
		return fmt.Errorf("cloudjournal: app_tenant incompatível com o tenant informado")
	}
	return nil
}

func isLockTimeout(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "55P03"
}
