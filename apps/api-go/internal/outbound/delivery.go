package outbound

import (
	"context"
	"errors"
	"fmt"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"time"
)

func tenants(ctx context.Context, database *db.DB, only string) ([]string, error) {
	if only != "" {
		return []string{only}, nil
	}
	ids := []string{}
	err := database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, "select tenant_id from worker_tenants()")
		if err != nil {
			return err
		}
		for _, r := range rows {
			ids = append(ids, r.Get("tenant_id").(string))
		}
		return nil
	})
	return ids, err
}
func Notifications(ctx context.Context, database *db.DB, only string) (map[string]any, error) {
	ids, err := tenants(ctx, database, only)
	if err != nil {
		return nil, err
	}
	sent, failed := 0, 0
	for _, tenant := range ids {
		scope := tenancy.Scope{TenantID: tenant}
		var url string
		var due []jsonx.Object
		err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			rows, err := tx.Objects(ctx, "select notify_webhook_url from tenant_settings where tenant_id = $1", tenant)
			if err != nil {
				return err
			}
			if len(rows) > 0 && rows[0].Get("notify_webhook_url") != nil {
				url = rows[0].Get("notify_webhook_url").(string)
			}
			due, err = tx.Objects(ctx, `select id, payload, attempts from notifications where status = 'pending' and next_attempt_at <= now() order by id limit 20`)
			return err
		})
		if err != nil {
			return nil, err
		}
		for _, n := range due {
			var sendErr error
			if url == "" {
				sendErr = errors.New("webhook removido da configuração")
			} else {
				var status int
				status, sendErr = Post(ctx, url, n.Get("payload"), nil, 5*time.Second)
				if sendErr == nil && (status < 200 || status >= 300) {
					sendErr = fmt.Errorf("o destino respondeu %d", status)
				}
			}
			var message any
			status := "sent"
			if sendErr != nil {
				message = ErrorText(sendErr)
				status = "pending"
				if number(n.Get("attempts"))+1 >= 5 || url == "" {
					status = "failed"
				}
				failed++
			} else {
				sent++
			}
			err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
				return tx.Exec(ctx, `update notifications set attempts = attempts + 1, last_error = $2, status = $3, sent_at = case when $2::text is null then now() end,
                next_attempt_at = now() + (attempts + 1) * interval '2 minutes' where id = $1`, n.Get("id"), message, status)
			})
			if err != nil {
				return nil, err
			}
		}
	}
	return map[string]any{"sent": sent, "failed": failed}, nil
}
func Webhooks(ctx context.Context, database *db.DB, only string) (map[string]any, error) {
	ids, err := tenants(ctx, database, only)
	if err != nil {
		return nil, err
	}
	sent, failed := 0, 0
	backoff := []int{1, 5, 30, 120, 720}
	for _, tenant := range ids {
		scope := tenancy.Scope{TenantID: tenant}
		var due []jsonx.Object
		err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			var err error
			due, err = tx.Objects(ctx, `select d.id, d.event, d.payload, d.attempts, e.url, e.secret_enc, e.active
       from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
       where d.status = 'pending' and d.next_attempt_at <= now() order by d.id limit 20`)
			return err
		})
		if err != nil {
			return nil, err
		}
		for _, d := range due {
			var sendErr error
			var response any
			if d.Get("active") != true {
				sendErr = errors.New("endpoint desativado")
			} else {
				var secret string
				secret, sendErr = cryptox.DecryptSecret(d.Get("secret_enc").(string))
				if sendErr == nil {
					var code int
					code, sendErr = Webhook(ctx, d.Get("url").(string), secret, d.Get("id"), d.Get("event").(string), d.Get("payload"))
					if code != 0 {
						response = code
					}
					if sendErr == nil && (code < 200 || code >= 300) {
						sendErr = fmt.Errorf("o destino respondeu %d", code)
					}
				}
			}
			attempts := int(number(d.Get("attempts"))) + 1
			var message any
			status := "sent"
			if sendErr != nil {
				message = ErrorText(sendErr)
				status = "pending"
				if attempts >= 6 || d.Get("active") != true {
					status = "failed"
				}
				failed++
			} else {
				sent++
			}
			err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
				return tx.Exec(ctx, `update webhook_deliveries set attempts = $2, last_error = $3, response_status = $4, status = $5,
                sent_at = case when $3::text is null then now() end, next_attempt_at = now() + make_interval(mins => $6::int) where id = $1`, d.Get("id"), attempts, message, response, status, backoff[min(attempts-1, len(backoff)-1)])
			})
			if err != nil {
				return nil, err
			}
		}
		err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := tx.Exec(ctx, `delete from api_rate where bucket < now() - interval '2 hours'`); err != nil {
				return err
			}
			return tx.Exec(ctx, `delete from api_idempotency where created_at < now() - interval '24 hours'`)
		})
		if err != nil {
			return nil, err
		}
	}
	return map[string]any{"sent": sent, "failed": failed}, nil
}
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}
