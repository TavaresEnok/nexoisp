-- name: UsageCheck0 :many
select 1 from contracts where id = $1 and subscriber_id = $2;
