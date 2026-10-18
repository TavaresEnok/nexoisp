select k.status, k.loyalty_until, k.penalty_model, k.penalty_cents,
            greatest(0, (extract(year from age(k.loyalty_until, $2::date)) * 12 + extract(month from age(k.loyalty_until, $2::date))
                         + case when extract(day from age(k.loyalty_until, $2::date)) > 0 then 1 else 0 end))::int as remaining_months,
            (k.loyalty_until is not null and k.loyalty_until > $2::date) as within_loyalty,
            (select coalesce(sum(i.amount_cents), 0)::int from invoices i where i.contract_id = k.id and i.status = 'open') as open_cents,
            (select count(*)::int from invoices i where i.contract_id = k.id and i.status = 'open') as open_count
     from contracts k where k.id = $1