update tickets set assignee_id = case when $2 then $3 else assignee_id end, priority = coalesce($4, priority), category = coalesce($5, category),
           type_id = case when $6 then $7 else type_id end, classification_id = case when $8 then $9 else classification_id end,
           root_cause_id = case when $10 then $11 else root_cause_id end, updated_at = now() where id = $1 returning *