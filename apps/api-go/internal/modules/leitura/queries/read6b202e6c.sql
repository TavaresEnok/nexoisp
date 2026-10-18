-- name: Read6b202e6c :many
select p.id, p.name from user_pops u join pops p on p.id = u.pop_id where u.user_id = $1 order by p.name;
