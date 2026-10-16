-- name: Readc93de48d :many
select u.id, u.name, u.email, u.role, u.active, u.mfa_enabled, u.created_at,
                coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name) order by p.name) from user_pops x join pops p on p.id = x.pop_id where x.user_id = u.id), '[]') as pops
         from users u where u.tenant_id = $1 and u.role <> 'subscriber' order by u.name;
