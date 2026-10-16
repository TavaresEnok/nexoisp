-- name: Groupcc96ccc10 :many
select notify_webhook_url from tenant_settings where tenant_id = $1;
