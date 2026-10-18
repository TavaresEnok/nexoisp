-- name: Read22e53523 :many
select e.id, e.name, e.url, e.events, e.active, e.created_at,
                (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pending')::int as pending,
                (select count(*) from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'failed')::int as failed
         from webhook_endpoints e order by e.name;
