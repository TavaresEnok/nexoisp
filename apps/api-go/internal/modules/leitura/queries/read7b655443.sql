-- name: Read7b655443 :many
select d.id, d.kind, d.name, d.mime, d.size_bytes, d.contract_id, d.created_at, d.deleted_at, u.name as created_by_name
         from documents d left join users u on u.id = d.created_by where d.subscriber_id = $1 and d.deleted_at is null and d.work_order_id is null order by d.created_at desc;
