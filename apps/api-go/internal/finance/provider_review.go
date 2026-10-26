package finance

import (
	"context"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
)

// RetryProviderLookup only reopens authoritative lookup. A reviewed intention can
// never return to prepared, so operator retry cannot cause another remote create.
// Caller authorizes full financial scope and records the reason in this same tx.
func RetryProviderLookup(ctx context.Context, tx *db.Tx, id, connection string) error {
	var invoice string
	rows, err := tx.Objects(ctx, `select invoice_id from provider_issuance where id=$1 and financial_connection_id=$2`, id, connection)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return apierr.New(404, "emissão não encontrada")
	}
	invoice = rows[0].Get("invoice_id").(string)
	if err = tx.QueryRow(ctx, `select id from invoices where id=$1 for update`, invoice).Scan(&invoice); err != nil {
		return err
	}
	var state string
	if err = tx.QueryRow(ctx, `select state from provider_issuance where id=$1 for update`, id).Scan(&state); err != nil {
		return err
	}
	switch state {
	case "review", "uncertain":
		return tx.Exec(ctx, `update provider_issuance set state='uncertain',next_attempt_at=now(),last_error=null where id=$1`, id)
	case "issued":
		return tx.Exec(ctx, `update provider_issuance set receipt_review=false,receipt_next_at=now(),receipt_last_error=null where id=$1`, id)
	default:
		return apierr.New(409, "intenção ainda não enviada; consulta não autoriza emissão")
	}
}
