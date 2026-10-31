insert into material_intents (intention_id, tenant_id, author_id, work_order_id, item_id, qty, movement_id, receipt)
values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (intention_id) do nothing
