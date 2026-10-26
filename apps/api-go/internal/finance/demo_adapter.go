package finance

import (
	"context"
	"encoding/json"
	"errors"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/jsonx"
	"strings"
)

type demoAdapter struct {
	tx    *db.Tx
	scope providers.Scope
}

var _ providers.Adapter = (*demoAdapter)(nil)

// The executable registry is intentionally closed. A provider saved in settings
// is not an implemented adapter. There is no HTTP fake in the production binary.
func adapterFor(ctx context.Context, tx *db.Tx, id string) (providers.Adapter, providers.Scope, error) {
	rows, err := tx.Objects(ctx, `select id,tenant_id,provider,environment,account_ref,status from financial_connections where id=$1`, id)
	if err != nil {
		return nil, providers.Scope{}, err
	}
	if len(rows) != 1 {
		return nil, providers.Scope{}, apierr.New(409, "conexão indisponível neste escopo")
	}
	c := rows[0]
	s := providers.Scope{ConnectionID: id, TenantID: jsonx.String(c.Get("tenant_id")), Provider: jsonx.String(c.Get("provider")), Environment: jsonx.String(c.Get("environment")), AccountRef: jsonx.String(c.Get("account_ref"))}
	if c.Get("status") != "active" || !providers.Executable(s, Demo("demo")) {
		return nil, s, apierr.New(409, "adapter não habilitado")
	}
	return &demoAdapter{tx: tx, scope: s}, s, nil
}
func (d *demoAdapter) CreateCharge(ctx context.Context, r providers.Create) (providers.Charge, error) {
	if err := r.Validate(); err != nil {
		return providers.Charge{}, err
	}
	if r.Scope != d.scope || r.IntentKey != "invoice:"+r.InvoiceID {
		return providers.Charge{}, errors.New("demo charge scope/intention mismatch")
	}
	charge := providers.Charge{Scope: d.scope, ID: "demo_ch_" + r.InvoiceID, IntentKey: r.IntentKey, InvoiceID: r.InvoiceID, Money: r.Money}
	if err := d.tx.Exec(ctx, `insert into demo_gateway_charges(charge_id,tenant_id,amount_cents,financial_connection_id) values($1,$2,$3,$4) on conflict(financial_connection_id,charge_id) where financial_connection_id is not null do nothing`, charge.ID, d.scope.TenantID, r.Money.Cents, d.scope.ConnectionID); err != nil {
		return charge, err
	}
	var amount int64
	if err := d.tx.QueryRow(ctx, `select amount_cents from demo_gateway_charges where charge_id=$1 and financial_connection_id=$2`, charge.ID, d.scope.ConnectionID).Scan(&amount); err != nil {
		return charge, err
	}
	if amount != r.Money.Cents {
		return charge, &providers.Failure{Kind: providers.Conflict, Cause: errors.New("charge intention already exists with another amount")}
	}
	return charge, providers.ValidateIssued(r, charge)
}
func (d *demoAdapter) Lookup(ctx context.Context, r providers.Reference) (providers.Snapshot, error) {
	var result providers.Snapshot
	if r.Scope != d.scope {
		return result, errors.New("demo lookup scope mismatch")
	}
	chargeID := r.ChargeID
	if chargeID == "" && strings.HasPrefix(r.IntentKey, "invoice:") {
		chargeID = "demo_ch_" + strings.TrimPrefix(r.IntentKey, "invoice:")
	}
	rows, err := d.tx.Objects(ctx, `select d.amount_cents,d.payments,i.id as invoice_id from demo_gateway_charges d join invoices i on i.financial_connection_id=d.financial_connection_id and i.gateway_charge_id=d.charge_id where d.charge_id=$1 and d.financial_connection_id=$2`, chargeID, d.scope.ConnectionID)
	if err != nil {
		return result, err
	}
	if len(rows) == 0 {
		return result, &providers.Failure{Kind: providers.Unavailable, Cause: errors.New("charge not found in connection")}
	}
	row := rows[0]
	invoice := jsonx.String(row.Get("invoice_id"))
	result.Charge = providers.Charge{Scope: d.scope, ID: chargeID, IntentKey: "invoice:" + invoice, InvoiceID: invoice, Money: providers.Money{Cents: int64(num(row.Get("amount_cents"))), Currency: "BRL"}}
	raw, err := jsonx.Encode(row.Get("payments"))
	if err != nil {
		return result, err
	}
	if err = json.Unmarshal(raw, &result.Payments); err != nil {
		return result, err
	}
	for i := range result.Payments {
		if result.Payments[i].Currency == "" {
			result.Payments[i].Currency = "BRL"
		}
	}
	return result, providers.ValidateSnapshot(r, result)
}
func paymentObject(p providers.Payment) jsonx.Object {
	return jsonx.Object{{Name: "id", Value: p.ID}, {Name: "amount_cents", Value: p.AmountCents}, {Name: "paid_at", Value: p.PaidAt}, {Name: "method", Value: p.Method}, {Name: "currency", Value: p.Currency}}
}
