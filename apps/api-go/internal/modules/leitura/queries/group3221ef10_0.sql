-- name: Group3221ef100 :many
select a.id, a.at, a.actor_type, a.actor_id, coalesce(u.name, a.actor_id) as actor_name, a.action, a.entity_type, a.entity_id, a.result, a.detail
         from audit_events a left join users u on a.actor_type = 'user' and u.id::text = a.actor_id
         where a.tenant_id = $1 order by a.id desc;
