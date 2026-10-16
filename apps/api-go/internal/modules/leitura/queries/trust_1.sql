-- name: Trust1 :many
select k.status, r.desired_policy from contracts k left join service_resources r on r.contract_id = k.id and r.desired_version > 0 where k.id = $1;
