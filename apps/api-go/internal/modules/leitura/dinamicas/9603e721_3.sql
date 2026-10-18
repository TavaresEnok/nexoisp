select to_char(m, 'YYYY-MM') as month,
                (select count(*) from contracts k where k.start_date >= m and k.start_date < m + interval '1 month')::int as ativacoes,
                (select count(*) from contracts k where k.status = 'ended' and k.end_date >= m and k.end_date < m + interval '1 month')::int as encerramentos
         from generate_series(date_trunc('month', (now() at time zone $1)::date) - interval '11 months', date_trunc('month', (now() at time zone $1)::date), interval '1 month') m order by m