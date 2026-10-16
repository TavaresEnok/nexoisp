-- name: Read9d315143 :many
select d.id, d.event, d.status, d.attempts, d.last_error, d.response_status, d.created_at, d.sent_at, d.next_attempt_at, e.name as endpoint_name
         from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
         where ($1::uuid is null or d.endpoint_id = $1) and ($2::text is null or d.status = $2) order by d.id desc limit 100;
