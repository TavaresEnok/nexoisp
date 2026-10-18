-- name: Overview2 :many
select i.id, i.contract_id, i.competence, i.due_date, i.amount_cents, i.status, i.paid_at, i.gateway,
                case when i.status = 'open' then i.payment_methods end as payment_methods,
                (i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date) as overdue
         from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id
         where i.subscriber_id = $1 and i.status <> 'canceled' order by i.due_date desc limit 36;
