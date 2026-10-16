-- name: Read0b9689ff :many
select t.id, t.name, (select count(*) from contract_tags x where x.tag_id = t.id)::int as contracts from tags t order by t.name;
