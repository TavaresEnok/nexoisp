package finance

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
)

type issuanceFake struct {
	request     providers.Create
	writes      atomic.Int64
	reads       atomic.Int64
	lost        bool
	lookupError error
	config      string
}

func (f *issuanceFake) ConfigurationHash() string {
	if f.config != "" {
		return f.config
	}
	return strings.Repeat("a", 64)
}
func (f *issuanceFake) charge() providers.Charge {
	return providers.Charge{Scope: f.request.Scope, ID: "synthetic-charge", IntentKey: f.request.IntentKey, InvoiceID: f.request.InvoiceID, Money: f.request.Money}
}
func (f *issuanceFake) CreateCharge(context.Context, providers.Create) (providers.Charge, error) {
	f.writes.Add(1)
	if f.lost {
		return providers.Charge{}, errors.New("response lost after provider commit")
	}
	return f.charge(), nil
}
func (f *issuanceFake) Lookup(context.Context, providers.Reference) (providers.Snapshot, error) {
	f.reads.Add(1)
	if f.lookupError != nil {
		return providers.Snapshot{}, f.lookupError
	}
	return providers.Snapshot{Charge: f.charge()}, nil
}

func TestSandboxIssuanceDurabilityAndRLS(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL not configured")
	}
	ctx := context.Background()
	database, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var tenants []string
	err = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, `select * from nexo_go_directory()`)
		if err != nil {
			return err
		}
		for _, r := range rows {
			tenants = append(tenants, r.Get("tenant_id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tenants) < 2 {
		t.Fatal("two lab tenants required")
	}
	scope := tenancy.Scope{TenantID: tenants[0]}
	var invoice, connection, sub string
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) select tenant_id,id,subscriber_id,'manual','2026-11-15',12345 from contracts order by id limit 1 returning id,subscriber_id`).Scan(&invoice, &sub); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name) select tenant_id,company_id,'efi','sandbox',$2,'B07 synthetic' from invoices where id=$1 returning id`, invoice, uuid.NewString()).Scan(&connection)
	})
	if err != nil {
		t.Fatal(err)
	}
	var account string
	if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select account_ref from financial_connections where id=$1`, connection).Scan(&account)
	}); err != nil {
		t.Fatal(err)
	}
	r := providers.Create{Scope: providers.Scope{TenantID: scope.TenantID, ConnectionID: connection, Provider: "efi", Environment: "sandbox", AccountRef: account}, IntentKey: uuid.NewString(), InvoiceID: invoice, Money: providers.Money{Cents: 12345, Currency: "BRL"}, DueDate: "2026-11-15"}
	service := SandboxIssuance{DB: database}
	hash := strings.Repeat("a", 64)
	item, err := service.Prepare(ctx, scope, r, hash)
	if err != nil {
		t.Fatal(err)
	}
	changed := r
	changed.Money.Cents++
	if _, err = service.Prepare(ctx, scope, changed, hash); err == nil {
		t.Fatal("changed frozen intent accepted")
	}
	fake := &issuanceFake{request: r, lost: true}
	if _, err = service.Run(ctx, scope, item.ID, fake); err == nil {
		t.Fatal("lost response expected")
	}
	// Uncertainty committed independently of failed network call; recreate service.
	resumed := SandboxIssuance{DB: database}
	retry, err := resumed.Prepare(ctx, scope, r, hash)
	if err != nil || retry.State != "uncertain" {
		t.Fatalf("uncertainty not durable: %s %v", retry.State, err)
	}

	fake.lookupError = &providers.Failure{Kind: providers.Unavailable, Cause: errors.New("HTTP 404, maybe eventual consistency")}
	if _, err = resumed.Run(ctx, scope, item.ID, fake); err == nil {
		t.Fatal("lookup failure expected")
	}
	still, err := resumed.Prepare(ctx, scope, r, hash)
	if err != nil || still.State != "uncertain" || fake.writes.Load() != 1 {
		t.Fatal("404 reset uncertain intention")
	}
	fake.lookupError = nil
	wrong := &issuanceFake{request: r, config: strings.Repeat("b", 64)}
	if _, err = resumed.Run(ctx, scope, item.ID, wrong); err == nil || wrong.writes.Load() != 0 || wrong.reads.Load() != 0 {
		t.Fatal("changed config reached provider")
	}
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := resumed.Run(ctx, scope, item.ID, fake); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if fake.writes.Load() != 1 || fake.reads.Load() < 1 {
		t.Fatalf("writes %d reads %d", fake.writes.Load(), fake.reads.Load())
	}
	retry, err = resumed.Prepare(ctx, scope, r, hash)
	if err != nil || retry.State != "issued" {
		t.Fatalf("not issued %v", err)
	}
	for _, denied := range []tenancy.Scope{{TenantID: tenants[1]}, {TenantID: scope.TenantID, SubscriberID: sub}, {TenantID: scope.TenantID, PopIDs: []string{uuid.NewString()}}} {
		if _, err = resumed.Run(ctx, denied, item.ID, fake); err == nil {
			t.Fatal("unauthorized journal access")
		}
	}

	if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update provider_issuance set state='prepared' where id=$1`, item.ID)
	}); err == nil {
		t.Fatal("unsafe state reset allowed")
	}
	// The preparation boundary never posts cash or activates a provider.
	if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var n int
		if err := tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1`, invoice).Scan(&n); err != nil {
			return err
		}
		if n != 0 {
			return errors.New("journal posted money")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
