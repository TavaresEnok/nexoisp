-- name: Trust0 :many
select * from tenant_settings where tenant_id = $1;
