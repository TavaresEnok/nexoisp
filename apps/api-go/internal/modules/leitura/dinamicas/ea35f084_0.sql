select p.id as policy_id, p.name, p.applies_to, count(*)::int as total,
                count(*) filter (where x.done_at is not null and x.done_at <= x.sla_due_at)::int as within,
                count(*) filter (where (x.done_at is not null and x.done_at > x.sla_due_at) or (x.done_at is null and x.sla_due_at < now()))::int as breached,
                count(*) filter (where x.done_at is null and x.sla_due_at >= now())::int as open_ok,
                coalesce(round(avg(extract(epoch from x.done_at - x.created_at) / 60) filter (where x.done_at is not null)), 0)::int as avg_minutes
         from (select id, tenant_id, created_at, sla_policy_id, sla_due_at, closed_at as done_at from tickets
               union all select id, tenant_id, created_at, sla_policy_id, sla_due_at, case when status = 'done' then finished_at end from work_orders where status <> 'canceled') x
         join sla_policies p on p.id = x.sla_policy_id
         where x.created_at >= coalesce($1::date::timestamp at time zone $3, '-infinity') and x.created_at < coalesce(($2::date + 1)::timestamp at time zone $3, 'infinity') group by p.id, p.name, p.applies_to order by p.applies_to, p.name