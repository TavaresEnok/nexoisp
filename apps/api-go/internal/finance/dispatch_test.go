package finance

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"testing"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
)

type pipelineFake struct {
	issuanceFake
	fail           bool
	payments       []providers.Payment
	refunds        []providers.Refund
	reviewRequired bool
}

func (f *pipelineFake) CreateCharge(ctx context.Context, r providers.Create) (providers.Charge, error) {
	if f.fail {
		f.writes.Add(1)
		return providers.Charge{}, &providers.Failure{Kind: providers.Unknown, Cause: errors.New("SYNTHETIC-SENSITIVE-PROVIDER-BODY")}
	}
	return f.issuanceFake.CreateCharge(ctx, r)
}
func (f *pipelineFake) Lookup(context.Context, providers.Reference) (providers.Snapshot, error) {
	f.reads.Add(1)
	return providers.Snapshot{Charge: f.charge(), Payments: f.payments, Refunds: f.refunds, ReviewRequired: f.reviewRequired}, nil
}
func preparePipeline(t *testing.T, d *db.DB, scope tenancy.Scope) (Issuance, *pipelineFake) {
	t.Helper()
	ctx := context.Background()
	r := issuanceFixture(t, d, scope)
	secret := syntheticPixCredentials(t)
	var user string
	var meta CredentialMetadata
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		var e error
		meta, e = SavePixCredentials(ctx, tx, r.Scope.ConnectionID, user, secret)
		if e != nil {
			return e
		}
		return tx.Exec(ctx, `update financial_connections set status='active' where id=$1`, r.Scope.ConnectionID)
	})
	if err != nil {
		t.Fatal(err)
	}
	item, err := (SandboxIssuance{DB: d}).PrepareProduct(ctx, scope, r, IssuanceOptions{Product: "pix_cob", Expiration: 3600}, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	return item, &pipelineFake{issuanceFake: issuanceFake{request: r, config: item.ConfigHash}}
}
func TestProviderWorkerFailureRecoveryAndReceipts(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	ctx := context.Background()
	broken, bad := preparePipeline(t, d, scope)
	healthy, good := preparePipeline(t, d, scope)
	bad.fail = true
	fakes := map[string]*pipelineFake{broken.Request.InvoiceID: bad, healthy.Request.InvoiceID: good}
	factory := func(_ context.Context, r providers.Create, version string, o IssuanceOptions) (ConfiguredAdapter, func(), error) {
		f := fakes[r.InvoiceID]
		if f == nil {
			return nil, func() {}, errors.New("unrelated synthetic fixture")
		}
		return f, func() {}, nil
	}
	if err := DispatchPending(ctx, d, scope, factory); err != nil {
		t.Fatal(err)
	}
	var failed, passed bool
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select state='uncertain' and attempts=1 and last_error='provider_unknown' and next_attempt_at>now() from provider_issuance where id=$1`, broken.ID).Scan(&failed); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select state='issued' and attempts=1 and last_error is null from provider_issuance where id=$1`, healthy.ID).Scan(&passed)
	})
	if err != nil || !failed || !passed {
		t.Fatalf("failure isolation %v failed=%v healthy=%v", err, failed, passed)
	}
	if bad.writes.Load() != 1 || good.writes.Load() != 1 {
		t.Fatal("initial dispatch count")
	}
	bad.fail = false
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.Exec(ctx, `update financial_connections set status='disabled' where id=$1`, broken.Request.Scope.ConnectionID); e != nil {
			return e
		}
		return tx.Exec(ctx, `update provider_issuance set next_attempt_at=now() where id=$1`, broken.ID)
	}); err != nil {
		t.Fatal(err)
	}
	if err = dispatchPending(ctx, d, scope, factory, false); err != nil {
		t.Fatal(err)
	}
	if bad.writes.Load() != 1 || bad.reads.Load() != 1 {
		t.Fatal("disabled account/dispatch did not recover uncertain intention with lookup only")
	}
	prepared, unsent := preparePipeline(t, d, scope)
	fakes[prepared.Request.InvoiceID] = unsent
	if err = dispatchPending(ctx, d, scope, factory, false); err != nil {
		t.Fatal(err)
	}
	if unsent.writes.Load() != 0 || unsent.reads.Load() != 0 {
		t.Fatal("lookup-only mode consumed an unsent intention")
	}
	// Stop new writes while allowing confirmed old titles to be reconciled.
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update financial_connections set status='disabled' where id=$1`, healthy.Request.Scope.ConnectionID)
	}); err != nil {
		t.Fatal(err)
	}
	good.payments = []providers.Payment{{ID: "synthetic-confirmed-receipt", AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := ReconcileProviderReceipts(ctx, d, scope, factory); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var count, effects int
		if e := tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1`, healthy.Request.InvoiceID).Scan(&count); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*) from payment_effects where invoice_id=$1`, healthy.Request.InvoiceID).Scan(&effects); e != nil {
			return e
		}
		if count != 1 || effects != 1 {
			t.Errorf("receipt=%d effects=%d", count, effects)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// The same authoritative payment ID with changed cents must enter review,
	// preserve original cash, and stop automatic retries (valid currency included).
	good.payments[0].AmountCents++
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update provider_issuance set receipt_next_at=now() where id=$1`, healthy.ID)
	}); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileProviderReceipts(ctx, d, scope, factory); err != nil {
		t.Fatal(err)
	}
	var n int
	var review bool
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1 and amount_cents=12345`, healthy.Request.InvoiceID).Scan(&n); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select receipt_review and receipt_last_error='provider_conflict' from provider_issuance where id=$1`, healthy.ID).Scan(&review)
	}); err != nil || n != 1 || !review {
		t.Fatalf("changed receipt did not preserve cash/enter review: cash=%d review=%v err=%v", n, review, err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return RetryProviderLookup(ctx, tx, healthy.ID, healthy.Request.Scope.ConnectionID)
	}); err != nil {
		t.Fatal(err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select receipt_review from provider_issuance where id=$1`, healthy.ID).Scan(&review)
	}); err != nil || review {
		t.Fatalf("operator lookup did not requeue receipt: review=%v err=%v", review, err)
	}
	t.Setenv("NEXO_GO_EFI_SANDBOX_ENABLED", "")
	t.Setenv("NEXO_GO_EFI_DISPATCH", "1")
	if err = ProcessProviderIssuance(ctx, d, scope.TenantID); err != nil {
		t.Fatal(err)
	}
	if err = ProcessProviderReceipts(ctx, d, scope.TenantID); err != nil {
		t.Fatal(err)
	}
}
