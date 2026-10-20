select coalesce(sum(qty),0)::int as b from stock_movements where item_id = $1 and warehouse_id is null
