insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip, mac, nas_ip, bytes_in, bytes_out, seconds, terminate_cause)
       select x.tenant_id, r.id, left(x.unique_id, 80), x.started_at, x.stopped_at, x.framed_ip, x.calling_station, host(x.nas_ip), x.bytes_in, x.bytes_out, x.session_seconds, x.terminate_cause
       from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
       join devices d on d.id = r.device_id and d.driver = 'radius'
       where (($1::timestamptz is null and (x.stopped_at is null or x.updated_at > now() - interval '2 days')) or x.changed_at > $1)
       on conflict (resource_id, session_key) do update set stopped_at = excluded.stopped_at, ip = excluded.ip, mac = excluded.mac, nas_ip = excluded.nas_ip,
         bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out, seconds = excluded.seconds, terminate_cause = excluded.terminate_cause, reported_at = now()