select s.id as subscriber_id, s.name as subscriber_name, s.document, s.status as subscriber_status,
                           k.id as contract_id, k.status as contract_status, p.name as plan_name,
                           r.pppoe_username, r.desired_policy, r.observed_policy,
                           (r.observed_session->>'online')::boolean as online, r.observed_session->>'ip' as ip, r.mac,
                           {{finance_overdue}} as overdue
                    from subscribers s
                    left join contracts k on k.subscriber_id = s.id
                    left join plan_versions pv on pv.id = k.plan_version_id left join plans p on p.id = pv.plan_id
                    left join service_resources r on r.contract_id = k.id join service_sessions ss on ss.resource_id = r.id where ss.ip = $1 {{lim}}