update contract_addons set ended_competence = coalesce($3::date, (date_trunc('month', now()) + interval '1 month')::date)
         where id = $1 and contract_id = $2 and ended_competence is null and coalesce($3::date, (date_trunc('month', now()) + interval '1 month')::date) >= from_competence
         returning id, description