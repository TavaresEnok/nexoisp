-- name: Me0 :many
select id, name, slug from tenants where id = $1;
