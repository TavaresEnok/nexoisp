-- name: Plans0 :many
select p.*, pv.id as version_id, pv.version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name, pv.valid_from,
                (select count(*) from contracts c join plan_versions x on x.id = c.plan_version_id where x.plan_id = p.id and c.status = 'active') as active_contracts
         from plans p join lateral (select * from plan_versions v where v.plan_id = p.id order by version desc limit 1) pv on true
         order by p.active desc, p.name;
