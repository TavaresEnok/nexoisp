package finance

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
)

const lockTestSkip = "NEXO_GO_TEST_DATABASE_URL ausente; este skip não é teste de banco aprovado. A gerência precisa executar tests/contrato/nativo.py e tests/contrato/go_integration.py num PostgreSQL descartável antes de publicar"

var errLockTestRollback = errors.New("rollback lock test")

func TestCanonicalInvoiceIDs(t *testing.T) {
	if err := LockInvoices(context.Background(), nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := LockInvoices(context.Background(), nil, "", "nao-e-uuid"); err == nil {
		t.Fatal("id inválido foi aceito")
	}
	high := "FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF"
	low := "{00000000-0000-4000-8000-000000000001}"
	mid := "00000000-0000-4000-8000-000000000002"
	got, err := canonicalInvoiceIDs([]string{" " + high + " ", low, strings.ToLower(high), mid, low})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000002",
		"ffffffff-ffff-4fff-bfff-ffffffffffff",
	}
	if len(got) != len(want) {
		t.Fatalf("ids %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ordem %v", got)
		}
	}
}

func TestLockInvoicesProtocol(t *testing.T) {
	d, scope, contract := openLockDatabase(t)
	ctx := context.Background()
	amountOf := map[string]float64{}
	a := insertLockInvoice(t, d, scope, contract, 1000)
	b := insertLockInvoice(t, d, scope, contract, 2500)
	c := insertLockInvoice(t, d, scope, contract, 4000)
	amountOf[a], amountOf[b], amountOf[c] = 1000, 2500, 4000
	sorted := canonicalOrFatal(t, []string{c, a, b})
	expected := amountOf[sorted[0]] + amountOf[sorted[1]]

	t.Run("dedup and scope tenant", func(t *testing.T) {
		release, held, done := startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			if err := LockInvoices(ctx, tx, "", strings.ToUpper(sorted[0]), sorted[1], sorted[0]); err != nil {
				return err
			}
			if err := LockInvoices(ctx, tx, scope.TenantID, sorted[1], sorted[0]); err != nil {
				return err
			}
			advisories, err := heldAdvisories(ctx, tx, scope.TenantID, sorted[:2])
			if err != nil {
				return err
			}
			if advisories != 2 {
				return fmt.Errorf("locks advisory=%d", advisories)
			}
			return nil
		})
		defer release()
		waitAcquired(t, held, done)
		locked, err := rowsLockedByOthers(ctx, d, scope, sorted[:2])
		if err != nil {
			t.Fatal(err)
		}
		if locked != 2 {
			t.Fatalf("linhas travadas=%d", locked)
		}
		nowaitErr := nowaitInvoices(ctx, d, scope, sorted[:2])
		var pg *pgconn.PgError
		if !errors.As(nowaitErr, &pg) || pg.Code != "55P03" {
			t.Fatalf("FOR UPDATE NOWAIT não viu a linha travada: %v", nowaitErr)
		}
		release()
		if err := <-done; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("inverse order excludes", func(t *testing.T) {
		release, held, done := startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return LockInvoices(ctx, tx, scope.TenantID, sorted[1], sorted[0])
		})
		defer release()
		waitAcquired(t, held, done)
		waiter := make(chan error, 1)
		go func() {
			waiter <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := tx.Exec(ctx, `select set_config('lock_timeout', '400ms', true)`); err != nil {
					return err
				}
				return LockInvoices(ctx, tx, "", sorted[0], sorted[1])
			})
		}()
		var pg *pgconn.PgError
		if err := <-waiter; !errors.As(err, &pg) || pg.Code != "55P03" {
			t.Fatalf("a segunda transação não esperou o lock: %v", err)
		}
		release()
		if err := <-done; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := LockInvoices(ctx, tx, "", sorted[0], sorted[1]); err != nil {
				return err
			}
			return errLockTestRollback
		})
		if !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("inverse overlap does not deadlock", func(t *testing.T) {
		runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		ready := make(chan struct{})
		start := make(chan struct{})
		errCh := make(chan error, 2)
		inputs := [][]string{{sorted[1], sorted[0]}, {sorted[2], sorted[1]}}
		for _, input := range inputs {
			go func(input []string) {
				errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
					select {
					case ready <- struct{}{}:
					case <-runCtx.Done():
						return runCtx.Err()
					}
					select {
					case <-start:
					case <-runCtx.Done():
						return runCtx.Err()
					}
					if err := LockInvoices(runCtx, tx, "", input...); err != nil {
						return err
					}
					return errLockTestRollback
				})
			}(input)
		}
		for range inputs {
			select {
			case <-ready:
			case err := <-errCh:
				t.Fatal(err)
			case <-runCtx.Done():
				t.Fatal(runCtx.Err())
			}
		}
		close(start)
		for range inputs {
			if err := <-errCh; !errors.Is(err, errLockTestRollback) {
				t.Fatalf("sobreposição inversa não concluiu: %v", err)
			}
		}
	})

	t.Run("cancel while waiting", func(t *testing.T) {
		release, held, done := startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return LockInvoices(ctx, tx, "", sorted[0])
		})
		defer release()
		waitAcquired(t, held, done)
		waitCtx, waitCancel := context.WithCancel(ctx)
		waiter := make(chan error, 1)
		go func() {
			waiter <- d.WithScope(waitCtx, scope, func(tx *db.Tx) error {
				return LockInvoices(waitCtx, tx, "", sorted[0])
			})
		}()
		obs, obsCancel := context.WithTimeout(ctx, 5*time.Second)
		defer obsCancel()
		if err := waitFor(obs, d, scope, `select count(*) from pg_locks
where locktype = 'advisory' and not granted and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())
  and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, $2)`,
			scope.TenantID+":invoice:"+sorted[0], invoiceAdvisorySalt); err != nil {
			t.Fatal(err)
		}
		waitCancel()
		select {
		case err := <-waiter:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelamento: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("o cancelamento não desbloqueou a espera")
		}
		release()
		if err := <-done; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("tenant isolation", func(t *testing.T) {
		other := uuid.NewString()
		release, held, holderDone := startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return LockInvoices(ctx, tx, "", sorted[0])
		})
		defer release()
		waitAcquired(t, held, holderDone)
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return LockInvoices(ctx, tx, other, sorted[0])
		})
		if err == nil {
			t.Fatal("tenant divergente foi aceito")
		}
		isolated := make(chan error, 1)
		go func() {
			isolated <- d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
				if err := LockInvoices(ctx, tx, other, sorted[0]); err != nil {
					return err
				}
				advisories, err := heldAdvisories(ctx, tx, other, []string{sorted[0]})
				if err != nil {
					return err
				}
				if advisories != 1 {
					return fmt.Errorf("isolamento advisory=%d", advisories)
				}
				var rows int
				if err = tx.QueryRow(ctx, `select count(*) from invoices where id = $1::uuid and tenant_id = $2::uuid`, sorted[0], other).Scan(&rows); err != nil {
					return err
				}
				if rows != 0 {
					return fmt.Errorf("isolamento linhas=%d", rows)
				}
				return errLockTestRollback
			})
		}()
		select {
		case err := <-isolated:
			if !errors.Is(err, errLockTestRollback) {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("o outro tenant esperou o lock da fatura")
		}
		locked, err := rowsLockedByOthers(ctx, d, scope, []string{sorted[0]})
		if err != nil {
			t.Fatal(err)
		}
		if locked != 1 {
			t.Fatalf("o tenant original não manteve a linha travada: %d", locked)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("nested reuse keeps the same locks", func(t *testing.T) {
		release, held, done := startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			if err := LockInvoices(ctx, tx, "", sorted[1], sorted[0]); err != nil {
				return err
			}
			if err := LockInvoices(ctx, tx, "", sorted[0]); err != nil {
				return err
			}
			advisories, err := heldAdvisories(ctx, tx, scope.TenantID, sorted[:2])
			if err != nil {
				return err
			}
			if advisories != 2 {
				return fmt.Errorf("reuso advisory=%d", advisories)
			}
			return nil
		})
		defer release()
		waitAcquired(t, held, done)
		waiter := make(chan error, 1)
		go func() {
			waiter <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := tx.Exec(ctx, `select set_config('lock_timeout', '300ms', true)`); err != nil {
					return err
				}
				return LockInvoices(ctx, tx, "", sorted[0])
			})
		}()
		var pg *pgconn.PgError
		if err := <-waiter; !errors.As(err, &pg) || pg.Code != "55P03" {
			t.Fatalf("reuso não manteve a exclusão: %v", err)
		}
		release()
		if err := <-done; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("agreement keeps validation and balance", func(t *testing.T) {
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			var user string
			if err := tx.QueryRow(ctx, `select coalesce((select id::text from users where tenant_id = app_tenant() order by id limit 1), '00000000-0000-0000-0000-000000000000')`).Scan(&user); err != nil {
				return err
			}
			foreign := uuid.NewString()
			_, err := Agreement(ctx, tx, scope.TenantID, user, contract, map[string]any{
				"invoice_ids":    []any{sorted[0], foreign},
				"installments":   float64(2),
				"first_due_date": "2026-12-01",
				"reason":         "acordo recusado no teste",
			})
			var api *apierr.Error
			if !errors.As(err, &api) || api.Status != 400 {
				return fmt.Errorf("validação do acordo: %v", err)
			}
			var status string
			if err = tx.QueryRow(ctx, `select status from invoices where id = $1`, sorted[0]).Scan(&status); err != nil {
				return err
			}
			if status != "open" {
				return fmt.Errorf("fatura alterada na recusa: %s", status)
			}
			result, err := Agreement(ctx, tx, scope.TenantID, user, contract, map[string]any{
				"invoice_ids":    []any{strings.ToUpper(sorted[1]), sorted[0], sorted[0]},
				"installments":   float64(2),
				"first_due_date": "2026-12-01",
				"reason":         "acordo do teste de lock",
			})
			if err != nil {
				return err
			}
			if num(result["total_cents"]) != expected {
				return fmt.Errorf("total %v", result["total_cents"])
			}
			var canceled, paid int
			var transferred int64
			if err = tx.QueryRow(ctx, `select count(*) from invoices where id = any($1::uuid[]) and status = 'canceled'`, []string{sorted[0], sorted[1]}).Scan(&canceled); err != nil {
				return err
			}
			if err = tx.QueryRow(ctx, `select count(*) from payments where invoice_id = any($1::uuid[])`, []string{sorted[0], sorted[1]}).Scan(&paid); err != nil {
				return err
			}
			if err = tx.QueryRow(ctx, `select coalesce(sum(transferred_cents), 0)::bigint from agreement_sources where agreement_id = $1`, result["id"]).Scan(&transferred); err != nil {
				return err
			}
			var installments int64
			if err = tx.QueryRow(ctx, `select coalesce(sum(amount_cents), 0)::bigint from invoices where agreement_id = $1`, result["id"]).Scan(&installments); err != nil {
				return err
			}
			if canceled != 2 || paid != 0 || transferred != int64(expected) || installments != int64(expected) {
				return fmt.Errorf("saldo canceled=%d paid=%d transferred=%d installments=%d", canceled, paid, transferred, installments)
			}
			return errLockTestRollback
		})
		if !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})
}

func canonicalOrFatal(t *testing.T, ids []string) []string {
	t.Helper()
	got, err := canonicalInvoiceIDs(ids)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func openLockDatabase(t *testing.T) (*db.DB, tenancy.Scope, string) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip(lockTestSkip)
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var name, tenant, contract string
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
	scope := tenancy.Scope{TenantID: tenant}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select id::text from contracts order by id limit 1`).Scan(&contract)
	}); err != nil {
		t.Fatal(err)
	}
	return d, scope, contract
}

func insertLockInvoice(t *testing.T, d *db.DB, scope tenancy.Scope, contract string, cents int) string {
	t.Helper()
	var id string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
select tenant_id, id, subscriber_id, 'manual', '2026-12-20', $2 from contracts where id = $1 returning id::text`, contract, cents).Scan(&id)
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func heldAdvisories(ctx context.Context, tx *db.Tx, tenant string, ids []string) (int, error) {
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = tenant + ":invoice:" + id
	}
	var n int
	err := tx.QueryRow(ctx, `select count(*) from pg_locks
where locktype = 'advisory' and granted and pid = pg_backend_pid() and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())
  and ((classid::bigint << 32) | objid::bigint) in (
    select hashtextextended(k, $2) from unnest($1::text[]) k
  )`, keys, invoiceAdvisorySalt).Scan(&n)
	return n, err
}

func rowsLockedByOthers(ctx context.Context, d *db.DB, scope tenancy.Scope, ids []string) (int, error) {
	var locked int
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var total int
		if err := tx.QueryRow(ctx, `select count(*) from invoices where id = any($1::uuid[])`, ids).Scan(&total); err != nil {
			return err
		}
		rows, err := tx.Objects(ctx, `select id::text as id from invoices where id = any($1::uuid[]) order by id for update skip locked`, ids)
		if err != nil {
			return err
		}
		locked = total - len(rows)
		return errLockTestRollback
	})
	if errors.Is(err, errLockTestRollback) {
		return locked, nil
	}
	return locked, err
}

func nowaitInvoices(ctx context.Context, d *db.DB, scope tenancy.Scope, ids []string) error {
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if _, err := tx.Objects(ctx, `select id::text as id from invoices where id = any($1::uuid[]) order by id for update nowait`, ids); err != nil {
			return err
		}
		return errLockTestRollback
	})
	if errors.Is(err, errLockTestRollback) {
		return nil
	}
	return err
}

func waitAcquired(t *testing.T, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("lock não adquirido")
	}
}

func startHolder(t *testing.T, d *db.DB, scope tenancy.Scope, fn func(context.Context, *db.Tx) error) (func(), <-chan struct{}, <-chan error) {
	t.Helper()
	releaseCh := make(chan struct{})
	held := make(chan struct{})
	done := make(chan error, 1)
	var once sync.Once
	release := func() { once.Do(func() { close(releaseCh) }) }
	go func() {
		done <- d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			if err := fn(context.Background(), tx); err != nil {
				return err
			}
			close(held)
			<-releaseCh
			return errLockTestRollback
		})
	}()
	return release, held, done
}

func waitFor(ctx context.Context, d *db.DB, scope tenancy.Scope, sql string, args ...any) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var n int
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, sql, args...).Scan(&n)
		})
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		timer := time.NewTimer(2 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func TestIssuanceReceiptLockOrder(t *testing.T) {
	d, scope, contract := openLockDatabase(t)
	ctx := context.Background()
	request, item := prepareLockIssuance(t, d, scope, contract)
	other := insertLockInvoice(t, d, scope, contract, 3300)

	t.Run("receipt waits on advisory before the invoice row", func(t *testing.T) {
		release, held, holderDone := holdAdvisories(t, d, scope, []string{request.InvoiceID})
		defer release()
		waitAcquired(t, held, holderDone)
		runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				if err := tx.Exec(runCtx, `select set_config('lock_timeout', '2s', true)`); err != nil {
					return err
				}
				return walkIssuanceReceipt(runCtx, tx, item.ID, request)
			})
		}()
		err := finishWhileRowsFree(t, d, scope, []string{request.InvoiceID}, done)
		if !lockWait(err) {
			t.Fatalf("emissão não esperou o advisory: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("nested receipt keeps exclusion for the inverse set", func(t *testing.T) {
		entered := make(chan struct{})
		releaseWalk := make(chan struct{})
		walkDone := make(chan error, 1)
		go func() {
			walkDone <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := walkIssuanceReceipt(ctx, tx, item.ID, request); err != nil {
					return err
				}
				close(entered)
				<-releaseWalk
				return errLockTestRollback
			})
		}()
		select {
		case <-entered:
		case err := <-walkDone:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("o recebimento não concluiu o lock")
		}
		rival := make(chan error, 1)
		go func() {
			rival <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := tx.Exec(ctx, `select set_config('lock_timeout', '400ms', true)`); err != nil {
					return err
				}
				return LockInvoices(ctx, tx, "", other, request.InvoiceID)
			})
		}()
		var pg *pgconn.PgError
		if err := <-rival; !errors.As(err, &pg) || pg.Code != "55P03" {
			t.Fatalf("conjunto inverso não esperou o recebimento: %v", err)
		}
		close(releaseWalk)
		if err := <-walkDone; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("inverse arrival times out then receipt completes", func(t *testing.T) {
		release, held, holderDone := startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return LockInvoices(ctx, tx, "", other, request.InvoiceID)
		})
		defer release()
		waitAcquired(t, held, holderDone)
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := tx.Exec(ctx, `select set_config('lock_timeout', '400ms', true)`); err != nil {
				return err
			}
			return walkIssuanceReceipt(ctx, tx, item.ID, request)
		})
		var pg *pgconn.PgError
		if !errors.As(err, &pg) || pg.Code != "55P03" {
			t.Fatalf("chegada inversa não esperou o protocolo: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
		err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := walkIssuanceReceipt(ctx, tx, item.ID, request); err != nil {
				return err
			}
			return errLockTestRollback
		})
		if !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("inverse overlap does not deadlock", func(t *testing.T) {
		runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		ready := make(chan struct{})
		start := make(chan struct{})
		errCh := make(chan error, 2)
		go func() {
			errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				select {
				case ready <- struct{}{}:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				select {
				case <-start:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				if err := walkIssuanceReceipt(runCtx, tx, item.ID, request); err != nil {
					return err
				}
				return errLockTestRollback
			})
		}()
		go func() {
			errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				select {
				case ready <- struct{}{}:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				select {
				case <-start:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				if err := LockInvoices(runCtx, tx, "", other, request.InvoiceID); err != nil {
					return err
				}
				return errLockTestRollback
			})
		}()
		for range 2 {
			select {
			case <-ready:
			case err := <-errCh:
				t.Fatal(err)
			case <-runCtx.Done():
				t.Fatal(runCtx.Err())
			}
		}
		close(start)
		for range 2 {
			if err := <-errCh; !errors.Is(err, errLockTestRollback) {
				t.Fatalf("sobreposição da emissão: %v", err)
			}
		}
	})

	t.Run("prepare waits on advisory before the invoice row", func(t *testing.T) {
		fresh := insertLockInvoice(t, d, scope, contract, 12345)
		freshRequest := efiRequest(t, d, scope, fresh, 12345, "2026-12-20")
		release, held, holderDone := holdAdvisories(t, d, scope, []string{fresh})
		defer release()
		waitAcquired(t, held, holderDone)
		runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := (SandboxIssuance{DB: d}).Prepare(runCtx, scope, freshRequest, strings.Repeat("a", 64))
			done <- err
		}()
		err := finishWhileRowsFree(t, d, scope, []string{fresh}, done)
		if !lockWait(err) {
			t.Fatalf("prepare não esperou o advisory: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
		if _, err := (SandboxIssuance{DB: d}).Prepare(ctx, scope, freshRequest, strings.Repeat("a", 64)); err != nil {
			t.Fatal(err)
		}
	})
}

func TestGatewayReconcileLockOrder(t *testing.T) {
	d, scope, contract := openLockDatabase(t)
	ctx := context.Background()
	t.Setenv("NEXO_DEMO_MODE", "1")
	connection, invoices, charges := seedGatewayCharges(t, d, scope, contract)
	ids := chargedInvoiceIDs(t, d, scope)
	if len(ids) < 2 {
		t.Fatalf("conjunto da conciliação tem %d faturas", len(ids))
	}
	highest := ids[len(ids)-1]
	lower := append([]string(nil), ids[:len(ids)-1]...)
	conn := jsonx.Object{{Name: "tenant_id", Value: scope.TenantID}, {Name: "id", Value: connection}}

	t.Run("reconcile waits on the last advisory before any invoice row", func(t *testing.T) {
		release, held, holderDone := holdAdvisories(t, d, scope, []string{highest})
		defer release()
		waitAcquired(t, held, holderDone)
		runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				if err := tx.Exec(runCtx, `select set_config('lock_timeout', '2s', true)`); err != nil {
					return err
				}
				_, err := Reconcile(runCtx, tx, scope.TenantID)
				return err
			})
		}()
		err := finishWhileRowsFree(t, d, scope, lower, done)
		if !lockWait(err) {
			t.Fatalf("conciliação não esperou o advisory: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
			t.Fatal(err)
		}
	})

	t.Run("reconcile inverse overlap does not deadlock", func(t *testing.T) {
		runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		ready := make(chan struct{})
		start := make(chan struct{})
		errCh := make(chan error, 2)
		go func() {
			errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				select {
				case ready <- struct{}{}:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				select {
				case <-start:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				if _, err := Reconcile(runCtx, tx, scope.TenantID); err != nil {
					return err
				}
				return errLockTestRollback
			})
		}()
		go func() {
			errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				select {
				case ready <- struct{}{}:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				select {
				case <-start:
				case <-runCtx.Done():
					return runCtx.Err()
				}
				if err := LockInvoices(runCtx, tx, "", highest, ids[0]); err != nil {
					return err
				}
				return errLockTestRollback
			})
		}()
		for range 2 {
			select {
			case <-ready:
			case err := <-errCh:
				t.Fatal(err)
			case <-runCtx.Done():
				t.Fatal(runCtx.Err())
			}
		}
		close(start)
		for range 2 {
			if err := <-errCh; !errors.Is(err, errLockTestRollback) {
				t.Fatalf("sobreposição da conciliação: %v", err)
			}
		}
	})

	for _, kind := range []string{"payment.refunded", "payment.confirmed"} {
		t.Run("event "+kind+" waits on advisory before the invoice row", func(t *testing.T) {
			before := invoiceStatus(t, d, scope, invoices[0])
			release, held, holderDone := holdAdvisories(t, d, scope, []string{invoices[0]})
			defer release()
			waitAcquired(t, held, holderDone)
			runCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := Event(runCtx, d, conn, gatewayEvent(kind, charges[0]))
				done <- err
			}()
			err := finishWhileRowsFree(t, d, scope, []string{invoices[0]}, done)
			if !lockWait(err) {
				t.Fatalf("evento %s não esperou o advisory: %v", kind, err)
			}
			release()
			if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
				t.Fatal(err)
			}
			if got := invoiceStatus(t, d, scope, invoices[0]); got != before {
				t.Fatalf("evento alterou a fatura sem commit de lock: %s", got)
			}
		})
	}
}

func prepareLockIssuance(t *testing.T, d *db.DB, scope tenancy.Scope, contract string) (providers.Create, Issuance) {
	t.Helper()
	var invoice string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) select tenant_id,id,subscriber_id,'manual','2026-11-15',12345 from contracts where id=$1 returning id::text`, contract).Scan(&invoice)
	})
	if err != nil {
		t.Fatal(err)
	}
	request := efiRequest(t, d, scope, invoice, 12345, "2026-11-15")
	item, err := (SandboxIssuance{DB: d}).Prepare(context.Background(), scope, request, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	return request, item
}

func efiRequest(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string, cents int64, due string) providers.Create {
	t.Helper()
	ctx := context.Background()
	account := uuid.NewString()
	var connection string
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if invoice == "" {
			return errors.New("fatura ausente")
		}
		return tx.QueryRow(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name) select tenant_id,company_id,'efi','sandbox',$2,'lock order issuance' from invoices where id=$1::uuid returning id::text`, invoice, account).Scan(&connection)
	})
	if err != nil {
		t.Fatal(err)
	}
	return providers.Create{Scope: providers.Scope{TenantID: scope.TenantID, ConnectionID: connection, Provider: "efi", Environment: "sandbox", AccountRef: account}, IntentKey: uuid.NewString(), InvoiceID: invoice, Money: providers.Money{Cents: cents, Currency: "BRL"}, DueDate: due}
}

func walkIssuanceReceipt(ctx context.Context, tx *db.Tx, issuanceID string, request providers.Create) error {
	if err := lockIssuanceInvoice(ctx, tx, issuanceID); err != nil {
		return err
	}
	receipt := request
	receipt.Scope.ConnectionID = ""
	err := applyProviderSnapshot(ctx, tx, request.Scope.TenantID, issuanceID, receipt, providers.Snapshot{
		Payments: []providers.Payment{{ID: "lock-order-payment", AmountCents: request.Money.Cents, PaidAt: "2026-10-29T12:00:00Z", Method: "pix", Currency: "BRL"}},
	})
	var api *apierr.Error
	if !errors.As(err, &api) || api.Status != 409 {
		return fmt.Errorf("recebimento após o lock: %v", err)
	}
	return nil
}

func seedGatewayCharges(t *testing.T, d *db.DB, scope tenancy.Scope, contract string) (string, []string, []string) {
	t.Helper()
	ctx := context.Background()
	var connection string
	invoices := make([]string, 0, 2)
	charges := make([]string, 0, 2)
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		for _, cents := range []int{1100, 2200} {
			var id string
			if err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
select tenant_id, id, subscriber_id, 'manual', '2026-12-20', $2 from contracts where id = $1 returning id::text`, contract, cents).Scan(&id); err != nil {
				return err
			}
			if connection == "" {
				if err := tx.QueryRow(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name,status)
select tenant_id, company_id, 'demo', 'sandbox', $2, 'lock order demo', 'active' from invoices where id=$1::uuid returning id::text`, id, uuid.NewString()).Scan(&connection); err != nil {
					return err
				}
			}
			charge := uuid.NewString()
			if err := tx.Exec(ctx, `update invoices set financial_connection_id=$2::uuid, gateway='demo', gateway_charge_id=$3 where id=$1::uuid`, id, connection, charge); err != nil {
				return err
			}
			invoices = append(invoices, id)
			charges = append(charges, charge)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return connection, invoices, charges
}

func chargedInvoiceIDs(t *testing.T, d *db.DB, scope tenancy.Scope) []string {
	t.Helper()
	var ids []string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		rows, err := tx.Objects(context.Background(), `select id::text as id from invoices where status in ('open','reconciling') and gateway_charge_id is not null order by id::text`)
		if err != nil {
			return err
		}
		for _, row := range rows {
			ids = append(ids, row.Get("id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

func invoiceStatus(t *testing.T, d *db.DB, scope tenancy.Scope, id string) string {
	t.Helper()
	var status string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select status from invoices where id=$1::uuid`, id).Scan(&status)
	})
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func gatewayEvent(kind, charge string) jsonx.Object {
	ev := jsonx.Object{{Name: "id", Value: uuid.NewString()}, {Name: "type", Value: kind}, {Name: "charge_id", Value: charge}}
	if kind == "payment.confirmed" {
		ev.Set("payment", map[string]any{"id": uuid.NewString(), "amount_cents": int64(1000), "paid_at": "2026-10-29T12:00:00Z", "currency": "BRL", "method": "pix"})
	}
	return ev
}

func holdAdvisories(t *testing.T, d *db.DB, scope tenancy.Scope, ids []string) (func(), <-chan struct{}, <-chan error) {
	t.Helper()
	ordered := canonicalOrFatal(t, ids)
	return startHolder(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
		for _, id := range ordered {
			if err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,$2))`, scope.TenantID+":invoice:"+id, invoiceAdvisorySalt); err != nil {
				return err
			}
		}
		return nil
	})
}

func finishWhileRowsFree(t *testing.T, d *db.DB, scope tenancy.Scope, ids []string, done <-chan error) error {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	poll := time.NewTimer(0)
	defer poll.Stop()
	saw := false
	for {
		if err := nowaitInvoices(context.Background(), d, scope, ids); err != nil {
			t.Fatalf("row lock de invoice antes do advisory: %v", err)
		}
		saw = true
		select {
		case err := <-done:
			if !saw {
				t.Fatal("a espera não foi observada")
			}
			return err
		case <-deadline.C:
			t.Fatal("a transação não encerrou a espera")
		case <-poll.C:
			poll.Reset(2 * time.Millisecond)
		}
	}
}

func lockWait(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var pg *pgconn.PgError
	return errors.As(err, &pg) && (pg.Code == "55P03" || pg.Code == "57014")
}
