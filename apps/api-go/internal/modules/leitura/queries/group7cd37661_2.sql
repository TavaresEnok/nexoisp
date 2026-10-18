-- name: Group7cd376612 :many
select count(*)::int as total, count(latitude)::int as located from pops where active;
