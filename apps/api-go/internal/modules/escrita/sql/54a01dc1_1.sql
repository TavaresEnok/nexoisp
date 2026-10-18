select o.id, o.action, o.status, o.desired_version, o.attempts, o.note, o.reason, o.created_at, o.updated_at, o.finished_at, o.valid_until, o.result, o.authorization_ref,
                u.name as requested_by
         from operations o left join users u on u.id::text = o.authorization_ref->>'id' and o.authorization_ref->>'type' = 'user'
         where o.resource_id = $1 order by o.created_at desc, o.desired_version desc limit 15