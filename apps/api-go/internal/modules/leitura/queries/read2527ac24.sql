-- name: Read2527ac24 :many
select to_char(u.month, 'YYYY-MM') as month, u.bytes_in::float as bytes_in, u.bytes_out::float as bytes_out, u.session_seconds::float as session_seconds, u.sessions, u.reported_at
         from usage_monthly u join service_resources r on r.id = u.resource_id where r.contract_id = $1 order by u.month desc limit 12;
