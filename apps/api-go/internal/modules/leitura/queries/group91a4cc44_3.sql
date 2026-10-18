-- name: Group91a4cc443 :many
select id, event_id, type, status, note, received_at from gateway_events where gateway = $1 and charge_id = $2 order by id;
