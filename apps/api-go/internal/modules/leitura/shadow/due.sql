-- Variante de comparação do GET /api/invoices/{id}/due.
-- Colunas legadas de queries/due.sql permanecem a resposta. A prévia de multa
-- e juros não entra aqui. As laterais copiam a fórmula de
-- queries/balance_shadow_compare.sql e só aparecem como cmp_.
select i.status, i.due_date::text as due_date, i.amount_cents, i.fee_cents, i.discount_cents,
       case when i.status = 'open' then greatest(0, (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date - i.due_date)::int else 0 end as days_late,
       coalesce(ts.late_fee_percent, 0)::float as fine_pct, coalesce(ts.interest_monthly_percent, 0)::float as int_pct,
       (select coalesce(sum(signed_cents), 0)::int from payments p where p.invoice_id = i.id) as paid_cents,
       cmp.nominal_cents as cmp_nominal_cents,
       cmp.fee_cents as cmp_fee_cents,
       cmp.discount_cents as cmp_discount_cents,
       cmp.received_cents as cmp_received_cents,
       cmp.legacy_nominal_cents as cmp_legacy_nominal_cents,
       cmp.legacy_fee_cents as cmp_legacy_fee_cents,
       cmp.legacy_discount_cents as cmp_legacy_discount_cents,
       cmp.legacy_received_cents as cmp_legacy_received_cents,
       cmp.status as cmp_status,
       cmp.legacy_status as cmp_legacy_status,
       cmp.residual_cents as cmp_residual_cents,
       cmp.excess_cents as cmp_excess_cents,
       cmp.collectible_cents as cmp_collectible_cents,
       cmp.matches as cmp_matches
from invoices i
left join tenant_settings ts on ts.tenant_id = i.tenant_id
left join lateral (
  select x.nominal_cents, x.fee_cents, x.discount_cents, x.received_cents,
         x.legacy_nominal_cents, x.legacy_fee_cents, x.legacy_discount_cents, x.legacy_received_cents,
         x.status, x.legacy_status,
         greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as residual_cents,
         greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as excess_cents,
         case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as collectible_cents,
         (x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true as matches
  from (
    select m.last_status as status, i.status as legacy_status,
           m.nominal_cents, m.fee_cents, m.discount_cents,
           coalesce(pay.signed_cents, 0)::bigint as received_cents,
           i.amount_cents::bigint as legacy_nominal_cents,
           i.fee_cents::bigint as legacy_fee_cents,
           i.discount_cents::bigint as legacy_discount_cents,
           coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents
    from (select 1) as anchor
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
where i.id = $1;
