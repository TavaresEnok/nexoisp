-- name: Group98e9e79f0 :many
select t.*, (select count(*) from users u where u.tenant_id = t.id and u.role <> 'subscriber') as users,
                h.agents, h.agents_offline, h.uncertain, h.failed_recent
         from tenants t left join platform_health() h on h.tenant_id = t.id order by t.name;
