insert into agreements (tenant_id, contract_id, subscriber_id, total_cents, original_cents, discount_cents, installments, reason, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id