insert into acceptances (tenant_id, contract_id, subscriber_id, amendment_id, title, body, body_hash, requested_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning id