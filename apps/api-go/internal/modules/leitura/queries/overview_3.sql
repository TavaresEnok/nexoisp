-- name: Overview3 :many
select m.id, m.title, m.message, m.severity, m.starts_at, m.ends_at, (now() >= m.starts_at) as active
         from maintenance_notices m
         where m.canceled_at is null and m.ends_at > now() and m.starts_at < now() + interval '7 days'
           and (m.device_id is null or exists (select 1 from service_resources r join contracts k on k.id = r.contract_id
                                               where k.subscriber_id = $1 and r.device_id = m.device_id))
         order by m.starts_at;
