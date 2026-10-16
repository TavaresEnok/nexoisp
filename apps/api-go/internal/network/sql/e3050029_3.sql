update operations set status = $2, note = $3, result = $4, lease_until = null, current_attempt_id = null, updated_at = now(),
            next_attempt_at = case when $2 = 'PENDING' and $5 then now() + (interval '5 seconds' * power(2, attempts)) else null end,
            finished_at = case when $2 = 'PENDING' then null else now() end where id = $1