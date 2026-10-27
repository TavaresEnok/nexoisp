package finance

import (
	"context"
	"encoding/json"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
)

// Existing invoice JSON is sufficient; artifacts are presentation, not a new
// financial model. Caller holds the invoice lock and has validated the snapshot.
func storeProviderArtifacts(ctx context.Context, tx *db.Tx, issuance string, charge providers.Charge, active bool) error {
	var payload any
	if active && charge.Artifacts != nil {
		if cleaned := charge.Artifacts.Clean(); cleaned != nil {
			raw, err := json.Marshal(cleaned)
			if err != nil {
				return err
			}
			payload = string(raw)
		}
	}
	return tx.Exec(ctx, `update invoices i set payment_methods=case when i.status='open' then $5::jsonb else null end from provider_issuance j where j.id=$1 and j.state='issued' and j.invoice_id=i.id and j.financial_connection_id=$2 and j.charge_id=$3 and i.gateway_charge_id=$3 and i.financial_connection_id=$2 and i.amount_cents=$4`, issuance, charge.Scope.ConnectionID, charge.ID, charge.Money.Cents, payload)
}
