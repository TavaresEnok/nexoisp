-- name: BalanceShadowCompare :many
-- Fórmula da view financial_balance_shadow (migração 66), restrita aos invoice_id
-- já escolhidos. As somas ficam em laterais correlacionadas: o agregado não varre
-- o histórico do tenant antes do filtro. Movimento ausente deixa nominal/fee/
-- discount/status nulos (sem coalesce para zero). received e legacy_received
-- somam payments.signed_cents da fatura visível; financial_payment_allocations
-- é essa mesma projeção. Não lê a view.
select x.invoice_id, x.tenant_id, x.company_id, x.contract_id, x.status, x.legacy_status,
       x.nominal_cents, x.fee_cents, x.discount_cents, x.received_cents,
       x.legacy_nominal_cents, x.legacy_fee_cents, x.legacy_discount_cents, x.legacy_received_cents,
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
  where i.id = any($1::uuid[])
) x;
