-- name: Readb70df9cc :many
select id, kind, value, label, purpose, allow_notices, created_at from subscriber_contacts where subscriber_id = $1 order by created_at;
