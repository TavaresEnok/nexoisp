select exists(select 1 from material_intents where intention_id = $1 and author_id = $2 and work_order_id = $3 and item_id = $4 and qty = $5)
