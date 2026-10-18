select i.status, i.due_date::text as due_date, i.amount_cents, i.fee_cents, i.discount_cents,
            case when i.status = 'open' then greatest(0, (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date - i.due_date)::int else 0 end as days_late,
            coalesce(ts.late_fee_percent, 0)::float as fine_pct, coalesce(ts.interest_monthly_percent, 0)::float as int_pct,
            (select coalesce(sum(signed_cents), 0)::int from payments p where p.invoice_id = i.id) as paid_cents
     from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id where i.id = $1