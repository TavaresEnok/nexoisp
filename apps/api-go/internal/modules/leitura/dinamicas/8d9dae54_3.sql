select count(*) filter (where i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date)::int as overdue,
                  coalesce(sum(i.amount_cents) filter (where i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date), 0)::int as overdue_cents,
                  count(*) filter (where i.status = 'reconciling')::int as reconciling
           from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id