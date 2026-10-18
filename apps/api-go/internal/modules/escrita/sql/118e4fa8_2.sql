select u.id as user_id, u.name, 'sale' as role, count(*)::int as n,
                (count(*) * coalesce((select r.assignee_cents from commission_rules r where r.active and r.subject = 'sale'), 0))::int as cents
         from leads l join users u on u.id = l.owner_id
         where l.stage = 'won' and l.updated_at >= $1::date::timestamp at time zone $3 and l.updated_at < ($2::date + 1)::timestamp at time zone $3 group by u.id, u.name