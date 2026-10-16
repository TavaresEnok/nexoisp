-- name: Readf038858e :many
select count(*) filter (where status = 'open') as open, coalesce(sum(amount_cents) filter (where status = 'open'),0)::int as open_cents,
                count(*) filter (where overdue) as overdue, coalesce(sum(amount_cents) filter (where overdue),0)::int as overdue_cents,
                count(*) filter (where status = 'reconciling') as reconciling,
                (select coalesce(sum(p.signed_cents),0)::int from payments p join invoices pi on pi.id = p.invoice_id
                  where p.paid_at >= date_trunc('month', now()) and ($1::uuid is null or pi.company_id = $1)) as received_month_cents
         from (select i.*, (i.status = 'open' and i.due_date < today.d) as overdue from invoices i, (select (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date as d) today
               where i.status in ('open', 'reconciling') and ($1::uuid is null or i.company_id = $1)) x;
