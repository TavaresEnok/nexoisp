-- name: Read5489df5a :many
select a.id, a.kind, a.title, a.body, a.effective_date, a.created_at, u.name as created_by_name
         from contract_amendments a left join users u on u.id = a.created_by where a.contract_id = $1 order by a.effective_date desc, a.created_at desc;
