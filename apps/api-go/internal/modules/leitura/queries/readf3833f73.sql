-- name: Readf3833f73 :many
select id, entity, key, label, type, options, required, active, position from custom_fields
         where ($1::text is null or entity = $1) and ($2::boolean or active) order by entity, position, label;
