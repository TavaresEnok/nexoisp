select width_bucket(extract(epoch from (now() - last_end))/3600, array[2,4,6,12,24,48,96,144,360,720]) as faixa, count(*)::int as n
         from (select r.id, max(s.stopped_at) as last_end from service_resources r left join service_sessions s on s.resource_id = r.id
               join contracts k on k.id = r.contract_id
               where k.status = 'active' and r.desired_policy = 'active' and r.desired_version > 0 and (r.observed_session->>'online')::boolean is false
               group by r.id) x where last_end is not null group by 1 order by 1