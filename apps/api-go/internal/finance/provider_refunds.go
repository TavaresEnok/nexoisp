package finance

import (
	"context"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
)

// ApplyProviderRefund appends a confirmed PSP debit. Callers must validate an
// authoritative snapshot/readback before calling; webhook payloads cannot call it.
func ApplyProviderRefund(ctx context.Context, tx *db.Tx, invoice, connection string, refund providers.Refund) (bool, error) {
	if refund.Validate() != nil {
		return false, apierr.New(409, "devolução confirmada sem identidade, valor ou data válidos")
	}
	var locked, tenant string
	if err := tx.QueryRow(ctx, `select id,tenant_id from invoices where id=$1 and financial_connection_id=$2 for update`, invoice, connection).Scan(&locked, &tenant); err != nil {
		return false, err
	}
	count, err := tx.Affected(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,method,source,note,kind,reversal_of,financial_connection_id,gateway,provider_refund_id,provider_return_id)
 select tenant_id,invoice_id,$4,$5::timestamptz,method,'reconciliation','devolução confirmada pelo fornecedor','reversal',id,financial_connection_id,gateway,$6,$7 from payments
 where invoice_id=$1 and financial_connection_id=$2 and gateway_payment_id=$3 and kind='payment' and source<>'manual'
 on conflict do nothing`, invoice, connection, refund.PaymentID, refund.AmountCents, refund.SettledAt, refund.ID, refund.ReturnID)
	if err != nil {
		return false, err
	}
	if count == 0 {
		var exact bool
		if err = tx.QueryRow(ctx, `select exists(select 1 from payments r join payments p on p.id=r.reversal_of where r.invoice_id=$1 and r.financial_connection_id=$2 and p.gateway_payment_id=$3 and r.amount_cents=$4 and r.paid_at=$5::timestamptz and r.provider_refund_id=$6 and r.provider_return_id=$7)`, invoice, connection, refund.PaymentID, refund.AmountCents, refund.SettledAt, refund.ID, refund.ReturnID).Scan(&exact); err != nil {
			return false, err
		}
		if !exact {
			return false, apierr.New(409, "devolução sem recebimento correspondente ou identidade divergente")
		}
		return true, nil
	}
	if err = tx.Exec(ctx, `update invoices set status='reconciling',status_note='devolução confirmada; revisar obrigação e saldo residual' where id=$1`, invoice); err != nil {
		return false, err
	}
	return false, SysAudit(ctx, tx, tenant, "finance.provider.refund", "invoice", invoice, map[string]any{"refund_id": refund.ID, "return_id": refund.ReturnID, "amount_cents": refund.AmountCents}, "ok")
}
