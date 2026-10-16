with base as (
           select i.amount_cents + i.fee_cents - i.discount_cents - coalesce((select sum(p.signed_cents) from payments p where p.invoice_id = i.id), 0) as due_cents,
                  ($4::date - i.due_date) as late
           from invoices i join contracts k on k.id = i.contract_id join plan_versions pv on pv.id = k.plan_version_id
           where i.status = 'open' and ($1::uuid is null or pv.plan_id = $1) and ($2::uuid is null or k.pop_id = $2)
             and ($3::uuid is null or exists (select 1 from contract_tags x where x.contract_id = k.id and x.tag_id = $3)))
         select faixa, ordem, count(*)::int as faturas, coalesce(sum(due_cents),0)::bigint::float as cents from (
           select case when late <= 0 then 'A vencer' when late <= 30 then '1 a 30 dias' when late <= 60 then '31 a 60 dias'
                       when late <= 90 then '61 a 90 dias' else 'Mais de 90 dias' end as faixa,
                  case when late <= 0 then 1 when late <= 30 then 2 when late <= 60 then 3 when late <= 90 then 4 else 5 end as ordem, due_cents from base) x
         group by faixa, ordem order by ordem