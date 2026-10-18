select s.started_at, s.stopped_at, s.ip, s.mac, s.nas_ip, s.bytes_in, s.bytes_out, s.terminate_cause
                              from service_sessions s join service_resources r on r.id = s.resource_id join contracts k on k.id = r.contract_id
                              where k.subscriber_id = $1 order by s.started_at desc limit 5000