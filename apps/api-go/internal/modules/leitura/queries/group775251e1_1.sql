-- name: Group775251e11 :many
select e.at, e.event, e.detail, u.name as actor_name from lead_events e left join users u on u.id = e.actor_id where e.lead_id = $1 order by e.id desc;
