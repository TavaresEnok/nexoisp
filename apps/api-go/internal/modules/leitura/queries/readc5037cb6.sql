-- name: Readc5037cb6 :many
select n.id, n.body, n.alert, n.contract_id, n.type_id, t.name as type_name, n.created_at, n.archived_at, u.name as created_by_name
         from subscriber_notes n left join catalog_items t on t.id = n.type_id left join users u on u.id = n.created_by
         where n.subscriber_id = $1 and ($2::boolean or n.archived_at is null) order by n.alert desc, n.created_at desc limit 200;
