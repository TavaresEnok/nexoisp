select coalesce(nullif(l.source, ''), '(não informada)') as source, count(*)::int as created,
                count(*) filter (where l.stage = 'won')::int as won, count(*) filter (where l.stage = 'lost')::int as lost,
                count(*) filter (where l.stage in ('new','contacted','proposal'))::int as open
         from leads l where (l.created_at at time zone $3)::date between $1::date and $2::date group by 1 order by 2 desc, 1