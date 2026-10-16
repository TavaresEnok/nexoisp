select k.id, k.latitude::float8 as lat, k.longitude::float8 as lng, k.status, s.name as subscriber_name, s.id as subscriber_id,
                  coalesce(r.desired_policy, 'active') as policy,
                  concat_ws(', ', nullif(concat_ws(' ', k.install_street, k.install_number), ''), k.install_district, k.install_city) as address
           from contracts k join subscribers s on s.id = k.subscriber_id
           left join service_resources r on r.contract_id = k.id and r.desired_version > 0
           where k.latitude between $1 and $3 and k.{{lng}}
             and ($5::text is null or case when k.status = 'ended' then 'ended' when r.desired_policy = 'suspended' then 'suspended' else 'active' end = $5)
           order by k.id limit 3001