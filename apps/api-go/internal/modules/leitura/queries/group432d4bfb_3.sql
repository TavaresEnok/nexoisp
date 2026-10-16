-- name: Group432d4bfb3 :many
select k.id, k.position, k.label, k.done, k.done_at, u.name as done_by_name
         from work_order_checklist k left join users u on u.id = k.done_by where k.work_order_id = $1 order by k.position;
