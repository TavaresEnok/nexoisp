package audit

import (
	"context"
	"encoding/json"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
)

type Writer struct{ DB *db.DB }

func (w Writer) Write(ctx context.Context, c *auth.Ctx, action, entity string, id any, detail map[string]any, result string) error {
	if c.Support {
		detail["support_access"] = true
	}
	b, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	var tenant any
	if c.TenantID != "" {
		tenant = c.TenantID
	}
	return w.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`, tenant, "user", c.UserID, action, entity, id, result, b)
	})
}
