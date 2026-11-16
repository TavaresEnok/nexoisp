select k.id, k.latitude::float8 as lat, k.longitude::float8 as lng, k.status, s.name as subscriber_name, s.id as subscriber_id,
                  coalesce(r.desired_policy, 'active') as policy,
                  coalesce((r.observed_session->>'online')::boolean, false) as online,
                  b.latitude::float8 as box_lat, b.longitude::float8 as box_lng, b.name as box_name,
                  concat_ws(', ', nullif(concat_ws(' ', k.install_street, k.install_number), ''), k.install_district, k.install_city) as address
           from contracts k join subscribers s on s.id = k.subscriber_id
           left join service_resources r on r.contract_id = k.id and r.desired_version > 0
           left join lateral (select bx.latitude, bx.longitude, bx.name from ftth_drops d join ftth_boxes bx on bx.id = d.box_id
                              where d.contract_id = k.id and bx.latitude is not null order by d.created_at limit 1) b on true
           where k.latitude between $1 and $3 and k.{{lng}}
             and ($5::text is null or case when k.status = 'ended' then 'ended' when r.desired_policy = 'suspended' then 'suspended' else 'active' end = $5)
           order by k.id limit 3001