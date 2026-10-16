-- name: Read6349e7c2 :many
select d.*, a.name as agent_name, (a.last_seen_at is not null and a.last_seen_at > now() - interval '30 seconds') as agent_online,
                (select host(n.nas_ip) from radius_nas n where n.device_id = d.id) as nas_ip,
                coalesce((select json_build_object('kind', 'wireguard', 'ip', host(p.tunnel_ip), 'handshake_at', p.last_handshake_at, 'endpoint', p.endpoint) from vpn_peers p where p.device_id = d.id),
                         (select json_build_object('kind', 'l2tp', 'ip', host(l.tunnel_ip), 'handshake_at', case when l.connected then now() else l.last_seen_at end, 'endpoint', null) from l2tp_peers l where l.device_id = d.id)) as tunnel,
                (select count(*) from service_resources r where r.device_id = d.id) as accounts,
                (select count(*) from onus n where n.device_id = d.id and n.desired_state = 'authorized') as onus
         from devices d left join agents a on a.id = d.agent_id order by d.name;
