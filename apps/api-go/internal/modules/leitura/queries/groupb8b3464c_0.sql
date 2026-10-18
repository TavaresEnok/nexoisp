-- name: Groupb8b3464c0 :many
select d.name, host(n.nas_ip) as ip, (p.device_id is not null) as via_tunnel from radius_nas n join devices d on d.id = n.device_id
         left join (select device_id from vpn_peers union all select device_id from l2tp_peers) p on p.device_id = n.device_id order by d.name;
