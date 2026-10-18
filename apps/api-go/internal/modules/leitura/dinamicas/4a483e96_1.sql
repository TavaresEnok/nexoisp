select i.*, s.name as subscriber_name, p.name as plan_name, (i.status = 'open' and i.due_date < $3::date) as overdue,
                (select coalesce(sum(x.signed_cents), 0)::int from payments x where x.invoice_id = i.id) as paid_cents
         from (select * from invoices i where ($1::uuid is null or i.contract_id = $1)
        and ($2::text is null or ($2 = 'overdue' and i.status = 'open' and i.due_date < $3::date) or ($2 <> 'overdue' and i.status = $2))
        and ($4::text is null or i.subscriber_id in (select s.id from subscribers s where s.name ilike '%' || $4 || '%'))
        and ($5::uuid is null or i.company_id = $5) order by i.due_date desc, i.created_at desc, i.id limit {{limit}} offset {{offset}}) i
         join subscribers s on s.id = i.subscriber_id join contracts k on k.id = i.contract_id
         join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
         order by i.due_date desc, i.created_at desc, i.id