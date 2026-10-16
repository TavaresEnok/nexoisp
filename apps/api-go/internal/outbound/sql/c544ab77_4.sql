update work_orders w set sla_breached_at = now()
       where w.tenant_id = $1 and w.status in ('open','analysis','awaiting_schedule','scheduled','en_route','in_progress') and w.sla_breached_at is null and w.sla_due_at is not null and w.sla_due_at < now()
       returning w.id, w.number, w.assignee_id, w.sla_policy_id