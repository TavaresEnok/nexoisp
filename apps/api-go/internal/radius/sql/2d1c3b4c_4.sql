insert into usage_monthly (tenant_id, resource_id, month, bytes_in, bytes_out, session_seconds, sessions)
       select x.tenant_id, r.id, date_trunc('month', x.started_at at time zone 'UTC')::date, sum(x.bytes_in), sum(x.bytes_out), sum(x.session_seconds), count(*)
       from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
       join devices d on d.id = r.device_id and d.driver = 'radius'
       where x.started_at >= date_trunc('month', now() at time zone 'UTC') - interval '1 month'
         and ($1::timestamptz is null or x.username in (select username from radius_acct where changed_at > $1))
       group by 1, 2, 3
       on conflict (resource_id, month) do update set bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out,
         session_seconds = excluded.session_seconds, sessions = excluded.sessions, reported_at = now()