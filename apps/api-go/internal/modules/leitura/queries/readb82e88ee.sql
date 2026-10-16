-- name: Readb82e88ee :many
select e.at, e.detail, u.name as user_name from audit_events e left join users u on u.id::text = e.actor_id
         where e.action = 'legal.ip_lookup' order by e.at desc limit 100;
