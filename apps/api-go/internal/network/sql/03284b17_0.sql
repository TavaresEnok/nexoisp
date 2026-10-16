select a.id as attempt_id, a.status as attempt_status, o.*,
            (o.lease_until is null or o.lease_until < now()) as lease_expired, (o.valid_until < now()) as validity_expired
     from operation_attempts a join operations o on o.id = a.operation_id
     where a.id = $1 and a.agent_id = $2 for update of o