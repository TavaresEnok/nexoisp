with d as materialized (
         select x.tenant_id, r.id as resource_id, case when s.session_key is null then least(x.updated_at, now()) else now() end as at,
                greatest(0, x.bytes_in - coalesce(s.bytes_in, 0)) as bytes_in, greatest(0, x.bytes_out - coalesce(s.bytes_out, 0)) as bytes_out
         from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
         join devices d on d.id = r.device_id and d.driver = 'radius'
         left join service_sessions s on s.resource_id = r.id and s.session_key = left(x.unique_id, 80)
         where (($1::timestamptz is null and (x.stopped_at is null or x.updated_at > now() - interval '2 days')) or x.seen_at > $1) and (x.bytes_in > coalesce(s.bytes_in, 0) or x.bytes_out > coalesce(s.bytes_out, 0))),
       daily as (
         insert into usage_daily (tenant_id, resource_id, day, bytes_in, bytes_out)
         select tenant_id, resource_id, (at at time zone coalesce((select timezone from tenant_settings where tenant_id = $2), 'America/Sao_Paulo'))::date, sum(bytes_in), sum(bytes_out) from d group by 1, 2, 3
         on conflict (resource_id, day) do update set bytes_in = usage_daily.bytes_in + excluded.bytes_in, bytes_out = usage_daily.bytes_out + excluded.bytes_out
         returning 1)
       insert into usage_hourly (tenant_id, resource_id, hour, bytes_in, bytes_out)
       select tenant_id, resource_id, date_trunc('hour', at), sum(bytes_in), sum(bytes_out) from d
       where at > now() - make_interval(hours => $3::int) group by 1, 2, 3
       on conflict (resource_id, hour) do update set bytes_in = usage_hourly.bytes_in + excluded.bytes_in, bytes_out = usage_hourly.bytes_out + excluded.bytes_out