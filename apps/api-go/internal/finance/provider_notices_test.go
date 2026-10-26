package finance

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/google/uuid"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
	"strings"
	"testing"
)

func TestEarlyNoticeQueuesAuthoritativeReceiptWithoutTrustingCallbackMoney(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	item, fake := preparePipeline(t, d, scope)
	ctx := context.Background()
	notice := map[string]any{"pix": []any{map[string]any{"txid": "synthetic-charge", "endToEndId": "synthetic-bank-receipt", "valor": "9999999.99", "tenant_id": "spoofed-tenant"}}}
	raw, _ := json.Marshal(notice)
	out, err := AcceptPixNotices(ctx, d, item.Request.Scope.ConnectionID, raw)
	if err != nil || out.Unmatched != 1 {
		t.Fatalf("early notice: %v %#v", err, out)
	}
	duplicate, err := AcceptPixNotices(ctx, d, item.Request.Scope.ConnectionID, raw)
	if err != nil || duplicate.Duplicates != 1 {
		t.Fatal("notice replay not deduplicated")
	}
	if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, fake); err != nil {
		t.Fatal(err)
	}
	fake.payments = []providers.Payment{{ID: "synthetic-bank-receipt", AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}}
	factory := func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
		if r.InvoiceID != item.Request.InvoiceID {
			return nil, func() {}, &providers.Failure{Kind: providers.Unavailable}
		}
		return fake, func() {}, nil
	}
	if err = ReconcileProviderReceipts(ctx, d, scope, factory); err != nil {
		t.Fatal(err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var amount int64
		var status string
		if e := tx.QueryRow(ctx, `select sum(amount_cents) from payments where invoice_id=$1`, item.Request.InvoiceID).Scan(&amount); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select status from provider_notices where financial_connection_id=$1 and charge_id='synthetic-charge'`, item.Request.Scope.ConnectionID).Scan(&status); e != nil {
			return e
		}
		if amount != 12345 || status != "processed" {
			t.Errorf("callback money trusted or notice lost: %d %s", amount, status)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var other string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id from nexo_go_directory() where tenant_id<>$1::uuid order by tenant_id limit 1`, scope.TenantID).Scan(&other)
	}); err != nil {
		t.Fatal(err)
	}
	for _, denied := range []tenancy.Scope{
		{TenantID: other},
		{TenantID: scope.TenantID, SubscriberID: uuid.NewString()},
		{TenantID: scope.TenantID, PopIDs: []string{uuid.NewString()}},
	} {
		if err = d.WithScope(ctx, denied, func(tx *db.Tx) error {
			var count int
			if e := tx.QueryRow(ctx, `select count(*) from provider_notices where financial_connection_id=$1`, item.Request.Scope.ConnectionID).Scan(&count); e != nil {
				return e
			}
			if count != 0 {
				t.Error("notification payload escaped tenant/full-scope RLS")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}
