-- name: Ticket0 :many
select t.id, t.number, t.subject, t.category, t.status, t.created_at, t.updated_at, t.closed_at from tickets t where t.id = $1 and t.subscriber_id = $2;
