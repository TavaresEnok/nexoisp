select i.id, i.gateway, i.gateway_charge_id, i.financial_connection_id from invoices i where i.id = $1 and i.status = 'open'
 and i.amount_cents::bigint + i.fee_cents - i.discount_cents > coalesce((select sum(p.signed_cents) from payments p where p.invoice_id=i.id),0) for update
