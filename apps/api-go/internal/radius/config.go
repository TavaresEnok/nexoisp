// Package radius manages the integrated executor using the shared network queue.
package radius

import (
	"context"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"os"
	"regexp"
)

func Key() (string, error) {
	key := os.Getenv("NEXO_RADIUS_KEY")
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{24,}$`).MatchString(key) {
		return "", &apierr.Error{Status: 503, Message: "o RADIUS integrado não está configurado neste servidor (NEXO_RADIUS_KEY ausente ou curta)", Code: "radius_unconfigured"}
	}
	return key, nil
}
func EnsureAgent(ctx context.Context, tx *db.Tx, tenant string) (string, error) {
	rows, err := tx.Objects(ctx, "select id from agents where tenant_id = $1 and internal", tenant)
	if err != nil {
		return "", err
	}
	if len(rows) > 0 {
		return rows[0].Get("id").(string), nil
	}
	random, err := cryptox.RandomToken(32)
	if err != nil {
		return "", err
	}
	rows, err = tx.Objects(ctx, `insert into agents (tenant_id, name, token_hash, version, internal, last_seen_at, sync_session_id, last_sync_at)
     values ($1,$2,$3,$4,true,now(),'interno',now()) returning id`, tenant, "RADIUS integrado", cryptox.SHA256(random), "99.0.0")
	if err != nil {
		return "", err
	}
	return rows[0].Get("id").(string), nil
}
