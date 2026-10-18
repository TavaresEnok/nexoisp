-- name: Group84bb53020 :many
select t.slug, s.notice_page from tenants t left join tenant_settings s on s.tenant_id = t.id where t.id = $1;
