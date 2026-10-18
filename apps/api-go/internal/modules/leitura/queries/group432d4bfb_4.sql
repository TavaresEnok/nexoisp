-- name: Group432d4bfb4 :many
select m.id, m.item_id, i.name as item_name, i.unit, -m.qty as qty, m.created_at, u.name as created_by_name
         from stock_movements m join stock_items i on i.id = m.item_id left join users u on u.id = m.created_by where m.work_order_id = $1 order by m.id;
