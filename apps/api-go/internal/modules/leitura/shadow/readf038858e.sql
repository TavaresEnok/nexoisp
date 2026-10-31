-- Variante shadow do resumo. Caixa mensal bigint no mesmo intervalo local do leitor.
-- A seleção de faturas open ou reconciling é uma só. As laterais filtram essa linha antes de somar.
with selected as (
select i.*, (select coalesce(sum(p.signed_cents),0) from payments p where p.invoice_id=i.id) as paid_cents, (i.status = 'open' and i.due_date < today.d) as overdue from invoices i, (select (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date as d) today
               where i.status in ('open', 'reconciling') and ($1::uuid is null or i.company_id = $1)
)
select counted.open,
       counted.open_cents,
       counted.nominal_open_cents,
       counted.received_open_cents,
       counted.overdue,
       counted.overdue_cents,
       counted.reconciling,
       counted.received_month_cents,
       (counted.open_cents = counted.cmp_open_cents
        and counted.overdue_cents = counted.cmp_overdue_cents
        and counted.nominal_open_cents = counted.cmp_nominal_open_cents
        and counted.received_open_cents = counted.cmp_received_open_cents
        and counted.open_cents = counted.cmp_collectible_open_cents
        and counted.cmp_rows) is true as cmp_matches,
       counted.cmp_open_cents,
       counted.cmp_overdue_cents,
       counted.cmp_nominal_open_cents,
       counted.cmp_received_open_cents,
       counted.cmp_residual_cents,
       counted.cmp_excess_cents,
       counted.cmp_collectible_cents,
       counted.cmp_collectible_open_cents
from (
select count(*) filter (where status = 'open') as open, coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where status = 'open'),0)::bigint as open_cents,
                coalesce(sum(amount_cents) filter (where status = 'open'),0)::bigint as nominal_open_cents,
                coalesce(sum(paid_cents) filter (where status = 'open'),0)::bigint as received_open_cents,
                count(*) filter (where overdue) as overdue, coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where overdue),0)::bigint as overdue_cents,
                count(*) filter (where status = 'reconciling') as reconciling,
                (select coalesce(sum(p.signed_cents),0)::bigint from payments p join invoices pi on pi.id = p.invoice_id
                  cross join (select coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo') as tz) zone
                  where p.paid_at >= (date_trunc('month', now() at time zone zone.tz) at time zone zone.tz)
                    and p.paid_at < ((date_trunc('month', now() at time zone zone.tz) + interval '1 month') at time zone zone.tz)
                    and ($1::uuid is null or pi.company_id = $1)) as received_month_cents,
       coalesce(sum(cmp_residual_cents) filter (where status = 'open'),0)::bigint as cmp_open_cents,
       coalesce(sum(cmp_residual_cents) filter (where overdue),0)::bigint as cmp_overdue_cents,
       coalesce(sum(row_nominal_cents) filter (where status = 'open'),0)::bigint as cmp_nominal_open_cents,
       coalesce(sum(row_received_cents) filter (where status = 'open'),0)::bigint as cmp_received_open_cents,
       coalesce(bool_and(row_matches), true) as cmp_rows,
       coalesce(sum(cmp_residual_cents),0)::bigint as cmp_residual_cents,
       coalesce(sum(cmp_excess_cents),0)::bigint as cmp_excess_cents,
       coalesce(sum(cmp_collectible_cents) filter (where status = 'open'),0)::bigint as cmp_collectible_open_cents,
       coalesce(sum(cmp_collectible_cents),0)::bigint as cmp_collectible_cents
from (
  select selected.status, selected.amount_cents, selected.fee_cents, selected.discount_cents, selected.paid_cents, selected.overdue,
         cmp.row_matches, cmp.cmp_residual_cents, cmp.cmp_excess_cents, cmp.cmp_collectible_cents, cmp.row_nominal_cents, cmp.row_received_cents
  from selected
  left join lateral (
    select greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as cmp_residual_cents,
           greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as cmp_excess_cents,
           case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as cmp_collectible_cents,
           x.nominal_cents as row_nominal_cents,
           x.received_cents as row_received_cents,
           (
             (x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true
             and x.received_cents = selected.paid_cents::bigint
             and greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) = greatest(0, selected.amount_cents::bigint + selected.fee_cents::bigint - selected.discount_cents::bigint - selected.paid_cents::bigint)
             and greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) = greatest(0, selected.paid_cents::bigint - (selected.amount_cents::bigint + selected.fee_cents::bigint - selected.discount_cents::bigint))
             and (case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end) = (case when selected.status = 'canceled' then 0 else greatest(0, selected.amount_cents::bigint + selected.fee_cents::bigint - selected.discount_cents::bigint - selected.paid_cents::bigint) end)
             and selected.status in ('open', 'reconciling')
             and ($1::uuid is null or selected.company_id = $1)
           ) is true as row_matches
    from (
      select m.last_status as status, selected.status as legacy_status,
             m.nominal_cents, m.fee_cents, m.discount_cents,
             coalesce(pay.signed_cents, 0)::bigint as received_cents,
             selected.amount_cents::bigint as legacy_nominal_cents,
             selected.fee_cents::bigint as legacy_fee_cents,
             selected.discount_cents::bigint as legacy_discount_cents,
             coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents
      from (select 1) anchor
      left join lateral (
        select sum(mv.nominal_delta)::bigint as nominal_cents,
               sum(mv.fee_delta)::bigint as fee_cents,
               sum(mv.discount_delta)::bigint as discount_cents,
               (array_agg(mv.status_after order by mv.id desc))[1] as last_status
        from invoice_movements mv
        where mv.tenant_id = selected.tenant_id and mv.invoice_id = selected.id
      ) m on true
      left join lateral (
        select sum(py.signed_cents)::bigint as signed_cents
        from payments py
        where py.invoice_id = selected.id and py.tenant_id = selected.tenant_id
      ) pay on true
    ) x
  ) cmp on true
) x
) counted;
