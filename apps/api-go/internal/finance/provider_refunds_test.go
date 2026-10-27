package finance

import (
	"context"
	"encoding/base64"
	"github.com/google/uuid"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"strings"
	"sync"
	"testing"
)

func TestProviderPartialRefundReplayAndCumulativeLimit(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	item, fake := preparePipeline(t, d, scope)
	ctx := context.Background()
	if _, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, fake); err != nil {
		t.Fatal(err)
	}
	payment := providers.Payment{ID: "synthetic-original-" + uuid.NewString(), AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		_, _, e := Payment(ctx, tx, item.Request.InvoiceID, "efi", item.Request.Scope.ConnectionID, paymentObject(payment), "reconciliation")
		return e
	}); err != nil {
		t.Fatal(err)
	}
	r := providers.Refund{ID: "refund1", ReturnID: "bankreturn1", PaymentID: payment.ID, AmountCents: 4000, SettledAt: "2026-10-26T13:00:00Z"}
	apply := func(value providers.Refund) error {
		return d.WithScope(ctx, scope, func(tx *db.Tx) error {
			_, e := ApplyProviderRefund(ctx, tx, item.Request.InvoiceID, item.Request.Scope.ConnectionID, value)
			return e
		})
	}
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := apply(r); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	second := r
	second.ID = "refund2"
	second.ReturnID = "bankreturn2"
	if err := apply(second); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []providers.Refund{
		{ID: "tooearly", ReturnID: "tooearlyreturn", PaymentID: payment.ID, AmountCents: 1, SettledAt: "2026-10-25T13:00:00Z"},
		{ID: "refund3", ReturnID: "bankreturn3", PaymentID: payment.ID, AmountCents: 5000, SettledAt: r.SettledAt},
		{ID: r.ID, ReturnID: r.ReturnID, PaymentID: r.PaymentID, AmountCents: 1, SettledAt: r.SettledAt},
		{ID: "anotherID", ReturnID: r.ReturnID, PaymentID: r.PaymentID, AmountCents: r.AmountCents, SettledAt: r.SettledAt},
	} {
		if err := apply(bad); err == nil {
			t.Fatal("invalid/cumulative/aliased refund accepted")
		}
	}
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var count int
		var received, residual int64
		var status string
		if e := tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1 and kind='reversal'`, item.Request.InvoiceID).Scan(&count); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select received_cents,residual_cents,status from financial_balance_shadow where invoice_id=$1`, item.Request.InvoiceID).Scan(&received, &residual, &status); e != nil {
			return e
		}
		if count != 2 || received != 4345 || residual != 8000 || status != "reconciling" {
			t.Errorf("refund ledger count=%d received=%d residual=%d status=%s", count, received, residual, status)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Exact replay still succeeds after the entire receipt is refunded.
	last := r
	last.ID = "refund-last"
	last.ReturnID = "bankreturn-last"
	last.AmountCents = 4345
	if err := apply(last); err != nil {
		t.Fatal(err)
	}
	if err := apply(last); err != nil {
		t.Fatal("full-limit replay", err)
	}
}

func TestReceiptWithExistingRefundNeverPlansTechnicalReactivation(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	item, fake := preparePipeline(t, d, scope)
	ctx := context.Background()
	if _, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, fake); err != nil {
		t.Fatal(err)
	}
	p := providers.Payment{ID: uuid.NewString(), AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}
	fake.payments = []providers.Payment{p}
	fake.refunds = []providers.Refund{{ID: "externalrefund", ReturnID: "externalreturn", PaymentID: p.ID, AmountCents: 4000, SettledAt: "2026-10-26T13:00:00Z"}}
	factory := func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
		if r.InvoiceID != item.Request.InvoiceID {
			return nil, func() {}, &providers.Failure{Kind: providers.Unavailable}
		}
		return fake, func() {}, nil
	}
	for range 2 {
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update provider_issuance set receipt_next_at=now() where id=$1`, item.ID)
		}); err != nil {
			t.Fatal(err)
		}
		if err := ReconcileProviderReceipts(ctx, d, scope, factory); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var received, residual, effects int64
		var status string
		if e := tx.QueryRow(ctx, `select received_cents,residual_cents,status from financial_balance_shadow where invoice_id=$1`, item.Request.InvoiceID).Scan(&received, &residual, &status); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*) from payment_effects where invoice_id=$1`, item.Request.InvoiceID).Scan(&effects); e != nil {
			return e
		}
		if received != 8345 || residual != 4000 || status != "reconciling" || effects != 0 {
			t.Errorf("net receipt=%d residual=%d status=%s effects=%d", received, residual, status, effects)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
