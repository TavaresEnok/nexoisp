-- name: Read222cfde9 :many

  select n.*, d.name as device_name, d.driver, d.maintenance, s.id as subscriber_id, s.name as subscriber_name, k.status as contract_status,
         a.name as agent_name, (a.last_seen_at is not null and a.last_seen_at > now() - interval '30 seconds') as agent_online,
         (n.observed_at is not null and n.desired_version > 0
           and ((n.desired_state = 'authorized') <> (n.observed_state = 'authorized'))
           and not exists (select 1 from operations o where o.onu_id = n.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))) as drift
  from onus n join devices d on d.id = n.device_id join contracts k on k.id = n.contract_id join subscribers s on s.id = k.subscriber_id
  left join agents a on a.id = d.agent_id order by n.created_at desc limit 500;
