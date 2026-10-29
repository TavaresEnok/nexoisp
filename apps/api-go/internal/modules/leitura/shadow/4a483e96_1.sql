-- Variante shadow de GET /api/invoices, índice 1. Uma sentença.
-- A página legada (filtros, parâmetros, paginação, ordem e joins)
-- permanece o conjunto. As laterais só então somam movimentos e pagamentos dessa
-- fatura. Não lê financial_balance_shadow e não troca paid_cents ::int.
select leg.*,
       cmp.nominal_cents as cmp_nominal_cents,
       cmp.fee_cents as cmp_fee_cents,
       cmp.discount_cents as cmp_discount_cents,
       cmp.received_cents as cmp_received_cents,
       cmp.status as cmp_status,
       cmp.legacy_nominal_cents as cmp_legacy_nominal_cents,
       cmp.legacy_fee_cents as cmp_legacy_fee_cents,
       cmp.legacy_discount_cents as cmp_legacy_discount_cents,
       cmp.legacy_received_cents as cmp_legacy_received_cents,
       cmp.legacy_status as cmp_legacy_status,
       cmp.residual_cents as cmp_residual_cents,
       cmp.excess_cents as cmp_excess_cents,
       cmp.collectible_cents as cmp_collectible_cents,
       (
         cmp.matches
         and leg.paid_cents::bigint = cmp.received_cents
         and leg.overdue is not distinct from (leg.status = 'open' and leg.due_date < $3::date)
         and cmp.residual_cents is not distinct from greatest(0, leg.amount_cents::bigint + leg.fee_cents::bigint - leg.discount_cents::bigint - leg.paid_cents::bigint)
         and cmp.excess_cents is not distinct from greatest(0, leg.paid_cents::bigint - (leg.amount_cents::bigint + leg.fee_cents::bigint - leg.discount_cents::bigint))
         and cmp.collectible_cents is not distinct from case when leg.status = 'canceled' then 0 else greatest(0, leg.amount_cents::bigint + leg.fee_cents::bigint - leg.discount_cents::bigint - leg.paid_cents::bigint) end
       ) is true as cmp_matches
from (
select i.*, s.name as subscriber_name, p.name as plan_name, (i.status = 'open' and i.due_date < $3::date) as overdue,
                (select coalesce(sum(x.signed_cents), 0)::int from payments x where x.invoice_id = i.id) as paid_cents
         from (select * from invoices i where ($1::uuid is null or i.contract_id = $1)
        and ($2::text is null or ($2 = 'overdue' and i.status = 'open' and i.due_date < $3::date) or ($2 <> 'overdue' and i.status = $2))
        and ($4::text is null or i.subscriber_id in (select s.id from subscribers s where s.name ilike '%' || $4 || '%'))
        and ($5::uuid is null or i.company_id = $5) order by i.due_date desc, i.created_at desc, i.id limit {{limit}} offset {{offset}}) i
         join subscribers s on s.id = i.subscriber_id join contracts k on k.id = i.contract_id
         join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
         order by i.due_date desc, i.created_at desc, i.id
) leg
left join lateral (
  select x.invoice_id, x.tenant_id, x.company_id, x.contract_id, x.status, x.legacy_status,
         x.nominal_cents, x.fee_cents, x.discount_cents, x.received_cents,
         x.legacy_nominal_cents, x.legacy_fee_cents, x.legacy_discount_cents, x.legacy_received_cents,
         greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as residual_cents,
         greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as excess_cents,
         case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as collectible_cents,
         (x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true as matches
  from lateral (
    select i.id as invoice_id, i.tenant_id, i.company_id, i.contract_id,
           m.last_status as status, i.status as legacy_status,
           m.nominal_cents, m.fee_cents, m.discount_cents,
           coalesce(pay.signed_cents, 0)::bigint as received_cents,
           i.amount_cents::bigint as legacy_nominal_cents,
           i.fee_cents::bigint as legacy_fee_cents,
           i.discount_cents::bigint as legacy_discount_cents,
           coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents
    from lateral (
      select i.id, i.tenant_id, i.company_id, i.contract_id, i.status, i.amount_cents, i.fee_cents, i.discount_cents
      from invoices i
      where i.id = leg.id and i.tenant_id = leg.tenant_id
    ) i
    left join lateral (
      select sum(mv.nominal_delta)::bigint as nominal_cents,
             sum(mv.fee_delta)::bigint as fee_cents,
             sum(mv.discount_delta)::bigint as discount_cents,
             (array_agg(mv.status_after order by mv.id desc))[1] as last_status
      from invoice_movements mv
      where mv.tenant_id = i.tenant_id and mv.invoice_id = i.id
    ) m on true
    left join lateral (
      select sum(py.signed_cents)::bigint as signed_cents
      from payments py
      where py.invoice_id = i.id and py.tenant_id = i.tenant_id
    ) pay on true
  ) x
) cmp on true
order by leg.due_date desc, leg.created_at desc, leg.id
