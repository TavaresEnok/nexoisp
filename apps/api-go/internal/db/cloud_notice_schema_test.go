package db_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"nexoisp/api-go/internal/outbound/cloudjournal"
)

func TestCsSchemaMigrationContract(t *testing.T) {
	text := csSchemaMigration(t)
	up, down, ok := strings.Cut(text, "-- +goose Down")
	if !ok {
		t.Fatal("migração sem Down")
	}
	lowerUp := strings.ToLower(up)
	for _, forbidden := range []string{
		"insert into",
		"delete from notice_log",
		"delete from public.notice_log",
		"delete from payments",
		"delete from invoices",
		"delete from invoice_movements",
		"truncate ",
		"drop table",
		"grant all",
		"grant delete",
		"grant update on cloud_notice_status",
		"headers_enc",
		"graph.facebook",
	} {
		if strings.Contains(lowerUp, forbidden) {
			t.Fatalf("up altera histórico, header genérico ou amplia grant: %s", forbidden)
		}
	}
	if strings.Count(lowerUp, "delete from") != 1 || !strings.Contains(lowerUp, "delete from public.cloud_notice_status") {
		t.Fatal("o único delete do up é a exceção de retenção do status")
	}
	for _, required := range []string{
		"create table cloud_accounts",
		"create table cloud_notice_attempts",
		"create table cloud_notice_status",
		"active boolean not null default false",
		"constraint cloud_accounts_token_v1_ck check (token_enc like 'v1.%')",
		"constraint cloud_accounts_webhook_v1_ck check (webhook_secret_enc like 'v1.%')",
		"'skipped_settled'",
		"cloud_lock_timeouts integer not null default 0",
		"cloud_lock_timeouts between 0 and 3",
		"default 'generic_http'",
		"adapter in ('generic_http', 'cloud_api')",
		"on delete cascade",
		"unique (tenant_id, id)",
		"unique (tenant_id, phone_number_id)",
		"unique (notice_log_id, attempt_no)",
		"unique (tenant_id, cloud_account_id, body_hash)",
		"where provider_message_id is not null",
		"using (tenant_id = app_tenant())",
		"app_subscriber() is null",
		"grant select, insert, update on cloud_accounts to nexo_app",
		"grant select, insert, update on cloud_notice_attempts to nexo_app",
		"grant select, insert on cloud_notice_status to nexo_app",
		"cloud_notice_retain_expired",
		"cloud notice status is append-only",
		"foreign key (tenant_id, notice_log_id) references notice_log (tenant_id, id) on delete cascade",
		"foreign key (tenant_id, cloud_account_id) references cloud_accounts (tenant_id, id)",
	} {
		if !strings.Contains(up, required) {
			t.Fatalf("up sem %s", required)
		}
	}
	if cloudjournal.MaxLockRequeues != 3 || !strings.Contains(up, "between 0 and 3") {
		t.Fatal("teto de cloud_lock_timeouts divergiu de MaxLockRequeues")
	}
	lowerDown := strings.ToLower(down)
	for _, forbidden := range []string{
		"delete from",
		"truncate ",
		"drop table notice_log",
		"drop table payments",
		"drop table invoices",
		"drop table invoice_movements",
	} {
		if strings.Contains(lowerDown, forbidden) {
			t.Fatalf("down apagaria histórico: %s", forbidden)
		}
	}
	if !strings.Contains(down, "Preserve cloud notice journal history; do not delete notice or financial history") {
		t.Fatal("down não recusa a perda do journal")
	}
	fkAt := strings.Index(lowerDown, "drop constraint if exists notice_channels_cloud_account_fk")
	accountCkAt := strings.Index(lowerDown, "drop constraint if exists notice_channels_adapter_account_ck")
	adapterCkAt := strings.Index(lowerDown, "drop constraint if exists notice_channels_adapter_ck;")
	columnAt := strings.Index(lowerDown, "drop column if exists cloud_account_id")
	dropAccountsAt := strings.Index(lowerDown, "drop table if exists cloud_accounts")
	if fkAt < 0 || accountCkAt < 0 || adapterCkAt < 0 || columnAt < 0 || dropAccountsAt < 0 ||
		fkAt > dropAccountsAt || accountCkAt > dropAccountsAt || adapterCkAt > dropAccountsAt || columnAt > dropAccountsAt {
		t.Fatal("down precisa soltar a FK e as colunas de notice_channels antes de dropar cloud_accounts")
	}
	for _, leaked := range []string{"postgres://", "postgresql://", "password=", "EAA"} {
		if strings.Contains(text, leaked) {
			t.Fatalf("migração contém segredo ou URL: %s", leaked)
		}
	}
}

func TestCsSchemaDBGuard(t *testing.T) {
	skip, fail := csSchemaDBGuard("", "", "", "")
	if !skip || !strings.Contains(fail, "não é teste de banco aprovado") {
		t.Fatalf("skip sem URL não ficou explícito: skip=%v fail=%s", skip, fail)
	}
	skip, fail = csSchemaDBGuard("", "app", "owner", "1")
	if skip || !strings.Contains(fail, "não aprova a migração 79") {
		t.Fatalf("REQUIRED=1 sem URL deveria falhar: skip=%v fail=%s", skip, fail)
	}
	skip, fail = csSchemaDBGuard("runtime", "runtime", "owner", "")
	if skip || !strings.Contains(fail, "conexões distintas") {
		t.Fatalf("URLs iguais: skip=%v fail=%s", skip, fail)
	}
	skip, fail = csSchemaDBGuard("runtime", "app", "owner", "1")
	if skip || fail != "" {
		t.Fatalf("URLs presentes: skip=%v fail=%s", skip, fail)
	}
}

func TestCsSchemaPhysical(t *testing.T) {
	runtimeDSN := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	appDSN := os.Getenv("DATABASE_URL_APP")
	ownerDSN := os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	required := os.Getenv("NEXO_CLOUD_PG_REQUIRED")
	skip, fail := csSchemaDBGuard(runtimeDSN, appDSN, ownerDSN, required)
	if fail != "" {
		if skip {
			t.Skip(fail)
		}
		t.Fatal(fail)
	}
	runtime := csSchemaConnect(t, runtimeDSN)
	app := csSchemaConnect(t, appDSN)
	owner := csSchemaConnect(t, ownerDSN)
	csSchemaAssertSession(t, runtime, "nexo_go", true)
	csSchemaAssertSession(t, app, "nexo_app", true)
	csSchemaAssertSession(t, owner, "nexo_owner", false)

	ctx := context.Background()
	tx, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	defer func() { _ = tx.Rollback(ctx) }()

	text := csSchemaMigration(t)
	upText, downText, _ := strings.Cut(text, "-- +goose Down")
	upSQL := csSchemaStatement(t, upText)
	downSQL := csSchemaStatement(t, downText)

	var ready bool
	if err = tx.QueryRow(ctx, `select to_regclass('public.cloud_accounts') is not null`).Scan(&ready); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if !ready {
		csSchemaExec(t, tx, upSQL)
	}
	paymentsBefore, invoicesBefore, movementsBefore := csSchemaMoney(t, tx)
	if csSchemaHistory(t, tx) == 0 {
		tenant := uuid.NewString()
		csSchemaExec(t, tx, `insert into tenants(id, name, slug) values($1, 'Synthetic cloud notice', $2)`, tenant, csSchemaSlug("cs"))
		var sentinel int64
		if err = tx.QueryRow(ctx, `insert into notice_log(tenant_id, status) values($1, 'sent') returning id`, tenant).Scan(&sentinel); err != nil {
			t.Fatal(csSchemaErr(err))
		}
		var noticesMid int
		if err = tx.QueryRow(ctx, `select count(*) from notice_log`).Scan(&noticesMid); err != nil {
			t.Fatal(csSchemaErr(err))
		}
		csSchemaExec(t, tx, downSQL)
		var accounts any
		if err = tx.QueryRow(ctx, `select to_regclass('public.cloud_accounts')`).Scan(&accounts); err != nil {
			t.Fatal(csSchemaErr(err))
		}
		if accounts != nil {
			t.Fatal("down vazio manteve cloud_accounts")
		}
		var status string
		if err = tx.QueryRow(ctx, `select status from notice_log where id = $1`, sentinel).Scan(&status); err != nil || status != "sent" {
			t.Fatalf("down removeu aviso histórico: %s %v", status, csSchemaErr(err))
		}
		csSchemaExpectCode(t, tx, `select cloud_lock_timeouts from notice_log where id = $1`, "42703", sentinel)
		csSchemaExpectCode(t, tx, `insert into notice_log(tenant_id, status) values($1, 'skipped_settled')`, "23514", tenant)
		pay, inv, mov := csSchemaMoney(t, tx)
		if pay != paymentsBefore || inv != invoicesBefore || mov != movementsBefore {
			t.Fatal("down vazio alterou dado financeiro")
		}
		var noticesAfterDown int
		if err = tx.QueryRow(ctx, `select count(*) from notice_log`).Scan(&noticesAfterDown); err != nil || noticesAfterDown != noticesMid {
			t.Fatalf("down alterou notice_log: antes=%d depois=%d err=%v", noticesMid, noticesAfterDown, csSchemaErr(err))
		}
		csSchemaExec(t, tx, upSQL)
		var timeouts int
		if err = tx.QueryRow(ctx, `select cloud_lock_timeouts from notice_log where id = $1`, sentinel).Scan(&timeouts); err != nil || timeouts != 0 {
			t.Fatalf("default de cloud_lock_timeouts após reaplicar: %d %v", timeouts, csSchemaErr(err))
		}
	}

	var accounts int
	if err = tx.QueryRow(ctx, `select count(*) from cloud_accounts`).Scan(&accounts); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if !ready && accounts != 0 {
		t.Fatalf("migração gravou cloud_accounts: %d", accounts)
	}
	csSchemaAssertCatalog(t, tx)
	csSchemaAssertGrants(t, tx)

	tenantA, tenantB := uuid.NewString(), uuid.NewString()
	csSchemaExec(t, tx, `insert into tenants(id, name, slug) values($1, 'Synthetic cloud A', $2), ($3, 'Synthetic cloud B', $4)`, tenantA, csSchemaSlug("a"), tenantB, csSchemaSlug("b"))
	cipher := "v1.synthetic.not-real.not-real"
	var accountA, accountB string
	var active bool
	if err = tx.QueryRow(ctx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) values($1, 'Synthetic cloud', 'synthetic-phone-a', 'v0.0', $2, $2) returning id, active`, tenantA, cipher).Scan(&accountA, &active); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if active {
		t.Fatal("active default não é false")
	}
	if err = tx.QueryRow(ctx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc, active) values($1, 'Synthetic cloud B', 'synthetic-phone-a', 'v0.0', $2, $2, false) returning id`, tenantB, cipher).Scan(&accountB); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	csSchemaExpectCode(t, tx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) values($1, 'Synthetic dup', 'synthetic-phone-a', 'v0.0', $2, $2)`, "23505", tenantA, cipher)
	csSchemaExpectCode(t, tx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) values($1, 'Synthetic clear', 'synthetic-phone-c', 'v0.0', 'plaintext-token', $2)`, "23514", tenantA, cipher)
	csSchemaExpectCode(t, tx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) values($1, 'Synthetic clear hook', 'synthetic-phone-d', 'v0.0', $2, 'plaintext-hook')`, "23514", tenantA, cipher)

	var adapter string
	var channelAccountNull bool
	if err = tx.QueryRow(ctx, `insert into notice_channels(tenant_id, name, url) values($1, 'Synthetic generic', 'https://invalid.test/synthetic-notice') returning adapter, cloud_account_id is null`, tenantA).Scan(&adapter, &channelAccountNull); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if adapter != "generic_http" || !channelAccountNull {
		t.Fatalf("canal default adapter=%s conta_nula=%v", adapter, channelAccountNull)
	}
	csSchemaExpectCode(t, tx, `insert into notice_channels(tenant_id, name, url, adapter, cloud_account_id) values($1, 'Synthetic bad generic', 'https://invalid.test/synthetic-notice', 'generic_http', $2)`, "23514", tenantA, accountA)
	csSchemaExpectCode(t, tx, `insert into notice_channels(tenant_id, name, url, adapter) values($1, 'Synthetic bad cloud', 'https://invalid.test/synthetic-notice', 'cloud_api')`, "23514", tenantA)
	csSchemaExpectCode(t, tx, `insert into notice_channels(tenant_id, name, url, adapter, cloud_account_id) values($1, 'Synthetic cross', 'https://invalid.test/synthetic-notice', 'cloud_api', $2)`, "23503", tenantA, accountB)
	var channelA string
	if err = tx.QueryRow(ctx, `insert into notice_channels(tenant_id, name, url, adapter, cloud_account_id) values($1, 'Synthetic cloud channel', 'https://invalid.test/synthetic-notice', 'cloud_api', $2) returning id`, tenantA, accountA).Scan(&channelA); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if channelA == "" {
		t.Fatal("canal cloud_api sem id")
	}

	var logID int64
	var timeouts int
	if err = tx.QueryRow(ctx, `insert into notice_log(tenant_id, status) values($1, 'skipped_settled') returning id, cloud_lock_timeouts`, tenantA).Scan(&logID, &timeouts); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if timeouts != 0 {
		t.Fatalf("cloud_lock_timeouts default %d", timeouts)
	}
	csSchemaExec(t, tx, `update notice_log set cloud_lock_timeouts = 3 where id = $1`, logID)
	csSchemaExpectCode(t, tx, `update notice_log set cloud_lock_timeouts = 4 where id = $1`, "23514", logID)
	var queued int64
	if err = tx.QueryRow(ctx, `insert into notice_log(tenant_id, status) values($1, 'queued') returning id`, tenantA).Scan(&queued); err != nil {
		t.Fatal(csSchemaErr(err))
	}

	hashA := strings.Repeat("ab", 32)
	hashB := strings.Repeat("cd", 32)
	var attemptID string
	if err = tx.QueryRow(ctx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state, provider_message_id) values($1, $2, $3, 1, 'reserved', 'synthetic-provider') returning id`, tenantA, accountA, logID).Scan(&attemptID); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	csSchemaExec(t, tx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state) values($1, $2, $3, 1, 'not_sent')`, tenantA, accountA, queued)
	csSchemaExec(t, tx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state) values($1, $2, $3, 2, 'not_sent')`, tenantA, accountA, queued)
	csSchemaExpectCode(t, tx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state, provider_message_id) values($1, $2, $3, 2, 'wire', 'synthetic-provider')`, "23505", tenantA, accountA, logID)
	csSchemaExpectCode(t, tx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state) values($1, $2, $3, 1, 'reserved')`, "23505", tenantA, accountA, logID)
	csSchemaExpectCode(t, tx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state) values($1, $2, $3, 9, 'reserved')`, "23503", tenantB, accountA, logID)
	csSchemaExpectCode(t, tx, `insert into cloud_notice_attempts(tenant_id, cloud_account_id, notice_log_id, attempt_no, state, excerpt) values($1, $2, $3, 3, 'refused', $4)`, "23514", tenantA, accountA, queued, strings.Repeat("x", 301))

	old := "now() - interval '40 days'"
	csSchemaExec(t, tx, `insert into cloud_notice_status(tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at) values($1, $2, 'synthetic-provider', $3, 'synthetic', `+old+`)`, tenantA, accountA, hashA)
	csSchemaExec(t, tx, `insert into cloud_notice_status(tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status, created_at) values($1, $2, 'synthetic-orphan', $3, 'synthetic', `+old+`)`, tenantA, accountA, hashB)
	csSchemaExpectCode(t, tx, `insert into cloud_notice_status(tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status) values($1, $2, 'synthetic-other', $3, 'synthetic')`, "23505", tenantA, accountA, hashA)
	recentHash := strings.Repeat("ef", 32)
	if err = tx.QueryRow(ctx, `insert into cloud_notice_status(tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status) values($1, $2, 'synthetic-recent', $3, 'synthetic') returning id`, tenantA, accountA, recentHash).Scan(&attemptID); err != nil {
		t.Fatal(csSchemaErr(err))
	}

	csSchemaAsApp(t, tx, tenantA, "")
	var removed int
	if err = tx.QueryRow(ctx, `select cloud_notice_retain_expired(now() - interval '30 days')`).Scan(&removed); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if removed < 1 {
		t.Fatal("retenção não removeu a observação órfã expirada")
	}
	var orphan, linked int
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_status where provider_message_id = 'synthetic-orphan' and cloud_account_id = $1`, accountA).Scan(&orphan); err != nil || orphan != 0 {
		t.Fatalf("órfã expirada permaneceu: %d %v", orphan, csSchemaErr(err))
	}
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_status where provider_message_id = 'synthetic-provider' and cloud_account_id = $1`, accountA).Scan(&linked); err != nil || linked != 1 {
		t.Fatalf("status com attempt vivo foi apagado: %d %v", linked, csSchemaErr(err))
	}
	if _, err = tx.Exec(ctx, `delete from notice_log where id = $1`, logID); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	var attemptsLeft int
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_attempts where notice_log_id = $1`, logID).Scan(&attemptsLeft); err != nil || attemptsLeft != 0 {
		t.Fatalf("FK bloqueou a retenção de skipped_settled ou não cascateou: %d %v", attemptsLeft, csSchemaErr(err))
	}
	if err = tx.QueryRow(ctx, `select cloud_notice_retain_expired(now() - interval '30 days')`).Scan(&removed); err != nil || removed < 1 {
		t.Fatalf("grafo de status expirado após o pai: removed=%d err=%v", removed, csSchemaErr(err))
	}
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_status where provider_message_id = 'synthetic-provider' and cloud_account_id = $1`, accountA).Scan(&linked); err != nil || linked != 0 {
		t.Fatalf("status expirado sobreviveu à saída do attempt: %d %v", linked, csSchemaErr(err))
	}
	var recent int
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_status where body_hash = $1`, recentHash).Scan(&recent); err != nil || recent != 1 {
		t.Fatalf("retenção apagou status dentro do prazo: %d %v", recent, csSchemaErr(err))
	}
	csSchemaExpectCode(t, tx, `update cloud_notice_status set raw_status = 'changed' where body_hash = $1`, "42501", recentHash)
	csSchemaExpectCode(t, tx, `delete from cloud_notice_status where body_hash = $1`, "42501", recentHash)
	csSchemaExpectCode(t, tx, `delete from cloud_notice_attempts where notice_log_id = $1`, "42501", queued)
	csSchemaExec(t, tx, `select set_config('app.subscriber_id', $1, true)`, uuid.NewString())
	csSchemaExpectCode(t, tx, `select cloud_notice_retain_expired(now() - interval '30 days')`, "42501")
	csSchemaExec(t, tx, `select set_config('app.subscriber_id', '', true)`)
	var visible int
	if err = tx.QueryRow(ctx, `select count(*) from cloud_accounts where id = $1`, accountA).Scan(&visible); err != nil || visible != 1 {
		t.Fatalf("tenant não releu a própria conta: %d %v", visible, csSchemaErr(err))
	}
	csSchemaExec(t, tx, `select set_config('app.tenant_id', $1, true)`, tenantB)
	if err = tx.QueryRow(ctx, `select count(*) from cloud_accounts where id = $1`, accountA).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("outro tenant leu a conta: %d %v", visible, csSchemaErr(err))
	}
	csSchemaExpectCode(t, tx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) values($1, 'Synthetic cross tenant', 'synthetic-phone-z', 'v0.0', $2, $2)`, "42501", tenantA, cipher)
	csSchemaExec(t, tx, `select set_config('app.tenant_id', $1, true), set_config('app.subscriber_id', $2, true)`, tenantA, uuid.NewString())
	if err = tx.QueryRow(ctx, `select count(*) from cloud_accounts where id = $1`, accountA).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("portal leu a conta: %d %v", visible, csSchemaErr(err))
	}
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_attempts where notice_log_id = $1`, queued).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("portal leu attempts: %d %v", visible, csSchemaErr(err))
	}
	if err = tx.QueryRow(ctx, `select count(*) from cloud_notice_status where body_hash = $1`, recentHash).Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("portal leu status: %d %v", visible, csSchemaErr(err))
	}
	csSchemaExpectCode(t, tx, `insert into cloud_accounts(tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc) values($1, 'Synthetic portal', 'synthetic-phone-p', 'v0.0', $2, $2)`, "42501", tenantA, cipher)

	csSchemaExec(t, tx, `reset role`)
	csSchemaExec(t, tx, `select set_config('app.subscriber_id', '', true)`)
	csSchemaExpectText(t, tx, `update cloud_notice_status set raw_status = 'changed' where body_hash = $1`, "cloud notice status is append-only", recentHash)
	csSchemaExpectText(t, tx, `delete from cloud_notice_status where body_hash = $1`, "cloud notice status is append-only", recentHash)
	csSchemaExpectText(t, tx, downSQL, "Preserve cloud notice journal history")
	if err = tx.QueryRow(ctx, `select count(*) from cloud_accounts where id = $1`, accountA).Scan(&visible); err != nil || visible != 1 {
		t.Fatalf("down com histórico removeu a conta: %d %v", visible, csSchemaErr(err))
	}
	if err = tx.QueryRow(ctx, `select count(*) from notice_log where id = $1`, queued).Scan(&visible); err != nil || visible != 1 {
		t.Fatalf("down com histórico removeu notice_log: %d %v", visible, csSchemaErr(err))
	}
	pay, inv, mov := csSchemaMoney(t, tx)
	if pay != paymentsBefore || inv != invoicesBefore || mov != movementsBefore {
		t.Fatalf("dado financeiro mudou: payments %d->%d invoices %d->%d movements %d->%d", paymentsBefore, pay, invoicesBefore, inv, movementsBefore, mov)
	}
}

func csSchemaDBGuard(runtimeDSN, appDSN, ownerDSN, required string) (skip bool, fail string) {
	if runtimeDSN == "" || appDSN == "" || ownerDSN == "" {
		msg := "NEXO_GO_TEST_DATABASE_URL, DATABASE_URL_APP ou NEXO_GO_TEST_DATABASE_OWNER_URL ausente; este skip não é teste de banco aprovado e não aprova a migração 79"
		if required == "1" {
			return false, msg
		}
		return true, msg
	}
	if runtimeDSN == appDSN || runtimeDSN == ownerDSN || appDSN == ownerDSN {
		return false, "runtime Go, app e owner precisam de conexões distintas"
	}
	return false, ""
}

func csSchemaConnect(t *testing.T, dsn string) *pgx.Conn {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	conn, err := pgx.ConnectConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	t.Cleanup(func() { _ = conn.Close(context.Background()) })
	return conn
}

func csSchemaAssertSession(t *testing.T, conn *pgx.Conn, role string, rejectBypass bool) {
	t.Helper()
	var database, sessionUser, currentUser string
	var superuser, bypass bool
	err := conn.QueryRow(context.Background(), `select current_database(), session_user::text, current_user::text, rolsuper, rolbypassrls from pg_roles where rolname = session_user`).Scan(&database, &sessionUser, &currentUser, &superuser, &bypass)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if database != "nexo_test" || sessionUser != role || currentUser != role || (rejectBypass && (superuser || bypass)) {
		t.Fatalf("papel efetivo inválido: db=%s session=%s current=%s esperado=%s super=%v bypassrls=%v", database, sessionUser, currentUser, role, superuser, bypass)
	}
}

func csSchemaAssertCatalog(t *testing.T, tx pgx.Tx) {
	t.Helper()
	ctx := context.Background()
	var cascade string
	if err := tx.QueryRow(ctx, `select confdeltype::text from pg_constraint where conname = 'cloud_notice_attempts_notice_fk'`).Scan(&cascade); err != nil || cascade != "c" {
		t.Fatalf("attempts não cascateia na retenção do notice_log: %s %v", cascade, csSchemaErr(err))
	}
	var financialFKs int
	if err := tx.QueryRow(ctx, `select count(*) from pg_constraint where contype = 'f' and conrelid in ('cloud_accounts'::regclass, 'cloud_notice_attempts'::regclass, 'cloud_notice_status'::regclass) and confrelid in ('payments'::regclass, 'invoices'::regclass, 'invoice_movements'::regclass)`).Scan(&financialFKs); err != nil || financialFKs != 0 {
		t.Fatalf("FK financeira no journal: %d %v", financialFKs, csSchemaErr(err))
	}
	var headers int
	if err := tx.QueryRow(ctx, `select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'notice_channels' and column_name = 'headers_enc'`).Scan(&headers); err != nil || headers != 1 {
		t.Fatalf("headers_enc do canal genérico foi alterado: %d %v", headers, csSchemaErr(err))
	}
	var policies int
	if err := tx.QueryRow(ctx, `select count(*) from pg_policy where polrelid in ('cloud_accounts'::regclass, 'cloud_notice_attempts'::regclass, 'cloud_notice_status'::regclass) and ((polname like 't_%' and polpermissive and pg_get_expr(polqual, polrelid) like '%app_tenant()%') or (polname like 'portal_%' and not polpermissive and pg_get_expr(polqual, polrelid) like '%app_subscriber()%'))`).Scan(&policies); err != nil || policies != 6 {
		t.Fatalf("políticas tenant/portal: %d %v", policies, csSchemaErr(err))
	}
	var trigger string
	if err := tx.QueryRow(ctx, `select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'cloud_notice_status'::regclass and not tgisinternal and tgname = 'cloud_notice_status_append_only'`).Scan(&trigger); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	lower := strings.ToLower(trigger)
	if !strings.Contains(lower, "cloud_notice_status_append_only()") || !strings.Contains(lower, "update") || !strings.Contains(lower, "delete") {
		t.Fatal(trigger)
	}
	var source string
	if err := tx.QueryRow(ctx, `select prosrc from pg_proc where proname = 'cloud_notice_retain_expired'`).Scan(&source); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	lowerSrc := strings.ToLower(source)
	for _, banned := range []string{"payments", "invoices", "invoice_movements"} {
		if strings.Contains(lowerSrc, banned) {
			t.Fatalf("retenção cita dado financeiro: %s", banned)
		}
	}
}

func csSchemaAssertGrants(t *testing.T, tx pgx.Tx) {
	t.Helper()
	ctx := context.Background()
	csSchemaExec(t, tx, `set local role nexo_app`)
	var accountSel, accountIns, accountUpd, accountDel bool
	var attemptSel, attemptIns, attemptUpd, attemptDel bool
	var statusSel, statusIns, statusUpd, statusDel bool
	var retain bool
	err := tx.QueryRow(ctx, `select
		has_table_privilege(current_user, 'cloud_accounts', 'SELECT'),
		has_table_privilege(current_user, 'cloud_accounts', 'INSERT'),
		has_table_privilege(current_user, 'cloud_accounts', 'UPDATE'),
		has_table_privilege(current_user, 'cloud_accounts', 'DELETE'),
		has_table_privilege(current_user, 'cloud_notice_attempts', 'SELECT'),
		has_table_privilege(current_user, 'cloud_notice_attempts', 'INSERT'),
		has_table_privilege(current_user, 'cloud_notice_attempts', 'UPDATE'),
		has_table_privilege(current_user, 'cloud_notice_attempts', 'DELETE'),
		has_table_privilege(current_user, 'cloud_notice_status', 'SELECT'),
		has_table_privilege(current_user, 'cloud_notice_status', 'INSERT'),
		has_table_privilege(current_user, 'cloud_notice_status', 'UPDATE'),
		has_table_privilege(current_user, 'cloud_notice_status', 'DELETE'),
		has_function_privilege(current_user, 'cloud_notice_retain_expired(timestamptz)', 'EXECUTE')`).Scan(
		&accountSel, &accountIns, &accountUpd, &accountDel,
		&attemptSel, &attemptIns, &attemptUpd, &attemptDel,
		&statusSel, &statusIns, &statusUpd, &statusDel,
		&retain)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if !accountSel || !accountIns || !accountUpd || accountDel || !attemptSel || !attemptIns || !attemptUpd || attemptDel || !statusSel || !statusIns || statusUpd || statusDel || !retain {
		t.Fatalf("grants app divergentes accounts=%v/%v/%v/%v attempts=%v/%v/%v/%v status=%v/%v/%v/%v retain=%v", accountSel, accountIns, accountUpd, accountDel, attemptSel, attemptIns, attemptUpd, attemptDel, statusSel, statusIns, statusUpd, statusDel, retain)
	}
	csSchemaExec(t, tx, `reset role`)
	var directGo bool
	if err = tx.QueryRow(ctx, `select coalesce(bool_or(r.rolname = 'nexo_go'), false) from pg_class c cross join lateral aclexplode(c.relacl) x join pg_roles r on r.oid = x.grantee where c.oid in ('cloud_accounts'::regclass, 'cloud_notice_attempts'::regclass, 'cloud_notice_status'::regclass)`).Scan(&directGo); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if directGo {
		t.Fatal("nexo_go recebeu grant direto no journal")
	}
	var publicExec bool
	if err = tx.QueryRow(ctx, `select proacl is null or exists (select 1 from aclexplode(proacl) x where x.grantee = 0 and x.privilege_type = 'EXECUTE') from pg_proc where proname = 'cloud_notice_retain_expired'`).Scan(&publicExec); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if publicExec {
		t.Fatal("public executa a retenção")
	}
}

func csSchemaAsApp(t *testing.T, tx pgx.Tx, tenant, subscriber string) {
	t.Helper()
	csSchemaExec(t, tx, `select set_config('app.tenant_id', $1, true), set_config('app.is_operator', 'off', true), set_config('app.subscriber_id', $2, true), set_config('app.pop_ids', '', true)`, tenant, subscriber)
	csSchemaExec(t, tx, `set local role nexo_app`)
}

func csSchemaHistory(t *testing.T, tx pgx.Tx) int {
	t.Helper()
	var n int
	err := tx.QueryRow(context.Background(), `select
		(select count(*) from cloud_accounts)
		+ (select count(*) from cloud_notice_attempts)
		+ (select count(*) from cloud_notice_status)
		+ (select count(*) from notice_log where status = 'skipped_settled' or cloud_lock_timeouts <> 0)
		+ (select count(*) from notice_channels where adapter is distinct from 'generic_http' or cloud_account_id is not null)`).Scan(&n)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	return n
}

func csSchemaMoney(t *testing.T, tx pgx.Tx) (payments, invoices, movements int) {
	t.Helper()
	err := tx.QueryRow(context.Background(), `select (select count(*) from payments), (select count(*) from invoices), (select count(*) from invoice_movements)`).Scan(&payments, &invoices, &movements)
	if err != nil {
		t.Fatal(csSchemaErr(err))
	}
	return payments, invoices, movements
}

func csSchemaExec(t *testing.T, tx pgx.Tx, query string, args ...any) {
	t.Helper()
	if _, err := tx.Exec(context.Background(), query, args...); err != nil {
		t.Fatal(csSchemaErr(err))
	}
}

func csSchemaExpectCode(t *testing.T, tx pgx.Tx, query, code string, args ...any) {
	t.Helper()
	csSchemaExpect(t, tx, query, args, func(err error) bool {
		var pg *pgconn.PgError
		return errors.As(err, &pg) && pg.Code == code
	}, code)
}

func csSchemaExpectText(t *testing.T, tx pgx.Tx, query, text string, args ...any) {
	t.Helper()
	csSchemaExpect(t, tx, query, args, func(err error) bool {
		return err != nil && strings.Contains(err.Error(), text)
	}, text)
}

func csSchemaExpect(t *testing.T, tx pgx.Tx, query string, args []any, match func(error) bool, label string) {
	t.Helper()
	ctx := context.Background()
	if _, err := tx.Exec(ctx, `savepoint cs_schema_expect`); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	_, err := tx.Exec(ctx, query, args...)
	if err == nil || !match(err) {
		t.Fatalf("esperava %s, obteve %s", label, csSchemaErr(err))
	}
	if _, err = tx.Exec(ctx, `rollback to savepoint cs_schema_expect`); err != nil {
		t.Fatal(csSchemaErr(err))
	}
	if _, err = tx.Exec(ctx, `release savepoint cs_schema_expect`); err != nil {
		t.Fatal(csSchemaErr(err))
	}
}

func csSchemaMigration(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("origem do teste indisponível")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "db", "migrations", "00079_cloud_notice_journal.sql")
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func csSchemaStatement(t *testing.T, section string) string {
	t.Helper()
	_, body, ok := strings.Cut(section, "-- +goose StatementBegin")
	if !ok {
		t.Fatal("seção sem StatementBegin")
	}
	body, _, ok = strings.Cut(body, "-- +goose StatementEnd")
	if !ok {
		t.Fatal("seção sem StatementEnd")
	}
	body = strings.TrimSpace(body)
	if body == "" {
		t.Fatal("seção vazia")
	}
	return body
}

func csSchemaSlug(prefix string) string {
	return prefix + strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
}

var csSchemaURL = regexp.MustCompile(`(?i)\b(?:postgres(?:ql)?|rediss?)://\S+`)

func csSchemaErr(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	for _, key := range []string{"NEXO_GO_TEST_DATABASE_URL", "NEXO_GO_TEST_DATABASE_OWNER_URL", "DATABASE_URL_APP"} {
		if value := os.Getenv(key); value != "" {
			text = strings.ReplaceAll(text, value, key)
		}
	}
	return csSchemaURL.ReplaceAllString(text, "postgres://redacted")
}
