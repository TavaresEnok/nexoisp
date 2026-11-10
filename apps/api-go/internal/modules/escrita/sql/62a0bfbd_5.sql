select distinct on (a.id) coalesce(a.delegated_ipv6_prefix, a.framed_ipv6_prefix)::text as ip, a.started_at, a.stopped_at, a.calling_station as mac, host(a.nas_ip) as nas_ip,
                a.terminate_cause, a.session_id as session_key, a.username as login,
                k.id as contract_id, sub.id as subscriber_id, sub.name, sub.document, sub.phone, sub.email,
                concat_ws(', ', sub.address_street, sub.address_number, sub.address_district, sub.address_city, sub.address_state) as address
         from radius_acct a join service_resources r on r.pppoe_username = a.username join contracts k on k.id = r.contract_id join subscribers sub on sub.id = k.subscriber_id
         where (a.delegated_ipv6_prefix >>= $1::inet or a.framed_ipv6_prefix >>= $1::inet)
           and a.started_at <= $3 and coalesce(a.stopped_at, a.updated_at) >= $2
         order by a.id, a.started_at limit 1001
