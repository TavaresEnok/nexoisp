-- name: Readf038858e :many
select count(*) filter (where status = 'open') as open, coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where status = 'open'),0)::bigint as open_cents,
                coalesce(sum(amount_cents) filter (where status = 'open'),0)::bigint as nominal_open_cents,
                coalesce(sum(paid_cents) filter (where status = 'open'),0)::bigint as received_open_cents,
                count(*) filter (where overdue) as overdue, coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where overdue),0)::bigint as overdue_cents,
                count(*) filter (where status = 'reconciling') as reconciling,
                (select coalesce(sum(p.signed_cents),0)::bigint from payments p join invoices pi on pi.id = p.invoice_id
                  cross join (select coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo') as tz) zone
                  where p.paid_at >= (date_trunc('month', now() at time zone zone.tz) at time zone zone.tz)
                    and p.paid_at < ((date_trunc('month', now() at time zone zone.tz) + interval '1 month') at time zone zone.tz)
                    and ($1::uuid is null or pi.company_id = $1)) as received_month_cents
         from (select i.*, (select coalesce(sum(p.signed_cents),0) from payments p where p.invoice_id=i.id) as paid_cents, (i.status = 'open' and i.due_date < today.d) as overdue from invoices i, (select (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date as d) today
               where i.status in ('open', 'reconciling') and ($1::uuid is null or i.company_id = $1)) x;
