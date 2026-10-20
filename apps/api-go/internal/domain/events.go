// Package domain holds operations shared by HTTP handlers and background routines.
package domain

import (
	"context"
	"encoding/json"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"time"
)

func Emit(ctx context.Context, tx *db.Tx, tenant, event string, data map[string]any) error {
	raw, err := json.Marshal(map[string]any{"event": event, "created_at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "data": data})
	if err != nil {
		return err
	}
	return tx.Exec(ctx, `insert into webhook_deliveries (tenant_id, endpoint_id, event, payload)
     select $1, e.id, $2, $3 from webhook_endpoints e
     where e.tenant_id = $1 and e.active and $2 = any(e.events)
       and exists (select 1 from tenants t where t.id = $1 and 'api' = any(t.modules))`, tenant, event, raw)
}
func QueueNotice(ctx context.Context, tx *db.Tx, tenant, event, text string, data map[string]any) error {
	payload := map[string]any{"text": "NexoISP: " + text, "event": event}
	for k, v := range data {
		payload[k] = v
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return tx.Exec(ctx, `insert into notifications (tenant_id, event, payload) select $1, $2, $3 from tenant_settings where tenant_id = $1 and notify_webhook_url is not null`, tenant, event, raw)
}
func NextNumber(ctx context.Context, tx *db.Tx, tenant, key string) (any, error) {
	rows, err := tx.Objects(ctx, `insert into tenant_counters (tenant_id, key, value) values ($1,$2,1)
     on conflict (tenant_id, key) do update set value = tenant_counters.value + 1 returning value`, tenant, key)
	if err != nil {
		return nil, err
	}
	return rows[0].Get("value"), nil
}
func ApplySLA(ctx context.Context, tx *db.Tx, entity string, id any) (jsonx.Object, error) {
	table := "tickets"
	if entity == "work_order" {
		table = "work_orders"
	}
	rows, err := tx.Objects(ctx, "select * from "+table+" where id = $1", id)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	row := rows[0]
	var policies []jsonx.Object
	if entity == "ticket" {
		policies, err = tx.Objects(ctx, `select id, resolution_minutes, business_hours from sla_policies
         where active and applies_to = 'ticket' and (priority is null or priority = $1) and (type_id is null or type_id = $2)
         order by ((priority is not null)::int + (type_id is not null)::int) desc, resolution_minutes limit 1`, row.Get("priority"), row.Get("type_id"))
	} else {
		policies, err = tx.Objects(ctx, `select id, resolution_minutes, business_hours from sla_policies
         where active and applies_to = 'work_order' and (kind is null or kind = $1)
         order by (kind is not null)::int desc, resolution_minutes limit 1`, row.Get("kind"))
	}
	if err != nil {
		return nil, err
	}
	var policy jsonx.Object
	var policyID, minutes any
	business := false
	if len(policies) > 0 {
		policy = policies[0]
		policyID, minutes = policy.Get("id"), policy.Get("resolution_minutes")
		business = policy.Get("business_hours") == true
	}
	// Políticas de expediente contam só minutos úteis do calendário do provedor (sla_due).
	err = tx.Exec(ctx, `update `+table+` set sla_policy_id = $2, sla_due_at = case when $2::uuid is null then null else sla_due(tenant_id, created_at, $3::int, $4) end, sla_breached_at = null where id = $1`, id, policyID, minutes, business)
	return policy, err
}
