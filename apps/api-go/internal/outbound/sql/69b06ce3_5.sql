insert into notice_log (tenant_id, rule_id, invoice_id, contract_id, subscriber_id, contact_value, status, channel_id, message)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (rule_id, invoice_id) do update set status = excluded.status, error = null, contact_value = excluded.contact_value,
             channel_id = excluded.channel_id, message = excluded.message, attempts = notice_log.attempts + 1, created_at = now()