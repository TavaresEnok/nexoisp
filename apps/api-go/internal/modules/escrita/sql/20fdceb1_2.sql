select r.pppoe_username, r.observed_at, r.contract_id, s.id as subscriber_id, s.name as subscriber_name
           from service_resources r join contracts k on k.id = r.contract_id join subscribers s on s.id = k.subscriber_id
           where r.observed_session->>'ip' = $1 and (r.observed_session->>'online')::boolean is true