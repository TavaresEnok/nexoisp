-- name: Reade31004ef :many

  select a.id, a.pool_id, host(a.address) as address, a.contract_id, a.description, a.created_at, p.name as pool_name, p.kind as pool_kind,
         s.id as subscriber_id, s.name as subscriber_name, u.name as created_by_name
  from ip_allocations a join ip_pools p on p.id = a.pool_id
  left join contracts k on k.id = a.contract_id left join subscribers s on s.id = k.subscriber_id left join users u on u.id = a.created_by where a.contract_id = $1 order by a.address;
