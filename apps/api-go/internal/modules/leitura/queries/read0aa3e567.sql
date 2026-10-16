-- name: Read0aa3e567 :many
select id, kind, name, active, created_at from catalog_items
         where ($1::text is null or kind = $1) and ($2::boolean or active) order by kind, name;
