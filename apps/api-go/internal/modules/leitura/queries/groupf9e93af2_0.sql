-- name: Groupf9e93af20 :many
select k.status, k.start_date, k.end_date, k.end_note, k.credit_restricted_at, e.name as end_reason,
                r.id as resource_id, r.desired_version, r.desired_policy, r.desired_stage, r.desired_reason, r.desired_at,
                r.observed_version, r.observed_policy,
                (select o.authorization_ref->>'type' from operations o where o.resource_id = r.id and o.action <> 'subscriber.disconnect'
                  order by o.created_at desc limit 1) as by_type
         from contracts k left join catalog_items e on e.id = k.end_reason_id
         left join service_resources r on r.contract_id = k.id and r.desired_version > 0
         where k.id = $1;
