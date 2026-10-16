-- name: Dashboard0 :many
select (select count(*) from subscribers where status = 'active') as subscribers,
                (select count(*) from contracts where status = 'active') as contracts,
                (select count(*) from plans where active) as plans,
                (select coalesce(sum(pv.price_cents),0) from contracts c join plan_versions pv on pv.id = c.plan_version_id where c.status = 'active') as mrr_cents;
