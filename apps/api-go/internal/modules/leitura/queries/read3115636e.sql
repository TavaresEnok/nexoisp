-- name: Read3115636e :many
select h.user_id, u.name, h.added_at from work_order_helpers h join users u on u.id = h.user_id where h.work_order_id = $1 order by u.name;
