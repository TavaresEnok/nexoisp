select i.id as invoice_id, i.due_date::text as due, k.id as contract_id, s.id as subscriber_id, s.name, pl.name as plan_name,
                i.amount_cents + i.fee_cents - i.discount_cents - coalesce((select sum(p.signed_cents) from payments p where p.invoice_id = i.id), 0) as due_cents
         from invoices i join contracts k on k.id = i.contract_id join subscribers s on s.id = k.subscriber_id
         join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         where i.status = 'open' and k.status = 'active' and s.status = 'active'
           and ((now() at time zone $1)::date - i.due_date) = $2
           and ($3::uuid is null or pl.id = $3) and ($4::uuid is null or k.pop_id = $4)
           and ($5::uuid is null or exists (select 1 from contract_tags x where x.contract_id = k.id and x.tag_id = $5))
           and not exists (select 1 from notice_log l where l.rule_id = $6 and l.invoice_id = i.id
                           and (l.status in ('sent','skipped_no_consent','skipped_settled','queued','sending','uncertain') or l.attempts >= $7))
           and not exists (select 1 from notice_log l where l.subscriber_id = s.id
                           and (l.status in ('queued','sending') or (l.status = 'sent' and l.created_at > now() - make_interval(days => $8::int))))
         order by i.due_date limit 500
