select i.id, i.tenant_id, i.amount_cents, i.due_date, i.company_id from invoices i where i.status = 'open' and i.gateway_charge_id is null and i.provider_issuance_id is null and i.external_source is null
 and i.amount_cents::bigint + i.fee_cents - i.discount_cents > coalesce((select sum(p.signed_cents) from payments p where p.invoice_id=i.id),0) for update skip locked
