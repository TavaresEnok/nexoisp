select o.* from operations o join devices d on d.id = o.device_id
     where o.agent_id = $1 and o.status = $2 and (o.next_attempt_at is null or o.next_attempt_at <= now())
       and not d.maintenance
       and not exists (select 1 from operations x where x.device_id = o.device_id and x.id <> o.id and x.status in ('RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))
     order by o.created_at, o.desired_version limit 1 for update of o skip locked