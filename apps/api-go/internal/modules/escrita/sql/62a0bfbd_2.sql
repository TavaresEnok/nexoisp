select s.ip, s.started_at, s.stopped_at, s.mac, s.nas_ip, s.terminate_cause, s.session_key, r.pppoe_username as login,
                k.id as contract_id, sub.id as subscriber_id, sub.name, sub.document, sub.phone, sub.email,
                concat_ws(', ', sub.address_street, sub.address_number, sub.address_district, sub.address_city, sub.address_state) as address
         from service_sessions s join service_resources r on r.id = s.resource_id join contracts k on k.id = r.contract_id join subscribers sub on sub.id = k.subscriber_id
         where s.ip = any($1::text[]) and s.started_at <= $3 and coalesce(s.stopped_at, now()) >= $2
         order by s.started_at limit 1001