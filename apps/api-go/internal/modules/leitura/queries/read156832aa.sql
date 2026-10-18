-- name: Read156832aa :many
select s.id, s.kind, s.effective_date, s.status, s.error, s.note, s.penalty, s.created_at, s.applied_at, p.name as plan_name, s.due_day, u.name as created_by_name
         from scheduled_changes s left join plans p on p.id = s.plan_id left join users u on u.id = s.created_by
         where s.contract_id = $1 order by s.effective_date desc, s.created_at desc limit 50;
