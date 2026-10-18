-- name: Group3a79e37d0 :many
select to_char(m, 'YYYY-MM') as month,
                coalesce((select sum(p.signed_cents) from payments p where date_trunc('month', p.paid_at at time zone $1) = m), 0)::int as received_cents
         from generate_series(date_trunc('month', now() at time zone $1) - interval '5 months', date_trunc('month', now() at time zone $1), interval '1 month') m order by m;
