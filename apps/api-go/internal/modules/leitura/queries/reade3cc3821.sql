-- name: Reade3cc3821 :many
select p.id, p.name, p.price_cents, p.active, (select count(*)::int from contract_addons a where a.product_id = p.id and a.ended_competence is null) as in_use
         from addon_products p order by p.active desc, p.name;
