update work_order_checklist set done = $3, done_by = case when $3 then $4::uuid end, done_at = case when $3 then now() end
         where id = $1 and work_order_id = $2 returning label