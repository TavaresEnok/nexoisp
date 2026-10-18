-- name: Readf5cf84a9 :many
select a.id, a.product_id, a.description, a.quantity, a.unit_price_cents, to_char(a.from_competence, 'YYYY-MM') as from_competence,
                to_char(a.ended_competence, 'YYYY-MM') as ended_competence,
                (a.ended_competence is null or a.ended_competence > date_trunc('month', now())::date) as current
         from contract_addons a where a.contract_id = $1 order by a.from_competence desc, a.created_at desc;
