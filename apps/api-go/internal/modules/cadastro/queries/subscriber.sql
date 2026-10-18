-- name: Subscriber :one
select * from subscribers where id = $1;
