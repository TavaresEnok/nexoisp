select k.id as contract_id, s.name as subscriber_name, pl.name as plan_name, count(i.id)::int as faturas,
                coalesce(sum(i.amount_cents + i.fee_cents - i.discount_cents),0)::bigint::float as cents,
                max($2::date - i.due_date)::int as dias_atraso
         from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         join invoices i on i.contract_id = k.id and i.status = 'open'
         where k.status = 'active'
         group by k.id, s.name, pl.name
         having max($2::date - i.due_date) > $1
         order by dias_atraso desc limit 1000