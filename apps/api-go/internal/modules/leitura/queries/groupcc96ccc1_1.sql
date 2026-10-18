-- name: Groupcc96ccc11 :many
select id, event, payload->>'text' as text, status, attempts, last_error, created_at, sent_at from notifications order by id desc limit 50;
