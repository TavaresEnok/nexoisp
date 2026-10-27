select a.id as attempt_id, a.status as attempt_status, a.recover as attempt_recover, g.internal as internal_agent, o.*,
            (o.lease_until is null or o.lease_until < now()) as lease_expired, (o.valid_until < now()) as validity_expired
     from operation_attempts a join operations o on o.id = a.operation_id join agents g on g.id=a.agent_id and g.tenant_id=a.tenant_id
     where a.id = $1 and a.agent_id = $2 for update of o