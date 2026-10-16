-- name: Group775251e10 :many

  select l.*, p.name as plan_name, o.name as owner_name, s.name as subscriber_name
  from leads l left join plans p on p.id = l.plan_id left join users o on o.id = l.owner_id left join subscribers s on s.id = l.subscriber_id where l.id = $1;
