-- name: Group9fb1f09c1 :many
select v.id, v.created_at, v.answered_at, v.score, v.comment, w.number as work_order_number, w.kind, s.name as subscriber_name, u.name as assignee_name,
                case when v.answered_at is not null then 'answered' when v.expires_at <= now() then 'expired' else 'pending' end as status
         from satisfaction_surveys v join work_orders w on w.id = v.work_order_id join subscribers s on s.id = v.subscriber_id left join users u on u.id = w.assignee_id
         where ($1::text is null or (case when v.answered_at is not null then 'answered' when v.expires_at <= now() then 'expired' else 'pending' end) = $1)
         order by coalesce(v.answered_at, v.created_at) desc, v.id;
