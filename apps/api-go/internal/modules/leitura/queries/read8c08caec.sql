-- name: Read8c08caec :many

    select u.*, i.name as item_name, h.name as holder_name, s.name as subscriber_name, w.number as work_order_number
    from stock_units u join stock_items i on i.id = u.item_id left join users h on h.id = u.holder_id
    left join contracts k on k.id = u.contract_id left join subscribers s on s.id = k.subscriber_id left join work_orders w on w.id = u.work_order_id where ($1::text is null or u.serial ilike '%'||$1||'%') and ($2::uuid is null or u.holder_id = $2) and ($3::uuid is null or u.contract_id = $3)
                      order by u.updated_at desc limit 200;
