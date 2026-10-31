select r.id as resource_id, r.desired_policy, min(i.due_date) as due, (array_agg(i.id::text order by i.due_date, i.id))[1] as invoice_id,
              ((now() at time zone $2)::date - min(i.due_date))::int as days_late,
              pl.reduce_after_days, coalesce(pl.block_after_days, $1::int) as block_days
       from invoices i join service_resources r on r.contract_id = i.contract_id join contracts k on k.id = i.contract_id
       join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
       where i.status = 'open' and i.amount_cents::bigint + i.fee_cents - i.discount_cents > coalesce((select sum(p.signed_cents) from payments p where p.invoice_id=i.id),0)
         and i.due_date < (now() at time zone $2)::date and r.desired_version > 0 and k.status = 'active'
         and (r.desired_policy = 'active' or (r.desired_policy = 'suspended' and r.desired_stage = 'reduced'))
         and not exists (select 1 from trust_releases t where t.contract_id = i.contract_id and t.status = 'active' and t.expires_at > now())
         and ($3::uuid is null or i.contract_id = $3)
       group by r.id, pl.id
