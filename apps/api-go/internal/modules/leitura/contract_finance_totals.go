package leitura

import (
	"context"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
)

// contractFinanceTotalsSQL is the legacy totals sentence, moved unchanged.
const contractFinanceTotalsSQL = `select
          count(*) filter (where status='open') as open,
          count(*) filter (where status='open' and due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date) as overdue,
          count(*) filter (where status='reconciling') as reconciling,
          coalesce(sum(amount_cents) filter (where status='open'),0)::bigint as nominal_open_cents,
          coalesce(sum(paid_cents) filter (where status='open'),0)::bigint as received_open_cents,
          coalesce(sum(paid_cents),0)::bigint as received_cents,
          coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where status='open'),0)::bigint as open_cents,
          coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where status='open' and due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date),0)::bigint as overdue_cents
          from (select i.*, (select coalesce(sum(p.signed_cents),0) from payments p where p.invoice_id=i.id) as paid_cents
                from invoices i where i.contract_id=$1) x`

func contractFinanceTotals(ctx context.Context, tx *db.Tx, id string) ([]jsonx.Object, error) {
	return balanceRowsInTx(ctx, tx, balanceReaderContractFinanceTotals, contractFinanceTotalsSQL, id)
}
