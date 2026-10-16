-- name: Readc15bf40d :many
select e.at, e.event, e.detail, u.name as actor_name from stock_unit_events e left join users u on u.id = e.actor_id where e.unit_id = $1 order by e.id desc;
