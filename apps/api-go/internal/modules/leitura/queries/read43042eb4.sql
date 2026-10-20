-- name: Read43042eb4 :many
select m.id, m.qty, m.kind, m.note, m.created_at, m.work_order_id, w.number as work_order_number, u.name as created_by_name,
                m.warehouse_id, coalesce(h.name, 'Depósito principal') as warehouse_name, p.number as purchase_order_number
         from stock_movements m left join work_orders w on w.id = m.work_order_id left join users u on u.id = m.created_by
         left join stock_warehouses h on h.id = m.warehouse_id left join purchase_orders p on p.id = m.purchase_order_id
         where m.item_id = $1 order by m.id desc limit 200;
