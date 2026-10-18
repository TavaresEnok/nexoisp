-- name: Tickets0 :many
select t.id, t.number, t.subject, t.category, t.status, t.created_at, t.updated_at, t.closed_at from tickets t where t.subscriber_id = $1 order by (t.status = 'closed'), t.updated_at desc limit 50;
