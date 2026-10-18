select i.id, i.subscriber_id, i.contract_id, i.competence, i.due_date, i.amount_cents, i.status, i.paid_at
       from invoices i where ($1::uuid is null or i.subscriber_id = $1) and ($2::uuid is null or i.contract_id = $2) and ($3::text is null or i.status = $3)
       order by i.due_date desc, i.id