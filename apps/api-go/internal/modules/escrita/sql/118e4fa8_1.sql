with w as (
           select w.id, w.assignee_id,
                  coalesce((select r.assignee_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind = w.kind),
                           (select r.assignee_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind is null), 0) as a_cents,
                  coalesce((select r.helper_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind = w.kind),
                           (select r.helper_cents from commission_rules r where r.active and r.subject = 'work_order' and r.os_kind is null), 0) as h_cents
           from work_orders w where w.status = 'done' and w.finished_at >= $1::date::timestamp at time zone $3 and w.finished_at < ($2::date + 1)::timestamp at time zone $3)
         select u.id as user_id, u.name, 'assignee' as role, count(*)::int as n, sum(w.a_cents)::int as cents
           from w join users u on u.id = w.assignee_id group by u.id, u.name
         union all
         select u.id, u.name, 'helper', count(*)::int, sum(w.h_cents)::int
           from w join work_order_helpers h on h.work_order_id = w.id join users u on u.id = h.user_id group by u.id, u.name