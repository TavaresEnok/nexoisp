package finance

import (
	"context"
	"encoding/base64"
	"errors"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/finance/providers/efi"
	"strings"
	"testing"
)

func TestChargesDeliveriesSurviveReusedTokenAndConcurrentArrival(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	ctx := context.Background()
	var version string
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var user string
		if e := tx.QueryRow(ctx, `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		v, e := SaveFinancialCredentials(ctx, tx, r.Scope.ConnectionID, user, PixCredentials{Kind: "efi_charges", ClientID: "synthetic", ClientSecret: "synthetic"})
		if e != nil {
			return e
		}
		version = v.ID
		return tx.Exec(ctx, `update financial_connections set status='active' where id=$1`, r.Scope.ConnectionID)
	})
	if err != nil {
		t.Fatal(err)
	}
	customer := efi.BilletCustomer{Name: "Synthetic payer", CPF: "12345678909", Email: "synthetic@example.invalid"}
	customer.Address.Street = "Synthetic"
	customer.Address.Number = "1"
	customer.Address.Neighborhood = "Synthetic"
	customer.Address.City = "Fortaleza"
	customer.Address.State = "CE"
	customer.Address.Zip = "60000000"
	item, err := (SandboxIssuance{DB: d}).PrepareProduct(ctx, scope, r, IssuanceOptions{Product: "bolix", Customer: customer, IssuedOn: "2026-10-27"}, version)
	if err != nil {
		t.Fatal(err)
	}
	token := "synthetic-notification-token"
	if err = AcceptChargesNotice(ctx, d, r.Scope.ConnectionID, token); err != nil {
		t.Fatal(err)
	}
	fake := &issuanceFake{request: r, config: item.ConfigHash}
	if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, fake); err != nil {
		t.Fatal(err)
	}
	arrived := false
	lookup := func(ctx context.Context, connection, got string) ([]efi.ChargeNotice, error) {
		if connection != r.Scope.ConnectionID {
			return nil, &providers.Failure{Kind: providers.Unavailable, Cause: errors.New("unrelated synthetic connection")}
		}
		if got != token {
			t.Fatal("notification token changed inside connection")
		}
		if !arrived {
			arrived = true
			if e := AcceptChargesNotice(ctx, d, connection, token); e != nil {
				return nil, e
			}
		}
		return []efi.ChargeNotice{{ChargeID: "synthetic-charge", CustomID: efi.TxID(r)}}, nil
	}
	if err = ReconcileChargesNotices(ctx, d, scope, lookup); err != nil {
		t.Fatal(err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var pending, processed, payments int
		if e := tx.QueryRow(ctx, `select count(*) filter(where status='unmatched'),count(*) filter(where status='processed') from provider_notices where financial_connection_id=$1`, r.Scope.ConnectionID).Scan(&pending, &processed); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1`, r.InvoiceID).Scan(&payments); e != nil {
			return e
		}
		if pending != 1 || processed != 1 || payments != 0 {
			t.Fatalf("concurrent delivery lost or cash invented: %d %d %d", pending, processed, payments)
		}
		charge := fake.charge()
		charge.Artifacts = &providers.PaymentArtifacts{PixCopyPaste: "synthetic authenticated copy"}
		if e := storeProviderArtifacts(ctx, tx, item.ID, charge, true); e != nil {
			return e
		}
		var copy string
		if e := tx.QueryRow(ctx, `select payment_methods->>'pix_copy_paste' from invoices where id=$1`, r.InvoiceID).Scan(&copy); e != nil {
			return e
		}
		if copy != charge.Artifacts.PixCopyPaste {
			t.Fatal("provider artifacts not persisted")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = ReconcileChargesNotices(ctx, d, scope, lookup); err != nil {
		t.Fatal(err)
	}
	if err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var processed int
		if e := tx.QueryRow(ctx, `select count(*) from provider_notices where financial_connection_id=$1 and status='processed'`, r.Scope.ConnectionID).Scan(&processed); e != nil {
			return e
		}
		if processed != 2 {
			t.Fatal("same token's second status change suppressed")
		}
		if e := storeProviderArtifacts(ctx, tx, item.ID, fake.charge(), false); e != nil {
			return e
		}
		var cleared bool
		if e := tx.QueryRow(ctx, `select payment_methods is null from invoices where id=$1`, r.InvoiceID).Scan(&cleared); e != nil {
			return e
		}
		if !cleared {
			t.Fatal("inactive charge still exposes payment artifacts")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
