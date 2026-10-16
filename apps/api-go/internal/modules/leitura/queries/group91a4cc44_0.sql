-- name: Group91a4cc440 :many

  select i.*, s.name as subscriber_name, p.name as plan_name,
         (i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date) as overdue,
         (select coalesce(sum(signed_cents),0)::int from payments x where x.invoice_id = i.id) as paid_cents
  from invoices i join subscribers s on s.id = i.subscriber_id join contracts k on k.id = i.contract_id
  join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
  left join tenant_settings ts on ts.tenant_id = i.tenant_id where i.id = $1;
