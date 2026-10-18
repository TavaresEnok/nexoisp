select o.id, o.created_at, o.action, o.status, o.reason, k.id as contract_id, u.name as by
           from operations o join service_resources r on r.id = o.resource_id join contracts k on k.id = r.contract_id
           left join users u on u.id::text = o.authorization_ref->>'id' and o.authorization_ref->>'type' = 'user'
           where k.subscriber_id = $1 order by o.created_at desc limit $2