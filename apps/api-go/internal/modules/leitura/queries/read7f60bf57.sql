-- name: Read7f60bf57 :many
select id, name, role from users where active and role <> 'subscriber' order by name;
