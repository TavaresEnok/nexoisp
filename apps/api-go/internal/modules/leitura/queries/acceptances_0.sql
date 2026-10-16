-- name: Acceptances0 :many
select a.id, a.contract_id, a.title, a.body, a.status, a.requested_at, a.accepted_at
         from acceptances a where a.status <> 'canceled' order by (a.status = 'pending') desc, a.requested_at desc limit 50;
