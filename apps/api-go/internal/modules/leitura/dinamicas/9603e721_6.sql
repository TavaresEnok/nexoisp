select o.created_at, o.action, o.status, o.reason, s.name as subscriber_name, k.id as contract_id
         from operations o join service_resources r on r.id = o.resource_id join contracts k on k.id = r.contract_id join subscribers s on s.id = k.subscriber_id
         order by o.created_at desc limit 8