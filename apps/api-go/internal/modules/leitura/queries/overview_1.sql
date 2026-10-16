-- name: Overview1 :many
select k.id, k.status, k.due_day, k.start_date, p.name as plan_name, pv.price_cents, pv.down_kbps, pv.up_kbps,
                r.desired_policy, r.desired_version, r.observed_version, r.observed_policy, r.pppoe_username
         from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
         left join service_resources r on r.contract_id = k.id and r.desired_version > 0
         where k.subscriber_id = $1 order by k.status, k.created_at desc;
