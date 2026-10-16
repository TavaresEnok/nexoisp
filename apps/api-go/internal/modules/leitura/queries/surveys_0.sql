-- name: Surveys0 :many
select v.id, v.created_at, v.expires_at, v.work_order_number, v.kind
         from satisfaction_surveys v
         where v.subscriber_id = $1 and v.answered_at is null and v.expires_at > now() order by v.created_at desc;
