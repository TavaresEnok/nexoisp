select assignee_id, status from work_orders where id = $1 for update
