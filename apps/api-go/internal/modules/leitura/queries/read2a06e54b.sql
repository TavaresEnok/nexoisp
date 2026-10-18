-- name: Read2a06e54b :many
select d.id, d.kind, d.value, d.reason, d.from_competence, d.months, d.created_at, d.canceled_at, u.name as created_by_name,
                (d.canceled_at is null and (d.months is null or current_date < (d.from_competence + make_interval(months => d.months))::date)) as current
         from contract_discounts d left join users u on u.id = d.created_by where d.contract_id = $1 order by d.created_at desc;
