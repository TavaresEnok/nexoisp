select o.id, o.action, o.status, o.desired_version, o.attempts, o.note, o.reason, o.created_at, o.updated_at, o.finished_at,
                coalesce(r.pppoe_username, 'ONU ' || n.serial) as pppoe_username, k.id as contract_id, s.name as subscriber_name, d.name as device_name
         from operations o left join service_resources r on r.id = o.resource_id left join onus n on n.id = o.onu_id
         join contracts k on k.id = coalesce(r.contract_id, n.contract_id)
         join subscribers s on s.id = k.subscriber_id join devices d on d.id = o.device_id
         where $1 = 'all' or ($1 = 'open' and o.status = any($2))
            or ($1 = 'problem' and (o.status in ('UNCERTAIN','FAILED','EXPIRED') or (o.status = any($2) and o.created_at < now() - interval '2 minutes')))
         order by o.created_at desc, o.id