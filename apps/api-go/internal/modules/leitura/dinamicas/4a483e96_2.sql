select count(*) as n from invoices i where ($1::uuid is null or i.contract_id = $1)
        and ($2::text is null or ($2 = 'overdue' and i.status = 'open' and i.due_date < $3::date) or ($2 <> 'overdue' and i.status = $2))
        and ($4::text is null or i.subscriber_id in (select s.id from subscribers s where s.name ilike '%' || $4 || '%'))
        and ($5::uuid is null or i.company_id = $5)