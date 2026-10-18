-- name: Read6caaa707 :many
select p.*, u.name as escalate_to_name, t.name as type_name,
                (select count(*) from tickets x where x.sla_policy_id = p.id)::int + (select count(*) from work_orders x where x.sla_policy_id = p.id)::int as in_use
         from sla_policies p left join users u on u.id = p.escalate_to left join catalog_items t on t.id = p.type_id order by p.applies_to, p.name;
