-- Variante shadow. A subconsulta é a sentença legada, com filtro, ordem, limite e colunas.
-- As laterais só somam a fatura já selecionada. O cast inteiro de paid_cents permanece.
select leg.*,
       cmp.cmp_residual_cents,
       cmp.cmp_excess_cents,
       cmp.cmp_collectible_cents,
       cmp.cmp_received_cents,
       cmp.cmp_nominal_cents,
       cmp.cmp_fee_cents,
       cmp.cmp_discount_cents,
       cmp.cmp_status,
       cmp.cmp_legacy_status,
       cmp.cmp_matches
from (
select i.*, s.name as subscriber_name, p.name as plan_name,
         (i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date) as overdue,
         (select coalesce(sum(signed_cents),0)::int from payments x where x.invoice_id = i.id) as paid_cents
  from invoices i join subscribers s on s.id = i.subscriber_id join contracts k on k.id = i.contract_id
  join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
  left join tenant_settings ts on ts.tenant_id = i.tenant_id where i.contract_id = $1 order by i.due_date desc limit 24
) leg
left join lateral (
  select greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as cmp_residual_cents,
         greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as cmp_excess_cents,
         case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as cmp_collectible_cents,
         x.received_cents as cmp_received_cents,
         x.nominal_cents as cmp_nominal_cents,
         x.fee_cents as cmp_fee_cents,
         x.discount_cents as cmp_discount_cents,
         x.status as cmp_status,
         x.legacy_status as cmp_legacy_status,
         (
           (x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true
           and x.received_cents = leg.paid_cents::bigint
           and greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) = greatest(0, leg.amount_cents::bigint + leg.fee_cents::bigint - leg.discount_cents::bigint - leg.paid_cents::bigint)
           and greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) = greatest(0, leg.paid_cents::bigint - (leg.amount_cents::bigint + leg.fee_cents::bigint - leg.discount_cents::bigint))
           and (case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end) = (case when leg.status = 'canceled' then 0 else greatest(0, leg.amount_cents::bigint + leg.fee_cents::bigint - leg.discount_cents::bigint - leg.paid_cents::bigint) end)
           and leg.contract_id = $1
         ) is true as cmp_matches
  from (
    select m.last_status as status, leg.status as legacy_status,
           m.nominal_cents, m.fee_cents, m.discount_cents,
           coalesce(pay.signed_cents, 0)::bigint as received_cents,
           leg.amount_cents::bigint as legacy_nominal_cents,
           leg.fee_cents::bigint as legacy_fee_cents,
           leg.discount_cents::bigint as legacy_discount_cents,
           coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents
    from (select 1) anchor
    left join lateral (
      select sum(mv.nominal_delta)::bigint as nominal_cents,
             sum(mv.fee_delta)::bigint as fee_cents,
             sum(mv.discount_delta)::bigint as discount_cents,
             (array_agg(mv.status_after order by mv.id desc))[1] as last_status
      from invoice_movements mv
      where mv.tenant_id = leg.tenant_id and mv.invoice_id = leg.id
    ) m on true
    left join lateral (
      select sum(py.signed_cents)::bigint as signed_cents
      from payments py
      where py.invoice_id = leg.id and py.tenant_id = leg.tenant_id
    ) pay on true
  ) x
) cmp on true
order by leg.due_date desc;
