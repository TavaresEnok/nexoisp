select k.id as contract_id, s.name as subscriber_name, pl.name as plan_name, pv.price_cents::float as price_cents, k.due_day, k.start_date::text as start_date
         from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         where k.status = 'active' and pv.price_cents > 0
           and not exists (select 1 from invoices i where i.contract_id = k.id and i.status <> 'canceled'
                           and date_trunc('month', i.due_date) = date_trunc('month', now() at time zone coalesce((select timezone from tenant_settings ts where ts.tenant_id = k.tenant_id), 'America/Sao_Paulo')))
         order by s.name limit 2000