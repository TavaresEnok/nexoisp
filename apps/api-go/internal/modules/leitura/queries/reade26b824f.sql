-- name: Reade26b824f :many
select x.id, x.device_id, d.name as device_name, d.driver, x.serial, x.pon_port, x.vendor, x.model, x.first_seen_at, x.last_seen_at
         from onu_discoveries x join devices d on d.id = x.device_id
         where not exists (select 1 from onus n where n.serial = x.serial and n.desired_state = 'authorized')
         order by x.first_seen_at desc limit 500;
