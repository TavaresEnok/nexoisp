package finance

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestImportCompensationMigrationFile(t *testing.T) {
	text := migrationSQL(t)
	up, down, ok := strings.Cut(text, "-- +goose Down")
	if !ok {
		t.Fatal("migração sem Down")
	}
	lowerUp := strings.ToLower(up)
	for _, forbidden := range []string{"drop table", "drop column", "delete from", "truncate ", "grant all", "grant update", "grant delete", "create function financial_append_only", "create or replace function financial_append_only"} {
		if strings.Contains(lowerUp, forbidden) {
			t.Fatalf("up altera histórico ou amplia grant: %s", forbidden)
		}
	}
	for _, required := range []string{
		"create table import_batch_compensations",
		"unique (tenant_id, batch_id)",
		"unique (tenant_id, idempotency_key)",
		"foreign key (tenant_id, batch_id) references import_batches (tenant_id, id)",
		"foreign key (tenant_id, actor_id) references users (tenant_id, id)",
		"using (tenant_id = app_tenant())",
		"app_subscriber() is null",
		"app_pops() is null",
		"grant select, insert on import_batch_compensations to nexo_app",
		"execute function financial_append_only()",
	} {
		if !strings.Contains(up, required) {
			t.Fatalf("up sem %s", required)
		}
	}
	lowerDown := strings.ToLower(down)
	for _, forbidden := range []string{"drop table", "delete from", "truncate "} {
		if strings.Contains(lowerDown, forbidden) {
			t.Fatalf("down apagaria histórico: %s", forbidden)
		}
	}
	if !strings.Contains(down, "Preserve import batch compensations and financial history") {
		t.Fatal("down não recusa a perda do marcador")
	}
}

func TestImportBatchCompensationSchema(t *testing.T) {
	dsn := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	ownerDSN := os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if dsn == "" || ownerDSN == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL ou NEXO_GO_TEST_DATABASE_OWNER_URL ausente; este skip não é teste de banco aprovado. A gerência precisa executar tests/contrato/nativo.py e tests/contrato/go_integration.py num PostgreSQL descartável antes de publicar")
	}
	ctx := context.Background()
	app, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.Close() })
	owner, err := sql.Open("pgx", ownerDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Close() })

	var appDB, appUser string
	var privileged bool
	if err = app.QueryRowContext(ctx, `select current_database(), current_user, rolsuper or rolbypassrls from pg_roles where rolname = current_user`).Scan(&appDB, &appUser, &privileged); err != nil {
		t.Fatal(err)
	}
	if appDB != "nexo_test" || appUser != "nexo_app" || privileged {
		t.Fatalf("papel efetivo inválido: db=%s user=%s privileged=%v", appDB, appUser, privileged)
	}
	var ownerDB string
	if err = owner.QueryRowContext(ctx, `select current_database()`).Scan(&ownerDB); err != nil || ownerDB != "nexo_test" {
		t.Fatal("somente o banco descartável nexo_test é permitido", ownerDB, err)
	}
	var version int
	var tableName sql.NullString
	if err = owner.QueryRowContext(ctx, `select coalesce(max(version_id), 0), to_regclass('public.import_batch_compensations')::text from goose_db_version`).Scan(&version, &tableName); err != nil {
		t.Fatal(err)
	}
	if version < 78 || !tableName.Valid {
		t.Fatalf("migração 00078 não aplicada no laboratório descartável: goose=%d tabela=%v", version, tableName.String)
	}
	var selectOK, insertOK, updateOK, deleteOK, rls bool
	if err = app.QueryRowContext(ctx, `select has_table_privilege(current_user, 'import_batch_compensations', 'SELECT'), has_table_privilege(current_user, 'import_batch_compensations', 'INSERT'), has_table_privilege(current_user, 'import_batch_compensations', 'UPDATE'), has_table_privilege(current_user, 'import_batch_compensations', 'DELETE'), (select relrowsecurity from pg_class where oid = 'import_batch_compensations'::regclass)`).Scan(&selectOK, &insertOK, &updateOK, &deleteOK, &rls); err != nil {
		t.Fatal(err)
	}
	if !selectOK || !insertOK || updateOK || deleteOK || !rls {
		t.Fatalf("grants ou RLS divergentes: select=%v insert=%v update=%v delete=%v rls=%v", selectOK, insertOK, updateOK, deleteOK, rls)
	}
	assertCompensationCatalog(t, owner)

	conn, err := owner.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()

	var paymentsBefore, movementsBefore, auditsBefore int
	if err = tx.QueryRowContext(ctx, `select (select count(*) from payments), (select count(*) from invoice_movements), (select count(*) from audit_events)`).Scan(&paymentsBefore, &movementsBefore, &auditsBefore); err != nil {
		t.Fatal(err)
	}
	tenantA, tenantB := uuid.NewString(), uuid.NewString()
	userA, userB := uuid.NewString(), uuid.NewString()
	batchA1, batchA2, batchB := uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustExec(t, tx, `insert into tenants(id, name, slug) values($1, 'Synthetic compensation A', $2), ($3, 'Synthetic compensation B', $4)`, tenantA, slug78("a"), tenantB, slug78("b"))
	mustExec(t, tx, `insert into users(id, tenant_id, email, name, password_hash, role) values($1, $2, $3, 'Synthetic actor A', 'disabled', 'admin'), ($4, $5, $6, 'Synthetic actor B', 'disabled', 'admin')`, userA, tenantA, userA+"@invalid.test", userB, tenantB, userB+"@invalid.test")
	mustExec(t, tx, `insert into import_batches(id, tenant_id, source, kind, totals) values($1, $2, 'csv-sintetico', 'invoices', '{}'), ($3, $2, 'csv-sintetico', 'invoices', '{}'), ($4, $5, 'csv-sintetico', 'invoices', '{}')`, batchA1, tenantA, batchA2, batchB, tenantB)

	mustExec(t, tx, `set local role nexo_app`)
	mustExec(t, tx, `select set_config('app.tenant_id', $1, true), set_config('app.is_operator', 'off', true), set_config('app.subscriber_id', '', true), set_config('app.pop_ids', '', true)`, tenantA)
	const key = "compensate-key-1"
	const reason = "motivo sintetico da compensacao do lote"
	var compensationID string
	var createdAt time.Time
	if err = tx.QueryRowContext(ctx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, $3, $4, $5, $6, '{"reversed_payments":0}'::jsonb) returning id, created_at`, tenantA, batchA1, key, "synthetic-request-hash", reason, userA).Scan(&compensationID, &createdAt); err != nil {
		t.Fatal(err)
	}
	if compensationID == "" || compensationID == batchA1 || createdAt.IsZero() {
		t.Fatalf("identidade do marcador inválida: id=%s batch=%s at=%s", compensationID, batchA1, createdAt)
	}
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-2', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "23505", tenantA, batchA1, reason, userA)
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, $3, 'synthetic-request-hash', $4, $5, '{}'::jsonb)`, "23505", tenantA, batchA2, key, reason, userA)
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-3', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "23503", tenantA, batchA2, reason, userB)
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'curta', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "23514", tenantA, batchA2, reason, userA)
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-4', 'synthetic-request-hash', 'curto', $3, '{}'::jsonb)`, "23514", tenantA, batchA2, userA)

	mustExec(t, tx, `select set_config('app.tenant_id', $1, true)`, tenantB)
	var otherID string
	if err = tx.QueryRowContext(ctx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, $3, 'synthetic-request-hash-b', $4, $5, '{"left_canceled":1}'::jsonb) returning id`, tenantB, batchB, key, reason, userB).Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	if otherID == compensationID {
		t.Fatal("marcadores de tenants diferentes compartilham id")
	}
	var visible int
	if err = tx.QueryRowContext(ctx, `select count(*) from import_batch_compensations where id = $1`, compensationID).Scan(&visible); err != nil || visible != 0 {
		t.Fatal("outro tenant leu o marcador", visible, err)
	}
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-5', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "42501", tenantA, batchA2, reason, userA)
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-6', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "23503", tenantB, batchA1, reason, userB)

	mustExec(t, tx, `select set_config('app.tenant_id', $1, true), set_config('app.subscriber_id', $2, true), set_config('app.pop_ids', '', true)`, tenantA, uuid.NewString())
	if err = tx.QueryRowContext(ctx, `select count(*) from import_batch_compensations where id = $1`, compensationID).Scan(&visible); err != nil || visible != 0 {
		t.Fatal("portal leu o marcador", visible, err)
	}
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-7', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "42501", tenantA, batchA2, reason, userA)

	mustExec(t, tx, `select set_config('app.subscriber_id', '', true), set_config('app.pop_ids', $1, true)`, uuid.NewString())
	if err = tx.QueryRowContext(ctx, `select count(*) from import_batch_compensations where id = $1`, compensationID).Scan(&visible); err != nil || visible != 0 {
		t.Fatal("POP leu o marcador", visible, err)
	}
	expectState(t, tx, `insert into import_batch_compensations(tenant_id, batch_id, idempotency_key, request_hash, reason, actor_id, result) values($1, $2, 'compensate-key-8', 'synthetic-request-hash', $3, $4, '{}'::jsonb)`, "42501", tenantA, batchA2, reason, userA)

	mustExec(t, tx, `select set_config('app.pop_ids', '', true)`)
	if err = tx.QueryRowContext(ctx, `select count(*) from import_batch_compensations where tenant_id = $1`, tenantA).Scan(&visible); err != nil || visible != 1 {
		t.Fatal("escopo integral não releu o próprio marcador", visible, err)
	}
	expectState(t, tx, `update import_batch_compensations set reason = 'motivo alterado indevidamente no marcador' where id = $1`, "42501", compensationID)
	expectOwnerAppendOnly(t, tx, `delete from import_batch_compensations where id = $1`, compensationID)
	expectOwnerAppendOnly(t, tx, `update import_batch_compensations set reason = 'motivo alterado indevidamente no marcador' where id = $1`, compensationID)

	_, down, _ := strings.Cut(migrationSQL(t), "-- +goose Down")
	downSQL := downStatement(t, down)
	expectText(t, tx, downSQL, "Preserve import batch compensations and financial history")
	if err = tx.QueryRowContext(ctx, `select count(*) from import_batch_compensations where id = $1`, compensationID).Scan(&visible); err != nil || visible != 1 {
		t.Fatal("down removeu o marcador", visible, err)
	}
	mustExec(t, tx, `reset role`)
	var paymentsAfter, movementsAfter, auditsAfter int
	if err = tx.QueryRowContext(ctx, `select (select count(*) from payments), (select count(*) from invoice_movements), (select count(*) from audit_events)`).Scan(&paymentsAfter, &movementsAfter, &auditsAfter); err != nil {
		t.Fatal(err)
	}
	if paymentsAfter != paymentsBefore || movementsAfter != movementsBefore || auditsAfter != auditsBefore {
		t.Fatalf("histórico financeiro mudou: payments %d->%d movements %d->%d audit %d->%d", paymentsBefore, paymentsAfter, movementsBefore, movementsAfter, auditsBefore, auditsAfter)
	}
}

func assertCompensationCatalog(t *testing.T, owner *sql.DB) {
	t.Helper()
	rows, err := owner.QueryContext(context.Background(), `select conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where conrelid = 'import_batch_compensations'::regclass`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var defs []string
	for rows.Next() {
		var def string
		if err = rows.Scan(&def); err != nil {
			t.Fatal(err)
		}
		defs = append(defs, def)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	joined := strings.ToLower(strings.Join(defs, "\n"))
	for _, want := range []string{"unique (tenant_id, batch_id)", "unique (tenant_id, idempotency_key)", "foreign key (tenant_id, batch_id) references import_batches(tenant_id, id)", "foreign key (tenant_id, actor_id) references users(tenant_id, id)"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("restrição ausente %s em %s", want, joined)
		}
	}
	var policies int
	if err = owner.QueryRowContext(context.Background(), `select count(*) from pg_policy where polrelid = 'import_batch_compensations'::regclass and ((polname = 't_import_batch_compensations' and polpermissive and pg_get_expr(polqual, polrelid) like '%app_tenant()%') or (polname = 'portal_import_batch_compensations' and not polpermissive and pg_get_expr(polqual, polrelid) like '%app_subscriber()%') or (polname = 'pop_import_batch_compensations' and not polpermissive and pg_get_expr(polqual, polrelid) like '%app_pops()%'))`).Scan(&policies); err != nil {
		t.Fatal(err)
	}
	if policies != 3 {
		t.Fatalf("políticas de tenant, portal e POP: %d", policies)
	}
	var trigger string
	if err = owner.QueryRowContext(context.Background(), `select pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'import_batch_compensations'::regclass and not tgisinternal and tgname = 'immutable_import_batch_compensations'`).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.ToLower(trigger), "financial_append_only()") || !strings.Contains(strings.ToLower(trigger), "update") || !strings.Contains(strings.ToLower(trigger), "delete") {
		t.Fatal(trigger)
	}
}

func migrationSQL(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("origem do teste indisponível")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "..", "db", "migrations", "00078_import_batch_compensations.sql")
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func downStatement(t *testing.T, down string) string {
	t.Helper()
	_, body, ok := strings.Cut(down, "-- +goose StatementBegin")
	if !ok {
		t.Fatal("down sem StatementBegin")
	}
	body, _, ok = strings.Cut(body, "-- +goose StatementEnd")
	if !ok {
		t.Fatal("down sem StatementEnd")
	}
	body = strings.TrimSpace(body)
	if body == "" {
		t.Fatal("down vazio")
	}
	return body
}

func slug78(prefix string) string {
	return prefix + strings.ReplaceAll(uuid.NewString(), "-", "")[:8]
}

func mustExec(t *testing.T, tx *sql.Tx, query string, args ...any) {
	t.Helper()
	if _, err := tx.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func expectState(t *testing.T, tx *sql.Tx, query, code string, args ...any) {
	t.Helper()
	expect(t, tx, query, args, func(err error) bool {
		var pg *pgconn.PgError
		return errors.As(err, &pg) && pg.Code == code
	}, code)
}

func expectText(t *testing.T, tx *sql.Tx, query, text string) {
	t.Helper()
	expect(t, tx, query, nil, func(err error) bool {
		return err != nil && strings.Contains(err.Error(), text)
	}, text)
}

func expect(t *testing.T, tx *sql.Tx, query string, args []any, match func(error) bool, label string) {
	t.Helper()
	ctx := context.Background()
	if _, err := tx.ExecContext(ctx, `savepoint compensation_expect`); err != nil {
		t.Fatal(err)
	}
	_, err := tx.ExecContext(ctx, query, args...)
	if err == nil || !match(err) {
		t.Fatalf("esperava %s, obteve %v", label, err)
	}
	if _, err = tx.ExecContext(ctx, `rollback to savepoint compensation_expect`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `release savepoint compensation_expect`); err != nil {
		t.Fatal(err)
	}
}

func expectOwnerAppendOnly(t *testing.T, tx *sql.Tx, query string, args ...any) {
	t.Helper()
	ctx := context.Background()
	if _, err := tx.ExecContext(ctx, `savepoint compensation_expect`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `reset role`); err != nil {
		t.Fatal(err)
	}
	_, err := tx.ExecContext(ctx, query, args...)
	var pg *pgconn.PgError
	if err == nil || !errors.As(err, &pg) || pg.Code != "P0001" || !strings.Contains(pg.Message, "financial history is append-only") {
		t.Fatalf("dono deveria esbarrar no marcador append-only, obteve %v", err)
	}
	if _, err = tx.ExecContext(ctx, `rollback to savepoint compensation_expect`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.ExecContext(ctx, `release savepoint compensation_expect`); err != nil {
		t.Fatal(err)
	}
}
