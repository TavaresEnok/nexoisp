select s.name as subscriber_name, r.pppoe_username as login, r.observed_session->>'ip' as ip, r.observed_session->>'caller_id' as mac,
                coalesce(case when r.observed_session->>'since' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then regexp_replace(to_char(justify_hours(now() - (r.observed_session->>'since')::timestamptz), 'FMDD"d"FMHH24"h"FMMI"m"FMSS"s"'), '^(0d)?(0h)?(0m)?', '') end,
                         r.observed_session->>'uptime') as uptime, d.name as nas, po.name as pop, r.id as resource_id, r.contract_id, r.desired_policy, r.observed_at,
                p.name as plan_name, o.device_name as olt, o.pon_port as pon
         from service_resources r join contracts k on k.id = r.contract_id join subscribers s on s.id = k.subscriber_id
         join devices d on d.id = r.device_id left join pops po on po.id = k.pop_id
         left join plan_versions pv on pv.id = k.plan_version_id left join plans p on p.id = pv.plan_id
         left join lateral (select od.name as device_name, ou.pon_port from onus ou join devices od on od.id = ou.device_id
                            where ou.contract_id = k.id and ou.desired_state = 'authorized' order by ou.created_at desc limit 1) o on true
         where (r.observed_session->>'online')::boolean is true and ($1::text is null or s.name ilike $1 or r.pppoe_username ilike $1 or r.observed_session->>'ip' like $1)
         order by s.name limit 5000