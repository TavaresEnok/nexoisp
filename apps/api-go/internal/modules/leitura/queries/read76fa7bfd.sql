-- name: Read76fa7bfd :many

  select p.*, family(p.cidr) as family, masklen(p.cidr) as masklen, d.name as device_name,
         case when family(p.cidr) = 4 then (2 ^ (32 - masklen(p.cidr)))::bigint end as size,
         (select count(*) from ip_allocations a where a.pool_id = p.id) + (select count(*) from ip6_delegations x where x.pool_id = p.id) as allocated,
         (select g.id from cgnat_plans g where g.retired_at is null and (g.private_pool_id = p.id or g.public_pool_id = p.id) limit 1) as cgnat_plan_id
  from ip_pools p left join devices d on d.id = p.device_id order by p.kind, p.cidr;
