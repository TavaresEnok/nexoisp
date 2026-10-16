update tickets t set sla_breached_at = now()
       where t.tenant_id = $1 and t.status <> 'closed' and t.sla_breached_at is null and t.sla_due_at is not null and t.sla_due_at < now()
       returning t.id, t.number, t.subject, t.assignee_id, t.sla_policy_id