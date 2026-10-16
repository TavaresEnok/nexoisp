with cand as (
       select k.tenant_id, k.id as contract_id, k.subscriber_id, k.due_day, pl.name as plan_name, pv.price_cents,
              contract_base_cents(k.id, $2::date, $3::boolean) as base,
              coalesce((select sum(a.unit_price_cents * a.quantity) from contract_addons a
                        where a.contract_id = k.id and a.from_competence <= $2::date and (a.ended_competence is null or $2::date < a.ended_competence)), 0)::int as addons
       from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
       where k.tenant_id = $1 and k.status = 'active' and k.start_date < ($2::date + interval '1 month')
         and not exists (select 1 from invoices i where i.tenant_id = k.tenant_id and i.contract_id = k.id and i.competence = $2::date and i.kind = 'monthly')),
     priced as (select cand.*, contract_discount_cents(contract_id, $2::date, base) as disc from cand),
     ins as (
       insert into invoices (tenant_id, contract_id, subscriber_id, kind, competence, due_date, amount_cents)
       select tenant_id, contract_id, subscriber_id, 'monthly', $2::date, $2::date + (due_day - 1), base - disc + addons from priced where base - disc + addons > 0
       on conflict (tenant_id, contract_id, competence, kind) where competence is not null do nothing
       returning id, contract_id),
     items as (
       insert into invoice_items (tenant_id, invoice_id, description, amount_cents)
       select $1, ins.id, 'Mensalidade ' || p.plan_name || ' — ' || to_char($2::date, 'MM/YYYY')
                          || case when p.base < p.price_cents then ' (proporcional ao período de uso)' else '' end, p.base
       from ins join priced p on p.contract_id = ins.contract_id where p.base > 0
       union all
       select $1, ins.id, 'Desconto: ' || coalesce((select string_agg(d.reason, '; ') from contract_discounts d
                                                      where d.contract_id = ins.contract_id and d.canceled_at is null and d.from_competence <= $2::date
                                                        and (d.months is null or $2::date < (d.from_competence + make_interval(months => d.months))::date)), 'promocional'), -p.disc
       from ins join priced p on p.contract_id = ins.contract_id where p.disc > 0
       union all
       select $1, ins.id, a.description || case when a.quantity > 1 then ' (x' || a.quantity || ')' else '' end || ' — ' || to_char($2::date, 'MM/YYYY'), a.unit_price_cents * a.quantity
       from ins join contract_addons a on a.contract_id = ins.contract_id
       where a.from_competence <= $2::date and (a.ended_competence is null or $2::date < a.ended_competence) and a.unit_price_cents * a.quantity > 0
       returning 1)
     select (select count(*) from ins)::int as n, (select count(*) from items)::int as items