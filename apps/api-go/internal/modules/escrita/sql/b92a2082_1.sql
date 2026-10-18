select {{expr}} as grupo, count(*) filter (where p.kind = 'payment')::int as pagamentos, coalesce(sum(p.signed_cents),0)::bigint::float as cents
         from payments p join invoices i on i.id = p.invoice_id join contracts k on k.id = i.contract_id
         join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         where (p.paid_at at time zone $3)::date between $1::date and $2::date
         group by 1 order by 3 desc