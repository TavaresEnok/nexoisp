insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, gateway, gateway_payment_id,financial_connection_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (financial_connection_id, gateway_payment_id) where financial_connection_id is not null and gateway_payment_id is not null do nothing
