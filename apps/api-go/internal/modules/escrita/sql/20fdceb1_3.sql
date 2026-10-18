select s.started_at, s.stopped_at, s.mac, r.pppoe_username, r.contract_id, sub.id as subscriber_id, sub.name as subscriber_name
           from service_sessions s join service_resources r on r.id = s.resource_id join contracts k on k.id = r.contract_id join subscribers sub on sub.id = k.subscriber_id
           where s.ip = $1 and s.started_at <= $2::timestamptz and (s.stopped_at is null or s.stopped_at >= $2::timestamptz)
           order by s.started_at desc limit 5