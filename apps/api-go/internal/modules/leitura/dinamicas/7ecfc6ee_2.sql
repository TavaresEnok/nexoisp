with d as (
           select (generate_series((now() at time zone $2)::date - ($3::int - 1), (now() at time zone $2)::date, interval '1 day'))::date as day),
         b as (select day, (day::timestamp at time zone $2) as t0, ((day + 1)::timestamp at time zone $2) as t1 from d)
         select to_char(b.day, 'YYYY-MM-DD') as day,
                greatest(0, extract(epoch from least(b.t1, now()) - greatest(b.t0, $4::timestamptz)))::float as window_seconds,
                least(coalesce(sum(greatest(0, extract(epoch from least(coalesce(s.stopped_at, now()), b.t1, now()) - greatest(s.started_at, b.t0)))) filter (where s.session_key is not null), 0),
                      greatest(0, extract(epoch from least(b.t1, now()) - b.t0)))::float as online_seconds,
                count(s.session_key)::int as sessions
         from b left join service_sessions s on s.resource_id = $1 and s.started_at < b.t1 and coalesce(s.stopped_at, now()) > b.t0
         group by b.day, b.t0, b.t1 order by b.day