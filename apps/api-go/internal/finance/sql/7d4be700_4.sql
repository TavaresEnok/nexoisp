select 1 from invoices where contract_id = $1 and status = 'open' and id <> $2
       and due_date + coalesce($3::int, 0) < (now() at time zone $4)::date limit 1