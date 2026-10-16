select k.id, k.subscriber_id, k.status, k.due_day, k.start_date, p.name as plan_name, pv.price_cents, pv.down_kbps, pv.up_kbps,
              case when r.desired_version > 0 then r.desired_policy end as access
       from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
       left join service_resources r on r.contract_id = k.id
       where ($1::uuid is null or k.subscriber_id = $1) and ($2::text is null or k.status = $2) order by k.created_at desc, k.id