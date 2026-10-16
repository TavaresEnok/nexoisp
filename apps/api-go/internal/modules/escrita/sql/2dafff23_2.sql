select to_char((s.started_at at time zone $2)::date, 'YYYY-MM-DD') as day, sum(s.bytes_in)::float as bytes_in, sum(s.bytes_out)::float as bytes_out, count(*)::int as sessions
         from service_sessions s join service_resources r on r.id = s.resource_id
         where r.contract_id = $1 and ($3::date is null or s.started_at >= $3::date) and ($4::date is null or s.started_at < $4::date + 1)
         group by 1 order by 1 desc limit 400