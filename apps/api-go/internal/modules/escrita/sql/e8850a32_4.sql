
  select n.id, n.serial, n.contract_id, n.device_id, n.pon_port, n.observed_state, n.observed_online, n.observed_rx_dbm, n.observed_tx_dbm, n.observed_at,
         n.desired_state, n.desired_version, n.observed_version, d.name as device_name, d.maintenance, s.name as subscriber_name,
         (a.last_seen_at is not null and a.last_seen_at > now() - interval '30 seconds') as agent_online
  from onus n join devices d on d.id = n.device_id join contracts k on k.id = n.contract_id join subscribers s on s.id = k.subscriber_id
  left join agents a on a.id = d.agent_id where n.desired_state = 'authorized' and n.observed_at is not null and (n.observed_state = 'absent' or n.observed_online is false) order by n.observed_at desc limit 200