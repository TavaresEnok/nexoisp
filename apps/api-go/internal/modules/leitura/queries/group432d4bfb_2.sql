-- name: Group432d4bfb2 :many
select h.user_id, u.name from work_order_helpers h join users u on u.id = h.user_id where h.work_order_id = $1 order by u.name;
