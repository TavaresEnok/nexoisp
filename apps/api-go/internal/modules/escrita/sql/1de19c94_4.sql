select * from (
  select n.device_id, d.name as device_name, n.pon_port, count(*)::int as total,
         count(*) filter (where n.observed_state = 'absent' or n.observed_online is false)::int as down, max(n.observed_at) as read_at
  from onus n join devices d on d.id = n.device_id
  where n.desired_state = 'authorized' and n.observed_at is not null group by n.device_id, d.name, n.pon_port) g where g.device_id = $1 and g.pon_port = $2