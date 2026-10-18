select o.action, o.status, o.note, o.updated_at from operations o
         where (o.resource_id = $1 or o.onu_id = $2) order by o.created_at desc, o.desired_version desc limit 1