select s.session_key, s.started_at, s.stopped_at, s.ip, s.mac, s.nas_ip, s.bytes_in::float as bytes_in, s.bytes_out::float as bytes_out,
                s.seconds::float as seconds, s.terminate_cause
         from service_sessions s join service_resources r on r.id = s.resource_id
         where r.contract_id = $1 and ($2::date is null or s.started_at >= $2::date) and ($3::date is null or s.started_at < $3::date + 1)
         order by s.started_at desc limit 1000