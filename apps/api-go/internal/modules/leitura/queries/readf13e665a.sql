-- name: Readf13e665a :many
select a.id, a.name, a.status, a.version, a.internal, a.last_seen_at, a.last_sync_at, a.info, a.created_at, a.cert_fingerprint, a.cert_pinned_at,
                (a.last_seen_at is not null and a.last_seen_at > now() - interval '30 seconds') as online,
                (select count(*) from devices d where d.agent_id = a.id) as devices,
                (select count(*) from operations o where o.agent_id = a.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN')) as open_operations,
                (select min(o.created_at) from operations o where o.agent_id = a.id and o.status in ('PENDING','UNCERTAIN')) as oldest_pending
         from agents a order by a.name;
