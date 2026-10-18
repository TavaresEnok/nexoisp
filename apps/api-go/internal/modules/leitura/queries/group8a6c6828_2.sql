-- name: Group8a6c68282 :many
select id, number, kind, status, scheduled_for from work_orders where ticket_id = $1 order by number;
