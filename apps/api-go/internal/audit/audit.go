package audit

import (
	"context"
	"encoding/json"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
)

type Writer struct{ DB *db.DB }

func (w Writer) Write(ctx context.Context, c *auth.Ctx, action, entity string, id any, detail map[string]any, result string) error {
	return w.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error { return InTx(ctx, tx, c, action, entity, id, detail, result) })
}

// InTx records successful business changes in the transaction that changed them.
func InTx(ctx context.Context, tx *db.Tx, c *auth.Ctx, action, entity string, id any, detail map[string]any, result string) error {
	data := map[string]any{}
	for key, value := range detail {
		data[key] = value
	}
	if c.Support {
		data["support_access"] = true
	}
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	var tenant any
	if c.TenantID != "" {
		tenant = c.TenantID
	}
	return tx.Exec(ctx, `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`, tenant, "user", c.UserID, action, nullEntity(entity), id, result, b)
}

func nullEntity(entity string) any {
	if entity == "" {
		return nil
	}
	return entity
}
