package finance

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
)

func issuanceDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL not configured")
	}
	d, err := db.Open(context.Background(), url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var tenant string
	if err = d.WithScope(context.Background(), tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select tenant_id from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatal(err)
	}
	return d, tenancy.Scope{TenantID: tenant}
}
func issuanceFixture(t *testing.T, d *db.DB, scope tenancy.Scope) providers.Create {
	t.Helper()
	ctx := context.Background()
	var invoice, connection string
	account := uuid.NewString()
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) select tenant_id,id,subscriber_id,'manual','2026-11-15',12345 from contracts order by id limit 1 returning id`).Scan(&invoice); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name) select tenant_id,company_id,'efi','sandbox',$2,'B07 transaction test' from invoices where id=$1 returning id`, invoice, account).Scan(&connection)
	}); err != nil {
		t.Fatal(err)
	}
	return providers.Create{Scope: providers.Scope{TenantID: scope.TenantID, ConnectionID: connection, Provider: "efi", Environment: "sandbox", AccountRef: account}, IntentKey: uuid.NewString(), InvoiceID: invoice, Money: providers.Money{Cents: 12345, Currency: "BRL"}, DueDate: "2026-11-15"}
}
func assertReservationConflict(t *testing.T, err error) {
	t.Helper()
	var p *pgconn.PgError
	if !errors.As(err, &p) || p.Code != "N6901" {
		t.Fatalf("expected reservation conflict, got %v", err)
	}
}
func TestIssuanceReservationBlocksFinancialChanges(t *testing.T) {
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	service := SandboxIssuance{DB: d}
	ctx := context.Background()
	item, err := service.Prepare(ctx, scope, r, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, query("ensureCharges", 0))
		if err != nil {
			return err
		}
		for _, row := range rows {
			if row.Get("id") == r.InvoiceID {
				return errors.New("demo scheduler selected a reserved invoice")
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		`update invoices set amount_cents=amount_cents+1 where id=$1`,
		`update invoices set due_date=due_date+1 where id=$1`,
		`update invoices set fee_cents=1 where id=$1`,
		`update invoices set discount_cents=1 where id=$1`,
		`update invoices set status='canceled' where id=$1`,
		`update invoices set status='paid' where id=$1`,
		`update invoices set gateway='demo' where id=$1`,
		`update invoices set provider_issuance_id=null where id=$1`,
		`insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,100,now(),'manual')`,
	} {
		assertReservationConflict(t, d.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, query, r.InvoiceID) }))
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update invoices set status_note='operator observing unknown result' where id=$1`, r.InvoiceID)
	}); err != nil {
		t.Fatal(err)
	}
	// Preparing another account/intent against the same invoice cannot replace it.
	different := r
	different.IntentKey = uuid.NewString()
	if _, err = service.Prepare(ctx, scope, different, strings.Repeat("a", 64)); err == nil {
		t.Fatal("second intention replaced reservation")
	}
	fake := &issuanceFake{request: r}
	if _, err = service.Run(ctx, scope, item.ID, fake); err != nil {
		t.Fatal(err)
	}
	var matches bool
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select j.state='issued' and i.provider_issuance_id=j.id and i.financial_connection_id=j.financial_connection_id and i.gateway='efi' and i.gateway_charge_id=j.charge_id from invoices i join provider_issuance j on j.invoice_id=i.id where i.id=$1`, r.InvoiceID).Scan(&matches)
	}); err != nil || !matches {
		t.Fatalf("binding not atomic %v", err)
	}
	// Receipt is possible after binding; the financial face/charge identity remain frozen.
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,100,now(),'manual')`, r.InvoiceID)
	}); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{`update invoices set amount_cents=amount_cents+1 where id=$1`, `update invoices set gateway_charge_id='another-charge' where id=$1`, `update invoices set status='canceled' where id=$1`} {
		assertReservationConflict(t, d.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, query, r.InvoiceID) }))
	}
}
func TestReceiptWinsBeforeIssuancePreparation(t *testing.T) {
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	service := SandboxIssuance{DB: d}
	ctx := context.Background()
	receiptHeld := make(chan struct{})
	release := make(chan struct{})
	receiptResult := make(chan error, 1)
	go func() {
		receiptResult <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := tx.Exec(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,100,now(),'manual')`, r.InvoiceID); err != nil {
				return err
			}
			close(receiptHeld)
			<-release
			return nil
		})
	}()
	select {
	case <-receiptHeld:
	case err := <-receiptResult:
		t.Fatalf("receipt fixture failed: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("receipt fixture timed out")
	}
	prepared := make(chan error, 1)
	go func() { _, err := service.Prepare(ctx, scope, r, strings.Repeat("a", 64)); prepared <- err }()
	close(release)
	if err := <-receiptResult; err != nil {
		t.Fatal(err)
	}
	assertReservationConflict(t, <-prepared)
	var n int
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select count(*) from provider_issuance where invoice_id=$1`, r.InvoiceID).Scan(&n)
	}); err != nil || n != 0 {
		t.Fatalf("failed reservation survived %v", err)
	}
}
func TestIssuanceBindingFailureRollsBackJournalOnly(t *testing.T) {
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	service := SandboxIssuance{DB: d}
	ctx := context.Background()
	var other string
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) select tenant_id,contract_id,subscriber_id,'manual',due_date,amount_cents from invoices where id=$1 returning id`, r.InvoiceID).Scan(&other); err != nil {
			return err
		}
		return tx.Exec(ctx, `update invoices set gateway='efi',financial_connection_id=$2,gateway_charge_id='synthetic-charge' where id=$1`, other, r.Scope.ConnectionID)
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := service.Prepare(ctx, scope, r, strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	fake := &issuanceFake{request: r}
	if _, err = service.Run(ctx, scope, item.ID, fake); err == nil {
		t.Fatal("duplicate provider charge binding accepted")
	}
	var intact bool
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select j.state='uncertain' and j.charge_id is null and i.gateway_charge_id is null and i.financial_connection_id is null from provider_issuance j join invoices i on i.id=j.invoice_id where j.id=$1`, item.ID).Scan(&intact)
	}); err != nil || !intact {
		t.Fatalf("partial commit %v", err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update invoices set gateway_charge_id='corrected-synthetic-fixture' where id=$1`, other)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Run(ctx, scope, item.ID, fake); err != nil || fake.writes.Load() != 1 || fake.reads.Load() != 1 {
		t.Fatalf("recovery reissued: %v writes=%d reads=%d", err, fake.writes.Load(), fake.reads.Load())
	}
}

type crashAdapter struct {
	issuanceFake
	marker      string
	afterEffect bool
}

func (a *crashAdapter) CreateCharge(context.Context, providers.Create) (providers.Charge, error) {
	b, _ := json.Marshal(map[string]any{"after_effect": a.afterEffect, "charge": a.charge()})
	if err := os.WriteFile(a.marker+".tmp", b, 0600); err != nil {
		return providers.Charge{}, err
	}
	if err := os.Rename(a.marker+".tmp", a.marker); err != nil {
		return providers.Charge{}, err
	}
	select {} // parent kills this process; no final journal/binding commit can occur
}
func TestSandboxIssuanceProcessRecovery(t *testing.T) {
	if id := os.Getenv("NEXO_ISSUANCE_CHILD"); id != "" {
		d, scope := issuanceDatabase(t)
		var raw []byte
		if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			return tx.QueryRow(context.Background(), `select request from provider_issuance where id=$1`, id).Scan(&raw)
		}); err != nil {
			t.Fatal(err)
		}
		var r providers.Create
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatal(err)
		}
		adapter := &crashAdapter{issuanceFake: issuanceFake{request: r}, marker: os.Getenv("NEXO_ISSUANCE_MARKER"), afterEffect: os.Getenv("NEXO_ISSUANCE_AFTER_EFFECT") == "1"}
		_, err := (SandboxIssuance{DB: d}).Run(context.Background(), scope, id, adapter)
		t.Fatalf("child unexpectedly returned %v", err)
	}
	for _, after := range []bool{false, true} {
		name := "before_effect"
		if after {
			name = "after_effect"
		}
		t.Run(name, func(t *testing.T) {
			d, scope := issuanceDatabase(t)
			r := issuanceFixture(t, d, scope)
			service := SandboxIssuance{DB: d}
			ctx := context.Background()
			item, err := service.Prepare(ctx, scope, r, strings.Repeat("a", 64))
			if err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(t.TempDir(), "effect.json")
			mode := "0"
			if after {
				mode = "1"
			}
			process := osexec.Command(os.Args[0], "-test.run=^TestSandboxIssuanceProcessRecovery$")
			process.Env = append(os.Environ(), "NEXO_ISSUANCE_CHILD="+item.ID, "NEXO_ISSUANCE_MARKER="+marker, "NEXO_ISSUANCE_AFTER_EFFECT="+mode)
			if err = process.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = process.Process.Kill() })
			deadline := time.Now().Add(10 * time.Second)
			for {
				if _, err = os.Stat(marker); err == nil {
					break
				}
				if time.Now().After(deadline) {
					_ = process.Process.Kill()
					_ = process.Wait()
					t.Fatal("child never reached post-commit transport boundary")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err = process.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err = process.Wait(); err == nil {
				t.Fatal("expected killed child")
			}
			fake := &issuanceFake{request: r}
			if !after {
				fake.lookupError = &providers.Failure{Kind: providers.Unavailable, Cause: errors.New("404 after restart")}
			}
			_, err = service.Run(ctx, scope, item.ID, fake)
			if fake.writes.Load() != 0 || fake.reads.Load() != 1 {
				t.Fatal("restart created another charge")
			}
			if after && err != nil {
				t.Fatal(err)
			}
			if !after && err == nil {
				t.Fatal("absent remote effect was invented")
			}
			var state string
			if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
				return tx.QueryRow(ctx, `select state from provider_issuance where id=$1`, item.ID).Scan(&state)
			}); err != nil {
				t.Fatal(err)
			}
			want := "uncertain"
			if after {
				want = "issued"
			}
			if state != want {
				t.Fatalf("state %s", state)
			}
		})
	}
}

func TestConcurrentIssuancePreparationKeepsOneReservation(t *testing.T) {
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	service := SandboxIssuance{DB: d}
	ids := make(chan string, 32)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			item, err := service.Prepare(context.Background(), scope, r, strings.Repeat("a", 64))
			if err != nil {
				t.Error(err)
				return
			}
			ids <- item.ID
		}()
	}
	wg.Wait()
	close(ids)
	unique := map[string]bool{}
	for id := range ids {
		unique[id] = true
	}
	if len(unique) != 1 {
		t.Fatalf("reservations %v", unique)
	}
	var n int
	if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from provider_issuance where invoice_id=$1`, r.InvoiceID).Scan(&n)
	}); err != nil || n != 1 {
		t.Fatalf("reservation count=%d %v", n, err)
	}
}
