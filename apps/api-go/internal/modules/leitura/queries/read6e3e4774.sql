-- name: Read6e3e4774 :many
select d.id, d.name, d.document, d.is_default, d.active,
                (select count(*)::int from contracts k where k.company_id = d.id) as contracts
         from companies d order by d.is_default desc, d.name;
