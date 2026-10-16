-- name: Overview4 :many
select k.id as contract_id, to_char(u.month, 'YYYY-MM') as month, u.bytes_in::float as bytes_in, u.bytes_out::float as bytes_out, u.sessions
         from usage_monthly u join service_resources r on r.id = u.resource_id join contracts k on k.id = r.contract_id
         where k.subscriber_id = $1 order by u.month desc limit 12;
