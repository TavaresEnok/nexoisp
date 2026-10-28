select i.id, i.amount_cents, i.due_date, i.status,
       coalesce((select sum(p.signed_cents)::bigint from payments p where p.invoice_id = i.id and p.tenant_id = i.tenant_id), 0)::bigint as received_cents
from invoices i
where i.external_source = $1 and i.external_id = $2
