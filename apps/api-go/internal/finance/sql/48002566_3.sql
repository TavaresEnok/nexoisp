select coalesce((select sum(signed_cents) from payments where invoice_id = i.id),0)::bigint,
       i.amount_cents::bigint + i.fee_cents - i.discount_cents
from invoices i where i.id = $1
