insert into usage_monthly (tenant_id, resource_id, month, bytes_in, bytes_out, session_seconds, sessions)
           select $1, r.id, ($3 || '-01')::date, $4, $5, $6, $7 from service_resources r where r.id = $2 and r.device_id = $8
           on conflict (resource_id, month) do update set bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out,
             session_seconds = excluded.session_seconds, sessions = excluded.sessions, reported_at = now()