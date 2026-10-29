package escrita

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
)

const importLockSkip = "NEXO_GO_TEST_DATABASE_URL ausente; este skip não é teste de banco aprovado. A gerência precisa executar tests/contrato/nativo.py e tests/contrato/go_integration.py num PostgreSQL descartável antes de publicar"

const importAdvisorySalt int64 = 7411005

var errImportLockRollback = errors.New("rollback do teste de reimportação")

type importLockFix struct {
	source string
	sub    string
	con    string
	ext    map[string]string
	ids    []string
}

func TestImportInvoiceReimportLocks(t *testing.T) {
	d, scope := openImportLockDB(t)
	beforeImportRows = nil
	t.Cleanup(func() { beforeImportRows = nil })

	t.Run("reverse csv waits on the canonical invoice", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 2)
		sorted := sortedUUIDs(t, fix.ids)
		release, held, done := holdInvoices(t, d, scope, []string{sorted[0]}, false, nil)
		defer finishHold(t, release, done)
		waitHeld(t, held)
		errCh := make(chan error, 1)
		outCh := make(chan any, 1)
		go func() {
			out, err := runInvoiceImport(context.Background(), d, scope, fix, true, fix.line(sorted[1], "10,00"), fix.line(sorted[0], "10,00"))
			outCh <- out
			errCh <- err
		}()
		waitAdvisory(t, d, scope, invoiceAdvisoryKey(scope.TenantID, sorted[0]))
		if !invoiceRowFree(t, d, scope, sorted[1]) {
			t.Fatal("a fatura de id maior foi travada antes da menor; a ordem do CSV venceu a ordem canônica")
		}
		release()
		out := importMap(t, waitImport(t, outCh, errCh))
		if out["applied"] != true {
			t.Fatalf("applied %v", out["applied"])
		}
		sample := importSample(t, out)
		if len(sample) != 2 || sample[0]["status"] != "unchanged" || sample[1]["status"] != "unchanged" {
			t.Fatalf("amostra %#v", sample)
		}
		if sample[0]["external_id"] != fix.ext[sorted[1]] || sample[1]["external_id"] != fix.ext[sorted[0]] {
			t.Fatalf("ordem do arquivo %#v", sample)
		}
		rows := importRows(t, d, scope, fix.source)
		if len(rows) != 2 || rows[0]["status"] != "unchanged" || rows[1]["status"] != "unchanged" {
			t.Fatalf("import_rows %#v", rows)
		}
		if rows[0]["entity_id"] != sorted[1] || rows[1]["entity_id"] != sorted[0] {
			t.Fatalf("entity_id %#v", rows)
		}
	})

	t.Run("savepoint keeps locks until import rows", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 2)
		sorted := sortedUUIDs(t, fix.ids)
		reached := make(chan struct{})
		releaseBar := make(chan struct{})
		var releaseOnce sync.Once
		releaseBarFn := func() { releaseOnce.Do(func() { close(releaseBar) }) }
		beforeImportRows = func(context.Context, *db.Tx) error {
			close(reached)
			<-releaseBar
			return nil
		}
		defer func() {
			beforeImportRows = nil
			releaseBarFn()
		}()
		errCh := make(chan error, 1)
		outCh := make(chan any, 1)
		go func() {
			out, err := runInvoiceImport(context.Background(), d, scope, fix, true, fix.line(sorted[1], "nope"), fix.line(sorted[0], "10,00"))
			outCh <- out
			errCh <- err
		}()
		select {
		case <-reached:
		case err := <-errCh:
			t.Fatal(err)
		case <-time.After(8 * time.Second):
			t.Fatal("a importação não chegou em import_rows")
		}
		if err := lockTimeout(d, scope, sorted...); !isLockTimeout(err) {
			t.Fatalf("compensação não esperou o protocolo: %v", err)
		}
		if err := invoiceNowait(d, scope, sorted...); !isLockTimeout(err) {
			t.Fatalf("FOR UPDATE NOWAIT não viu as duas faturas: %v", err)
		}
		for _, id := range sorted {
			if n := grantedAdvisories(t, d, scope, invoiceAdvisoryKey(scope.TenantID, id)); n != 1 {
				t.Fatalf("advisory %s = %d", id, n)
			}
		}
		releaseBarFn()
		out := importMap(t, waitImport(t, outCh, errCh))
		totals := importTotals(t, out)
		if totals["error"] != float64(1) || totals["unchanged"] != float64(1) {
			t.Fatalf("totais %#v", totals)
		}
		rows := importRows(t, d, scope, fix.source)
		if len(rows) != 2 || rows[0]["external_id"] != fix.ext[sorted[1]] || rows[0]["status"] != "error" || rows[1]["status"] != "unchanged" || rows[1]["entity_id"] != sorted[0] {
			t.Fatalf("import_rows %#v", rows)
		}
		if err := lockTimeout(d, scope, sorted...); err != nil && !errors.Is(err, errImportLockRollback) {
			t.Fatal(err)
		}
	})

	t.Run("preview does not persist", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 2)
		sorted := sortedUUIDs(t, fix.ids)
		fresh := "novo-" + uuid.NewString()[:8]
		out, err := runInvoiceImport(context.Background(), d, scope, fix, false, fix.line(sorted[1], "10,00"), fix.line(sorted[0], "10,00"), fix.line(fresh, "10,00"))
		if err != nil {
			t.Fatal(err)
		}
		body := importMap(t, out)
		if body["applied"] != false || body["batch_id"] != nil {
			t.Fatalf("prévia persistiu %#v", body["applied"])
		}
		sample := importSample(t, body)
		if len(sample) != 3 || sample[0]["status"] != "unchanged" || sample[1]["status"] != "unchanged" || sample[2]["status"] != "created" {
			t.Fatalf("amostra %#v", sample)
		}
		if countWhere(t, d, scope, `select count(*) from invoices where external_source = $1 and external_id = $2`, fix.source, fresh) != 0 {
			t.Fatal("prévia gravou fatura nova")
		}
		if countWhere(t, d, scope, `select count(*) from import_batches where source = $1`, fix.source) != 0 {
			t.Fatal("prévia gravou lote")
		}
		if err := lockTimeout(d, scope, sorted...); err != nil && !errors.Is(err, errImportLockRollback) {
			t.Fatal(err)
		}
	})

	t.Run("new invoice does not lock older ones", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 1)
		old := uuid.MustParse(fix.ids[0]).String()
		release, held, done := holdInvoices(t, d, scope, []string{old}, false, nil)
		defer finishHold(t, release, done)
		waitHeld(t, held)
		fresh := "novo-" + uuid.NewString()[:8]
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := runInvoiceImport(ctx, d, scope, fix, true, fix.line(fresh, "10,00"))
		if err != nil {
			t.Fatal(err)
		}
		body := importMap(t, out)
		sample := importSample(t, body)
		if len(sample) != 1 || sample[0]["status"] != "created" {
			t.Fatalf("amostra %#v", sample)
		}
		if countWhere(t, d, scope, `select count(*) from invoices where external_source = $1 and external_id = $2`, fix.source, fresh) != 1 {
			t.Fatal("fatura nova ausente")
		}
		if err := invoiceNowait(d, scope, old); !isLockTimeout(err) {
			t.Fatalf("a fatura antiga não continuou com o rival: %v", err)
		}
	})

	t.Run("cancel while the rival holds the lock rolls back", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 1)
		id := uuid.MustParse(fix.ids[0]).String()
		release, held, done := holdInvoices(t, d, scope, []string{id}, false, nil)
		defer finishHold(t, release, done)
		waitHeld(t, held)
		ctx, cancel := context.WithCancel(context.Background())
		errCh := make(chan error, 1)
		go func() {
			_, err := runInvoiceImport(ctx, d, scope, fix, true, fix.line(id, "10,00"))
			errCh <- err
		}()
		waitAdvisory(t, d, scope, invoiceAdvisoryKey(scope.TenantID, id))
		cancel()
		select {
		case err := <-errCh:
			if err == nil || !errors.Is(err, context.Canceled) && !strings.Contains(err.Error(), "cancel") {
				t.Fatal(err)
			}
		case <-time.After(8 * time.Second):
			t.Fatal("o cancelamento não encerrou a importação")
		}
		if countWhere(t, d, scope, `select count(*) from import_batches where source = $1`, fix.source) != 0 {
			t.Fatal("o rollback deixou lote")
		}
		if countWhere(t, d, scope, `select count(*) from import_rows ir join import_batches b on b.id = ir.batch_id where b.source = $1`, fix.source) != 0 {
			t.Fatal("o rollback deixou import_rows")
		}
	})

	t.Run("reread sees the amount committed under the lock", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 1)
		id := uuid.MustParse(fix.ids[0]).String()
		release, held, done := holdInvoices(t, d, scope, []string{id}, true, func(ctx context.Context, tx *db.Tx) error {
			return tx.Exec(ctx, `update invoices set amount_cents = 2500 where id = $1::uuid`, id)
		})
		defer finishHold(t, release, done)
		waitHeld(t, held)
		errCh := make(chan error, 1)
		outCh := make(chan any, 1)
		go func() {
			out, err := runInvoiceImport(context.Background(), d, scope, fix, true, fix.line(id, "10,00"))
			outCh <- out
			errCh <- err
		}()
		waitAdvisory(t, d, scope, invoiceAdvisoryKey(scope.TenantID, id))
		release()
		sample := importSample(t, importMap(t, waitImport(t, outCh, errCh)))
		if len(sample) != 1 || sample[0]["status"] != "unchanged" {
			t.Fatalf("amostra %#v", sample)
		}
		msgs := messageText(t, sample[0])
		if !strings.Contains(msgs, "25,00") {
			t.Fatalf("releitura não viu o valor commitado: %s", msgs)
		}
		if countWhere(t, d, scope, `select count(*) from invoices where id = $1::uuid and amount_cents = 2500`, id) != 1 {
			t.Fatal("a reimportação alterou a fatura")
		}
		rows := importRows(t, d, scope, fix.source)
		if len(rows) != 1 || rows[0]["status"] != "unchanged" || rows[0]["entity_id"] != id {
			t.Fatalf("import_rows %#v", rows)
		}
	})

	t.Run("error before import rows rolls the new invoice back", func(t *testing.T) {
		fix := newImportLockFix(t, d, scope, 1)
		fresh := "novo-" + uuid.NewString()[:8]
		beforeImportRows = func(context.Context, *db.Tx) error {
			return errors.New("rollback da importação")
		}
		defer func() { beforeImportRows = nil }()
		_, err := runInvoiceImport(context.Background(), d, scope, fix, true, fix.line(fresh, "10,00"))
		if err == nil || !strings.Contains(err.Error(), "rollback da importação") {
			t.Fatal(err)
		}
		if countWhere(t, d, scope, `select count(*) from invoices where external_source = $1 and external_id = $2`, fix.source, fresh) != 0 {
			t.Fatal("fatura nova sobreviveu ao rollback")
		}
		if countWhere(t, d, scope, `select count(*) from import_batches where source = $1`, fix.source) != 0 {
			t.Fatal("lote sobreviveu ao rollback")
		}
	})
}

func openImportLockDB(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip(importLockSkip)
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var name, tenant string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database()`).Scan(&name); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatal(err)
	}
	if name != "nexo_test" {
		t.Fatalf("banco %s recusado; só o laboratório descartável nexo_test pode executar o teste de locks", name)
	}
	parsed, err := uuid.Parse(tenant)
	if err != nil {
		t.Fatal(err)
	}
	return d, tenancy.Scope{TenantID: parsed.String()}
}

func newImportLockFix(t *testing.T, d *db.DB, scope tenancy.Scope, invoices int) importLockFix {
	t.Helper()
	fix := importLockFix{
		source: "lr" + strings.ReplaceAll(uuid.NewString(), "-", ""),
		sub:    "s" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12],
		con:    "c" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12],
		ext:    map[string]string{},
	}
	if len(fix.source) > 40 {
		fix.source = fix.source[:40]
	}
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		ctx := context.Background()
		var sub, con string
		if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, external_source, external_id) values ($1::uuid, 'Assinante reimportacao', $2, $3) returning id::text`, scope.TenantID, fix.source, fix.sub).Scan(&sub); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, external_source, external_id)
select $1::uuid, $2::uuid, plan_version_id, 10, $3, $4 from contracts limit 1 returning id::text`, scope.TenantID, sub, fix.source, fix.con).Scan(&con); err != nil {
			return fmt.Errorf("tenant sem contrato para a pré-condição: %w", err)
		}
		for i := 0; i < invoices; i++ {
			ext := fmt.Sprintf("e%d%s", i, strings.ReplaceAll(uuid.NewString(), "-", "")[:10])
			var id string
			if err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, external_source, external_id)
values ($1::uuid, $2::uuid, $3::uuid, 'manual', '2026-12-20', 1000, $4, $5) returning id::text`, scope.TenantID, con, sub, fix.source, ext).Scan(&id); err != nil {
				return err
			}
			id = uuid.MustParse(id).String()
			fix.ids = append(fix.ids, id)
			fix.ext[id] = ext
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return fix
}

func (f importLockFix) line(idOrExt, valor string) string {
	ext := idOrExt
	if mapped, ok := f.ext[idOrExt]; ok {
		ext = mapped
	}
	return strings.Join([]string{ext, f.sub, f.con, "2026-12-20", valor, "aberto"}, ",")
}

func runInvoiceImport(ctx context.Context, d *db.DB, scope tenancy.Scope, fix importLockFix, apply bool, lines ...string) (any, error) {
	ctx = auth.With(ctx, &auth.Ctx{UserID: uuid.NewString(), TenantID: scope.TenantID, Role: "admin", Scope: scope})
	csv := "id_externo,id_externo_assinante,id_externo_contrato,vencimento,valor,situacao\n" + strings.Join(lines, "\n") + "\n"
	return Service{DB: d}.importCSV(ctx, map[string]any{"kind": "invoices", "source": fix.source, "filename": "titulos.csv", "csv": csv}, apply)
}

func holdInvoices(t *testing.T, d *db.DB, scope tenancy.Scope, ids []string, commit bool, mutate func(context.Context, *db.Tx) error) (func(), <-chan struct{}, <-chan error) {
	t.Helper()
	releaseCh := make(chan struct{})
	held := make(chan struct{})
	done := make(chan error, 1)
	var once sync.Once
	release := func() { once.Do(func() { close(releaseCh) }) }
	go func() {
		done <- d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			ctx := context.Background()
			if err := finance.LockInvoices(ctx, tx, scope.TenantID, ids...); err != nil {
				return err
			}
			if mutate != nil {
				if err := mutate(ctx, tx); err != nil {
					return err
				}
			}
			close(held)
			<-releaseCh
			if commit {
				return nil
			}
			return errImportLockRollback
		})
	}()
	return release, held, done
}

func finishHold(t *testing.T, release func(), done <-chan error) {
	t.Helper()
	release()
	select {
	case err := <-done:
		if err != nil && !errors.Is(err, errImportLockRollback) {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("rival não encerrou")
	}
}

func waitHeld(t *testing.T, held <-chan struct{}) {
	t.Helper()
	select {
	case <-held:
	case <-time.After(8 * time.Second):
		t.Fatal("lock do rival não adquirido")
	}
}

func waitAdvisory(t *testing.T, d *db.DB, scope tenancy.Scope, key string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	for {
		if ctx.Err() != nil {
			t.Fatal("advisory não entrou em espera")
		}
		var n int
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select count(*) from pg_locks
where locktype = 'advisory' and not granted and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())
  and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, $2)`, key, importAdvisorySalt).Scan(&n)
		})
		if err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func grantedAdvisories(t *testing.T, d *db.DB, scope tenancy.Scope, key string) int {
	t.Helper()
	var n int
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from pg_locks
where locktype = 'advisory' and granted and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())
  and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, $2)`, key, importAdvisorySalt).Scan(&n)
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func invoiceRowFree(t *testing.T, d *db.DB, scope tenancy.Scope, id string) bool {
	t.Helper()
	var free bool
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		rows, err := tx.Objects(context.Background(), `select id::text as id from invoices where id = $1::uuid for update skip locked`, id)
		if err != nil {
			return err
		}
		free = len(rows) == 1
		return errImportLockRollback
	})
	if !errors.Is(err, errImportLockRollback) {
		t.Fatal(err)
	}
	return free
}

func invoiceNowait(d *db.DB, scope tenancy.Scope, ids ...string) error {
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if _, err := tx.Objects(context.Background(), `select id::text as id from invoices where id = any($1::uuid[]) order by id for update nowait`, ids); err != nil {
			return err
		}
		return errImportLockRollback
	})
	if errors.Is(err, errImportLockRollback) {
		return nil
	}
	return err
}

func lockTimeout(d *db.DB, scope tenancy.Scope, ids ...string) error {
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		ctx := context.Background()
		if err := tx.Exec(ctx, `select set_config('lock_timeout', '400ms', true)`); err != nil {
			return err
		}
		if err := finance.LockInvoices(ctx, tx, scope.TenantID, ids...); err != nil {
			return err
		}
		return errImportLockRollback
	})
	if errors.Is(err, errImportLockRollback) {
		return nil
	}
	return err
}

func isLockTimeout(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "55P03"
}

func countWhere(t *testing.T, d *db.DB, scope tenancy.Scope, sql string, args ...any) int {
	t.Helper()
	var n int
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), sql, args...).Scan(&n)
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func importRows(t *testing.T, d *db.DB, scope tenancy.Scope, source string) []map[string]string {
	t.Helper()
	var rows []jsonx.Object
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		var err error
		rows, err = tx.Objects(context.Background(), `select ir.external_id, ir.status, ir.entity_id::text as entity_id
from import_rows ir join import_batches b on b.id = ir.batch_id
where b.source = $1 order by ir.row_number`, source)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	out := make([]map[string]string, 0, len(rows))
	for _, row := range rows {
		entity := ""
		if row.Get("entity_id") != nil {
			entity = uuid.MustParse(fmt.Sprint(row.Get("entity_id"))).String()
		}
		out = append(out, map[string]string{
			"external_id": fmt.Sprint(row.Get("external_id")),
			"status":      fmt.Sprint(row.Get("status")),
			"entity_id":   entity,
		})
	}
	return out
}

func waitImport(t *testing.T, outCh <-chan any, errCh <-chan error) any {
	t.Helper()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("importação não concluiu")
	}
	select {
	case out := <-outCh:
		return out
	case <-time.After(time.Second):
		t.Fatal("importação não devolveu resposta")
	}
	return nil
}

func importMap(t *testing.T, v any) map[string]any {
	t.Helper()
	out, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("resposta %T", v)
	}
	return out
}

func importSample(t *testing.T, out map[string]any) []map[string]any {
	t.Helper()
	sample, ok := out["sample"].([]map[string]any)
	if !ok {
		t.Fatalf("sample %T", out["sample"])
	}
	return sample
}

func importTotals(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	totals, ok := out["totals"].(map[string]any)
	if !ok {
		t.Fatalf("totals %T", out["totals"])
	}
	return totals
}

func messageText(t *testing.T, row map[string]any) string {
	t.Helper()
	msgs, ok := row["messages"].([]string)
	if !ok {
		t.Fatalf("messages %T", row["messages"])
	}
	return strings.Join(msgs, " ")
}

func sortedUUIDs(t *testing.T, ids []string) []string {
	t.Helper()
	out := append([]string(nil), ids...)
	for i := range out {
		parsed, err := uuid.Parse(out[i])
		if err != nil {
			t.Fatal(err)
		}
		out[i] = parsed.String()
	}
	slices.Sort(out)
	return out
}

func invoiceAdvisoryKey(tenant, id string) string {
	return uuid.MustParse(tenant).String() + ":invoice:" + uuid.MustParse(id).String()
}
