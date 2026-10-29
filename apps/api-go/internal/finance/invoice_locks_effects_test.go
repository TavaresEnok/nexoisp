package finance

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
)

// Skip here is not an approved concurrency, RLS or rollback run. Those gates
// stay on tests/contrato/nativo.py, tests/contrato/go_integration.py and a
// disposable PostgreSQL before publication.
const planPaidSkip = "NEXO_GO_TEST_DATABASE_URL ausente; este skip não aprova concorrência, RLS nem rollback. A gerência precisa executar tests/contrato/nativo.py e tests/contrato/go_integration.py num PostgreSQL descartável antes de publicar"

var errPlanPaidRollback = errors.New("rollback do consumidor de efeitos")

type planPaidFixture struct {
	invoice  string
	effect   string
	resource string
	version  int64
	signed   int64
}

type planPaidBooks struct {
	invoiceStatus string
	version       int64
	payments      int64
	signed        int64
	effectStatus  string
	attempts      int64
	outcome       string
	operations    int64
}

func TestPlanPaidEffectLockProtocol(t *testing.T) {
	d, scope := openPlanPaidDatabase(t)
	ctx := context.Background()
	resume := readPlanPaidResume(t, d, scope)
	t.Cleanup(func() { writePlanPaidResume(t, d, scope, resume) })

	t.Run("advisory before invoice effect and resource", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, true)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		release, held, holderDone := holdPlanPaid(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,$2))`, scope.TenantID+":invoice:"+fx.invoice, invoiceAdvisorySalt)
		})
		defer release()
		waitPlanPaidHeld(t, held, holderDone)
		runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- runPlanPaid(runCtx, d, scope, fx.effect, fx.invoice, "2s")
		}()
		err := waitPlanPaidRowsFree(t, d, scope, fx, done)
		if !planPaidLockWait(err) {
			t.Fatalf("consumidor não esperou o advisory: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errPlanPaidRollback) {
			t.Fatal(err)
		}
		assertPlanPaidPending(t, d, scope, fx, before)
	})

	t.Run("invoice row before effect and resource", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, true)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		release, held, holderDone := holdPlanPaid(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			_, err := tx.Objects(ctx, `select id::text as id from invoices where id=$1::uuid for update`, fx.invoice)
			return err
		})
		defer release()
		waitPlanPaidHeld(t, held, holderDone)
		runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- runPlanPaid(runCtx, d, scope, fx.effect, fx.invoice, "2s")
		}()
		err := waitPlanPaidInvoiceHeld(t, d, scope, fx, done)
		if !planPaidLockWait(err) {
			t.Fatalf("consumidor não esperou a fatura: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errPlanPaidRollback) {
			t.Fatal(err)
		}
		assertPlanPaidPending(t, d, scope, fx, before)
	})

	t.Run("resource waits after invoice and effect", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, true)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		release, held, holderDone := holdPlanPaid(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			_, err := tx.Objects(ctx, `select id::text as id from service_resources where id=$1::uuid for update`, fx.resource)
			return err
		})
		defer release()
		waitPlanPaidHeld(t, held, holderDone)
		runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- runPlanPaid(runCtx, d, scope, fx.effect, fx.invoice, "2s")
		}()
		err := waitPlanPaidChildrenHeld(t, d, scope, fx, done)
		if !planPaidLockWait(err) {
			t.Fatalf("consumidor não esperou o recurso depois da fatura: %v", err)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errPlanPaidRollback) {
			t.Fatal(err)
		}
		assertPlanPaidPending(t, d, scope, fx, before)
	})

	t.Run("skip locked does not wait on the effect", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, false)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		release, held, holderDone := holdPlanPaid(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			_, err := tx.Objects(ctx, `select id::text as id from payment_effects where id=$1::uuid for update`, fx.effect)
			return err
		})
		defer release()
		waitPlanPaidHeld(t, held, holderDone)
		err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, "400ms")
		if err != nil {
			t.Fatalf("skip locked esperou ou falhou: %v", err)
		}
		assertPlanPaidPending(t, d, scope, fx, before)
		release()
		if err := <-holderDone; !errors.Is(err, errPlanPaidRollback) {
			t.Fatal(err)
		}
	})

	t.Run("rival lock rolls back then consumer recovers", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, false)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		release, held, holderDone := holdPlanPaid(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return LockInvoices(ctx, tx, scope.TenantID, fx.invoice)
		})
		defer release()
		waitPlanPaidHeld(t, held, holderDone)
		err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, "400ms")
		if !planPaidLockWait(err) {
			t.Fatalf("transação rival não excluiu o consumidor: %v", err)
		}
		assertPlanPaidPending(t, d, scope, fx, before)
		release()
		if err := <-holderDone; !errors.Is(err, errPlanPaidRollback) {
			t.Fatal(err)
		}
		if err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, ""); err != nil {
			t.Fatal(err)
		}
		after := planPaidRead(t, d, scope, fx)
		assertPlanPaidReceipt(t, before, after)
		if after.effectStatus != "ignored" || after.outcome != "automatic resume disabled" || after.attempts != 1 || after.operations != 0 {
			t.Fatalf("recuperação após rollback: %+v", after)
		}
		if err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, ""); err != nil {
			t.Fatal(err)
		}
		replay := planPaidRead(t, d, scope, fx)
		if replay != after {
			t.Fatalf("replay alterou o efeito ou o recebimento: antes=%+v depois=%+v", after, replay)
		}
	})

	t.Run("stale settlement is ignored and receipt stays", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, true)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		fresh := repayPlanPaid(t, d, scope, fx)
		if fresh.version != fx.version+1 || fresh.effect == fx.effect {
			t.Fatalf("nova liquidação: antiga=%+v nova=%+v", fx, fresh)
		}
		if err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, ""); err != nil {
			t.Fatal(err)
		}
		stale := planPaidRead(t, d, scope, fx)
		assertPlanPaidReceipt(t, before, stale)
		if stale.effectStatus != "ignored" || stale.outcome != "settlement superseded or invoice no longer paid" {
			t.Fatalf("versão antiga: %+v", stale)
		}
		next := planPaidRead(t, d, scope, fresh)
		if next.effectStatus != "pending" || next.attempts != 0 || next.version != fresh.version {
			t.Fatalf("efeito novo foi consumido junto com o antigo: %+v", next)
		}
		if next.payments != before.payments || next.signed != before.signed || next.invoiceStatus != "paid" {
			t.Fatalf("recebimento mudou na troca de versão: antes=%+v depois=%+v", before, next)
		}
	})

	t.Run("technical failure rolls back the effect only", func(t *testing.T) {
		writePlanPaidResume(t, d, scope, true)
		fx := seedPlanPaidFixture(t, d, scope)
		before := planPaidRead(t, d, scope, fx)
		err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, "")
		if err == nil || !strings.Contains(err.Error(), "agente") {
			t.Fatalf("falha técnica do recurso: %v", err)
		}
		assertPlanPaidPending(t, d, scope, fx, before)
		writePlanPaidResume(t, d, scope, false)
		if err := runPlanPaid(ctx, d, scope, fx.effect, fx.invoice, ""); err != nil {
			t.Fatal(err)
		}
		after := planPaidRead(t, d, scope, fx)
		assertPlanPaidReceipt(t, before, after)
		if after.effectStatus != "ignored" || after.outcome != "automatic resume disabled" || after.attempts != 1 || after.operations != 0 {
			t.Fatalf("retomada depois da falha técnica: %+v", after)
		}
	})
}

func openPlanPaidDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip(planPaidSkip)
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
		t.Fatalf("banco %s recusado; só o laboratório descartável nexo_test pode executar o teste do consumidor", name)
	}
	return d, tenancy.Scope{TenantID: tenant}
}

func seedPlanPaidFixture(t *testing.T, d *db.DB, scope tenancy.Scope) planPaidFixture {
	t.Helper()
	ctx := context.Background()
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")
	var fx planPaidFixture
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var subscriber, plan, version, contract, device string
		if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, "efeito "+mark).Scan(&subscriber); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into plans (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, "plano efeito "+mark).Scan(&plan); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values ($1::uuid, $2::uuid, 1, 6400, 100000, 50000, 'efeito') returning id::text`, scope.TenantID, plan).Scan(&version); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) values ($1::uuid, $2::uuid, $3::uuid, 15) returning id::text`, scope.TenantID, subscriber, version).Scan(&contract); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into devices (tenant_id, name, driver) values ($1::uuid, $2, 'demo') returning id::text`, scope.TenantID, "nas efeito "+mark).Scan(&device); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into service_resources (tenant_id, contract_id, device_id, pppoe_username, desired_policy, desired_profile, desired_reason)
values ($1::uuid, $2::uuid, $3::uuid, $4, 'suspended', 'bloqueio', 'inadimplência do consumidor de efeitos') returning id::text`, scope.TenantID, contract, device, "fx"+mark[:20]).Scan(&fx.resource); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
values ($1::uuid, $2::uuid, $3::uuid, 'manual', '2026-12-20', 6400) returning id::text`, scope.TenantID, contract, subscriber).Scan(&fx.invoice); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note)
values ($1::uuid, $2::uuid, 6400, '2026-10-29T12:00:00Z', 'pix', 'manual', 'recebimento do consumidor de efeitos')`, scope.TenantID, fx.invoice); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `update invoices set status='paid', paid_at='2026-10-29T12:00:00Z' where id=$1::uuid`, fx.invoice); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select id::text, settlement_version from payment_effects where invoice_id=$1::uuid`, fx.invoice).Scan(&fx.effect, &fx.version)
	})
	if err != nil {
		t.Fatal(err)
	}
	fx.signed = 6400
	return fx
}

func repayPlanPaid(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture) planPaidFixture {
	t.Helper()
	ctx := context.Background()
	fresh := fx
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.Exec(ctx, `update invoices set status='open', paid_at=null where id=$1::uuid`, fx.invoice); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `update invoices set status='paid', paid_at='2026-10-29T12:00:00Z' where id=$1::uuid`, fx.invoice); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select id::text, settlement_version from payment_effects where invoice_id=$1::uuid and settlement_version>$2::bigint`, fx.invoice, fx.version).Scan(&fresh.effect, &fresh.version)
	})
	if err != nil {
		t.Fatal(err)
	}
	return fresh
}

func runPlanPaid(ctx context.Context, d *db.DB, scope tenancy.Scope, effect, invoice, lockTimeout string) error {
	item := jsonx.Object{{Name: "id", Value: effect}, {Name: "invoice_id", Value: invoice}}
	return d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if lockTimeout != "" {
			if err := tx.Exec(ctx, `select set_config('lock_timeout', $1, true)`, lockTimeout); err != nil {
				return err
			}
		}
		return planPaidEffect(ctx, tx, scope.TenantID, item)
	})
}

func planPaidRead(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture) planPaidBooks {
	t.Helper()
	ctx := context.Background()
	var books planPaidBooks
	var outcome *string
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select i.status, i.settlement_version, (select count(*) from payments p where p.invoice_id=i.id), (select coalesce(sum(p.signed_cents),0)::bigint from payments p where p.invoice_id=i.id), e.status, e.attempts, e.outcome, (select count(*) from operations o where o.idempotency_key=$2) from invoices i join payment_effects e on e.invoice_id=i.id and e.id=$3::uuid where i.id=$1::uuid`, fx.invoice, "finance-paid:"+fx.effect, fx.effect).Scan(&books.invoiceStatus, &books.version, &books.payments, &books.signed, &books.effectStatus, &books.attempts, &outcome, &books.operations); err != nil {
			return err
		}
		return errPlanPaidRollback
	})
	if !errors.Is(err, errPlanPaidRollback) {
		t.Fatal(err)
	}
	if outcome != nil {
		books.outcome = *outcome
	}
	return books
}

func assertPlanPaidReceipt(t *testing.T, before, after planPaidBooks) {
	t.Helper()
	if before.invoiceStatus != "paid" || after.invoiceStatus != "paid" || before.payments != 1 || after.payments != before.payments || after.signed != before.signed || before.signed != 6400 {
		t.Fatalf("recebimento alterado: antes=%+v depois=%+v", before, after)
	}
}

func assertPlanPaidPending(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture, before planPaidBooks) {
	t.Helper()
	after := planPaidRead(t, d, scope, fx)
	assertPlanPaidReceipt(t, before, after)
	if after.effectStatus != "pending" || after.attempts != 0 || after.outcome != "" || after.operations != 0 || after.version != before.version {
		t.Fatalf("efeito pendente mudou: antes=%+v depois=%+v", before, after)
	}
}

func readPlanPaidResume(t *testing.T, d *db.DB, scope tenancy.Scope) bool {
	t.Helper()
	ctx := context.Background()
	var enabled bool
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		err := tx.QueryRow(ctx, `select auto_resume_on_payment from tenant_settings where tenant_id=$1::uuid`, scope.TenantID).Scan(&enabled)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return enabled
}

func writePlanPaidResume(t *testing.T, d *db.DB, scope tenancy.Scope, enabled bool) {
	t.Helper()
	ctx := context.Background()
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		n, err := tx.Affected(ctx, `update tenant_settings set auto_resume_on_payment=$2 where tenant_id=$1::uuid`, scope.TenantID, enabled)
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		return tx.Exec(ctx, `insert into tenant_settings (tenant_id, auto_resume_on_payment) values ($1::uuid, $2)`, scope.TenantID, enabled)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func holdPlanPaid(t *testing.T, d *db.DB, scope tenancy.Scope, fn func(context.Context, *db.Tx) error) (func(), <-chan struct{}, <-chan error) {
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
			return errPlanPaidRollback
		})
	}()
	return release, held, done
}

func waitPlanPaidHeld(t *testing.T, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("trava rival não adquirida")
	}
}

func planPaidNowait(ctx context.Context, d *db.DB, scope tenancy.Scope, sql string, arg string) error {
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if _, err := tx.Objects(ctx, sql, arg); err != nil {
			return err
		}
		return errPlanPaidRollback
	})
	if errors.Is(err, errPlanPaidRollback) {
		return nil
	}
	return err
}

func planPaidRowLocked(err error) (bool, error) {
	if err == nil {
		return false, nil
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "55P03" {
		return true, nil
	}
	return false, err
}

func planPaidAdvisoryHeld(ctx context.Context, d *db.DB, scope tenancy.Scope, invoice string) (int, error) {
	var n int
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select count(*) from pg_locks
where locktype='advisory' and granted and objsubid=1
  and database=(select oid from pg_database where datname=current_database())
  and ((classid::bigint << 32) | objid::bigint)=hashtextextended($1,$2)`, scope.TenantID+":invoice:"+invoice, invoiceAdvisorySalt).Scan(&n)
	})
	return n, err
}

func waitPlanPaidRowsFree(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture, done <-chan error) error {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	saw := false
	for {
		if err := planPaidChildrenFree(t, d, scope, fx); err != nil {
			t.Fatal(err)
		}
		saw = true
		select {
		case err := <-done:
			if !saw {
				t.Fatal("a espera no advisory não foi observada")
			}
			return err
		case <-deadline.C:
			t.Fatal("a espera no advisory não encerrou")
		case <-time.After(2 * time.Millisecond):
		}
	}
}

func planPaidChildrenFree(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture) error {
	t.Helper()
	ctx := context.Background()
	checks := []struct {
		name string
		sql  string
		id   string
	}{
		{"fatura", `select id::text as id from invoices where id=$1::uuid for update nowait`, fx.invoice},
		{"efeito", `select id::text as id from payment_effects where id=$1::uuid for update nowait`, fx.effect},
		{"recurso", `select id::text as id from service_resources where id=$1::uuid for update nowait`, fx.resource},
	}
	for _, check := range checks {
		locked, err := planPaidRowLocked(planPaidNowait(ctx, d, scope, check.sql, check.id))
		if err != nil {
			return err
		}
		if locked {
			return errors.New(check.name + " travado antes do advisory")
		}
	}
	return nil
}

func waitPlanPaidInvoiceHeld(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture, done <-chan error) error {
	t.Helper()
	return waitPlanPaidState(t, done, func(ctx context.Context) (bool, error) {
		adv, err := planPaidAdvisoryHeld(ctx, d, scope, fx.invoice)
		if err != nil {
			return false, err
		}
		invoiceLocked, err := planPaidRowLocked(planPaidNowait(ctx, d, scope, `select id::text as id from invoices where id=$1::uuid for update nowait`, fx.invoice))
		if err != nil {
			return false, err
		}
		effectLocked, err := planPaidRowLocked(planPaidNowait(ctx, d, scope, `select id::text as id from payment_effects where id=$1::uuid for update nowait`, fx.effect))
		if err != nil {
			return false, err
		}
		resourceLocked, err := planPaidRowLocked(planPaidNowait(ctx, d, scope, `select id::text as id from service_resources where id=$1::uuid for update nowait`, fx.resource))
		if err != nil {
			return false, err
		}
		if effectLocked || resourceLocked {
			return false, errors.New("efeito ou recurso travado antes da fatura")
		}
		return adv >= 1 && invoiceLocked, nil
	})
}

func waitPlanPaidChildrenHeld(t *testing.T, d *db.DB, scope tenancy.Scope, fx planPaidFixture, done <-chan error) error {
	t.Helper()
	return waitPlanPaidState(t, done, func(ctx context.Context) (bool, error) {
		adv, err := planPaidAdvisoryHeld(ctx, d, scope, fx.invoice)
		if err != nil {
			return false, err
		}
		invoiceLocked, err := planPaidRowLocked(planPaidNowait(ctx, d, scope, `select id::text as id from invoices where id=$1::uuid for update nowait`, fx.invoice))
		if err != nil {
			return false, err
		}
		effectLocked, err := planPaidRowLocked(planPaidNowait(ctx, d, scope, `select id::text as id from payment_effects where id=$1::uuid for update nowait`, fx.effect))
		if err != nil {
			return false, err
		}
		if adv < 1 && (invoiceLocked || effectLocked) {
			return false, errors.New("fatura ou efeito travado antes do advisory")
		}
		return adv >= 1 && invoiceLocked && effectLocked, nil
	})
}

func waitPlanPaidState(t *testing.T, done <-chan error, seen func(context.Context) (bool, error)) error {
	t.Helper()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	ok := false
	for {
		ready, err := seen(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if ready {
			ok = true
		}
		select {
		case err := <-done:
			if !ok {
				t.Fatal("a ordem advisory, fatura e efeito não foi observada")
			}
			return err
		case <-deadline.C:
			t.Fatal("a espera da ordem de locks não encerrou")
		case <-time.After(2 * time.Millisecond):
		}
	}
}

func planPaidLockWait(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var pg *pgconn.PgError
	return errors.As(err, &pg) && (pg.Code == "55P03" || pg.Code == "57014")
}
