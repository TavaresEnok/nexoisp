-- name: Readce941923 :many
select a.id, a.contract_id, a.subscriber_id, a.amendment_id, a.title, a.status, a.body_hash, a.requested_at, a.accepted_at, a.accepted_ip,
              a.evidence_hash, a.canceled_at, u.name as requested_by_name from acceptances a left join users u on u.id = a.requested_by where a.contract_id = $1 order by a.requested_at desc;
