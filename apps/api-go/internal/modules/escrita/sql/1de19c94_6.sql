select count(*) filter (where i.status = 'open')::int as open,
                count(*) filter (where i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date)::int as overdue,
                min(i.due_date) filter (where i.status = 'open') as oldest_due
         from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id where i.contract_id = $1