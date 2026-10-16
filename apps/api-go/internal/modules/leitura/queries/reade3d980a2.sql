-- name: Reade3d980a2 :many
select p.id, p.name, p.city, p.state, p.active,
                count(k.id) filter (where k.status = 'active')::int as active_contracts, count(k.id) filter (where k.status = 'ended')::int as ended_contracts,
                count(k.id) filter (where k.status = 'active' and r.desired_policy = 'suspended')::int as suspended_contracts
         from pops p left join contracts k on k.pop_id = p.id left join service_resources r on r.contract_id = k.id and r.desired_version > 0
         group by p.id order by p.name;
