select leg.status, leg.loyalty_until, leg.penalty_model, leg.penalty_cents,
       leg.remaining_months, leg.within_loyalty, leg.open_cents, leg.open_count,
       (cmp.rows_match and cmp.residual_cents = leg.open_cents and cmp.collectible_cents = leg.open_cents and cmp.invoice_count = leg.open_count) is true as cmp_matches,
       cmp.residual_cents as cmp_residual_cents,
       cmp.excess_cents as cmp_excess_cents,
       cmp.collectible_cents as cmp_collectible_cents,
       cmp.rows_match as cmp_rows_match
from (
select k.status, k.loyalty_until, k.penalty_model, k.penalty_cents,
            greatest(0, (extract(year from age(k.loyalty_until, $2::date)) * 12 + extract(month from age(k.loyalty_until, $2::date))
                         + case when extract(day from age(k.loyalty_until, $2::date)) > 0 then 1 else 0 end))::int as remaining_months,
            (k.loyalty_until is not null and k.loyalty_until > $2::date) as within_loyalty,
            (select coalesce(sum(greatest(0, i.amount_cents + i.fee_cents - i.discount_cents - (select coalesce(sum(p.signed_cents),0) from payments p where p.invoice_id=i.id))), 0)::int from invoices i where i.contract_id = k.id and i.status = 'open') as open_cents,
            (select count(*)::int from invoices i where i.contract_id = k.id and i.status = 'open') as open_count
     from contracts k where k.id = $1
) leg
cross join lateral (
  select coalesce(bool_and(x.matches), true) as rows_match,
         coalesce(sum(x.residual_cents), 0)::bigint as residual_cents,
         coalesce(sum(x.excess_cents), 0)::bigint as excess_cents,
         coalesce(sum(x.collectible_cents), 0)::bigint as collectible_cents,
         count(x.invoice_id)::bigint as invoice_count
  from (
    select x.invoice_id,
           greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as residual_cents,
           greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as excess_cents,
           case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as collectible_cents,
           (x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true as matches
    from (
      select i.id as invoice_id, i.tenant_id, i.company_id, i.contract_id,
             m.last_status as status, i.status as legacy_status,
             m.nominal_cents, m.fee_cents, m.discount_cents,
             coalesce(pay.signed_cents, 0)::bigint as received_cents,
             i.amount_cents::bigint as legacy_nominal_cents,
             i.fee_cents::bigint as legacy_fee_cents,
             i.discount_cents::bigint as legacy_discount_cents,
             coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents
      from (
        select inv.id, inv.tenant_id, inv.company_id, inv.contract_id, inv.status,
               inv.amount_cents, inv.fee_cents, inv.discount_cents
        from invoices inv
        where inv.contract_id = $1
          and inv.status = 'open'
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
  ) x
) cmp
