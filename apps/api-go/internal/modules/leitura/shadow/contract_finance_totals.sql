-- Variante de shadow dos totais do contrato. A sentença legada abaixo entra
-- inteira. A comparação mora na mesma sentença: a seleção contract_id=$1
-- acontece antes das somas, e cada lateral só agrega a fatura já escolhida.
select
  leg.open,
  leg.overdue,
  leg.reconciling,
  leg.nominal_open_cents,
  leg.received_open_cents,
  leg.received_cents,
  leg.open_cents,
  leg.overdue_cents,
  (
    cmp.cmp_rows_match
    and leg.open = cmp.cmp_open_count
    and leg.overdue = cmp.cmp_overdue_count
    and leg.reconciling = cmp.cmp_reconciling_count
    and leg.nominal_open_cents = cmp.cmp_nominal_open_cents
    and leg.received_open_cents = cmp.cmp_received_open_cents
    and leg.received_cents = cmp.cmp_received_cents
    and leg.open_cents = cmp.cmp_open_residual_cents
    and leg.overdue_cents = cmp.cmp_overdue_residual_cents
    and leg.open_cents = cmp.cmp_open_collectible_cents
    and leg.overdue_cents = cmp.cmp_overdue_collectible_cents
  ) is true as cmp_matches,
  cmp.cmp_open_count,
  cmp.cmp_overdue_count,
  cmp.cmp_reconciling_count,
  cmp.cmp_nominal_open_cents,
  cmp.cmp_received_open_cents,
  cmp.cmp_received_cents,
  cmp.cmp_open_residual_cents,
  cmp.cmp_overdue_residual_cents,
  cmp.cmp_open_excess_cents,
  cmp.cmp_open_collectible_cents,
  cmp.cmp_overdue_collectible_cents,
  cmp.cmp_reconciling_collectible_cents
from (
select
          count(*) filter (where status='open') as open,
          count(*) filter (where status='open' and due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date) as overdue,
          count(*) filter (where status='reconciling') as reconciling,
          coalesce(sum(amount_cents) filter (where status='open'),0)::bigint as nominal_open_cents,
          coalesce(sum(paid_cents) filter (where status='open'),0)::bigint as received_open_cents,
          coalesce(sum(paid_cents),0)::bigint as received_cents,
          coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where status='open'),0)::bigint as open_cents,
          coalesce(sum(greatest(0,amount_cents+fee_cents-discount_cents-paid_cents)) filter (where status='open' and due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date),0)::bigint as overdue_cents
          from (select i.*, (select coalesce(sum(p.signed_cents),0) from payments p where p.invoice_id=i.id) as paid_cents
                from invoices i where i.contract_id=$1) x
) leg
cross join lateral (
  select
    coalesce(bool_and(src.matches), true) as cmp_rows_match,
    count(*) filter (where src.legacy_status = 'open') as cmp_open_count,
    count(*) filter (where src.legacy_status = 'open' and src.due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date) as cmp_overdue_count,
    count(*) filter (where src.legacy_status = 'reconciling') as cmp_reconciling_count,
    coalesce(sum(src.nominal_cents) filter (where src.legacy_status = 'open'), 0)::bigint as cmp_nominal_open_cents,
    coalesce(sum(src.received_cents) filter (where src.legacy_status = 'open'), 0)::bigint as cmp_received_open_cents,
    coalesce(sum(src.received_cents), 0)::bigint as cmp_received_cents,
    coalesce(sum(src.residual_cents) filter (where src.legacy_status = 'open'), 0)::bigint as cmp_open_residual_cents,
    coalesce(sum(src.residual_cents) filter (where src.legacy_status = 'open' and src.due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date), 0)::bigint as cmp_overdue_residual_cents,
    coalesce(sum(src.excess_cents) filter (where src.legacy_status = 'open'), 0)::bigint as cmp_open_excess_cents,
    coalesce(sum(src.collectible_cents) filter (where src.legacy_status = 'open'), 0)::bigint as cmp_open_collectible_cents,
    coalesce(sum(src.collectible_cents) filter (where src.legacy_status = 'open' and src.due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'America/Sao_Paulo'))::date), 0)::bigint as cmp_overdue_collectible_cents,
    coalesce(sum(src.collectible_cents) filter (where src.legacy_status = 'reconciling'), 0)::bigint as cmp_reconciling_collectible_cents
  from (
    select x.due_date, x.status, x.legacy_status,
           x.nominal_cents, x.fee_cents, x.discount_cents, x.received_cents,
           x.legacy_nominal_cents, x.legacy_fee_cents, x.legacy_discount_cents, x.legacy_received_cents,
           greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as residual_cents,
           greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as excess_cents,
           case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as collectible_cents,
           (x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true as matches
    from (
      select i.id as invoice_id, i.tenant_id, i.company_id, i.contract_id, i.due_date,
             m.last_status as status, i.status as legacy_status,
             m.nominal_cents, m.fee_cents, m.discount_cents,
             coalesce(pay.signed_cents, 0)::bigint as received_cents,
             i.amount_cents::bigint as legacy_nominal_cents,
             i.fee_cents::bigint as legacy_fee_cents,
             i.discount_cents::bigint as legacy_discount_cents,
             coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents
      from invoices i
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
      where i.contract_id=$1
    ) x
  ) src
) cmp
