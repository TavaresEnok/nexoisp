-- name: Read954ec190 :many

    select x.id, x.pool_id, x.prefix, x.contract_id, x.created_at, p.name as pool_name, s.id as subscriber_id, s.name as subscriber_name
    from ip6_delegations x join ip_pools p on p.id = x.pool_id join contracts k on k.id = x.contract_id join subscribers s on s.id = k.subscriber_id where x.contract_id = $1;
