-- name: Group3a79e37d0 :many
select to_char(m, 'YYYY-MM') as month,
                coalesce((select sum(p.signed_cents) from payments p
                  where p.paid_at >= (m at time zone $1::text)
                    and p.paid_at < ((m + interval '1 month') at time zone $1::text)), 0)::bigint as received_cents
         from generate_series(date_trunc('month', now() at time zone $1::text) - interval '5 months', date_trunc('month', now() at time zone $1::text), interval '1 month') m order by m;
