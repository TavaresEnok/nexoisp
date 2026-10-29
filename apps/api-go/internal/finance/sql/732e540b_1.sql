select id, status from invoices where id = any($1::uuid[]) and contract_id = $2 and tenant_id = $3::uuid order by id for update
