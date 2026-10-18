update work_orders set status = $2, resolution = coalesce($3, resolution), finished_at = case when $4 then now() end,
                en_route_at = case when $2 = 'en_route' then now() else en_route_at end,
                started_at = case when $2 = 'in_progress' then coalesce(started_at, now()) else started_at end,
                awaiting_reason = case when $2 = 'awaiting_schedule' then $5 else null end,
                scheduled_for = case when $2 = 'awaiting_schedule' then null else scheduled_for end,
                root_cause_id = coalesce($6, root_cause_id), updated_at = now() where id = $1 returning *