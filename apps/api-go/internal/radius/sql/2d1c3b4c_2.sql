with source as materialized (
  select x.id as accounting_id, x.tenant_id, r.id as resource_id, left(x.unique_id, 80) as session_key,
         x.started_at, x.stopped_at, x.framed_ip, x.calling_station, x.nas_ip,
         x.bytes_in, x.bytes_out, x.session_seconds, x.terminate_cause, x.updated_at
  from radius_acct x join service_resources r on r.tenant_id = x.tenant_id and r.pppoe_username = x.username
  join devices d on d.id = r.device_id and d.driver = 'radius'
  where (($1::timestamptz is null and (x.stopped_at is null or x.updated_at > now() - interval '2 days')) or x.changed_at > $1 or exists (select 1 from r05_accounting_batch b where b.accounting_id=x.id))
), incorporated as (
  insert into r05_accounting_incorporated (accounting_id)
  select distinct accounting_id from source
  returning accounting_id
), d as materialized (
  select x.tenant_id, x.resource_id, case when s.session_key is null then least(x.updated_at, now()) else now() end as at,
         greatest(0, x.bytes_in - coalesce(s.bytes_in, 0)) as bytes_in, greatest(0, x.bytes_out - coalesce(s.bytes_out, 0)) as bytes_out
  from source x left join service_sessions s on s.resource_id = x.resource_id and s.session_key = x.session_key
  where x.bytes_in > coalesce(s.bytes_in, 0) or x.bytes_out > coalesce(s.bytes_out, 0)
), daily as (
  insert into usage_daily (tenant_id, resource_id, day, bytes_in, bytes_out)
  select tenant_id, resource_id, (at at time zone coalesce((select timezone from tenant_settings where tenant_id = $2), 'America/Sao_Paulo'))::date, sum(bytes_in), sum(bytes_out) from d group by 1, 2, 3
  on conflict (resource_id, day) do update set bytes_in = usage_daily.bytes_in + excluded.bytes_in, bytes_out = usage_daily.bytes_out + excluded.bytes_out
  returning 1
), hourly as (
  insert into usage_hourly (tenant_id, resource_id, hour, bytes_in, bytes_out)
  select tenant_id, resource_id, date_trunc('hour', at), sum(bytes_in), sum(bytes_out) from d
  where at > now() - make_interval(hours => $3::int) group by 1, 2, 3
  on conflict (resource_id, hour) do update set bytes_in = usage_hourly.bytes_in + excluded.bytes_in, bytes_out = usage_hourly.bytes_out + excluded.bytes_out
  returning 1
)
insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip, mac, nas_ip, bytes_in, bytes_out, seconds, terminate_cause)
select tenant_id, resource_id, session_key, started_at, stopped_at, framed_ip, calling_station, host(nas_ip), bytes_in, bytes_out, session_seconds, terminate_cause from source
on conflict (resource_id, session_key) do update set stopped_at = excluded.stopped_at, ip = excluded.ip, mac = excluded.mac, nas_ip = excluded.nas_ip,
  bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out, seconds = excluded.seconds, terminate_cause = excluded.terminate_cause, reported_at = now()
