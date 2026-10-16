package escrita

import (
	"context"
	"net"
	"os"
	"strings"
	"time"
	"unicode/utf16"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/outbound"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
)

func (s Service) accessOperations(ops map[string]operation) {
	f, o, str, n := validate.F, validate.Object, validate.String, validate.Number
	scopes := []string{"subscribers:read", "contracts:read", "invoices:read", "tickets:write", "work_orders:read", "work_orders:write"}
	ops["POST /api/notifications/deliver"] = operation{nil, nil}
	ops["POST /api/webhook-deliveries/:id/retry"] = operation{nil, nil}
	ops["POST /api/api-tokens"] = operation{s.apiToken, obj(o(f("name", str().Trimmed().Min(2).Max(60)), f("scopes", validate.Array(validate.Enum(scopes...)).Min(1).Max(float64(len(scopes)))), f("rate_limit_per_min", n().Int().Min(10).Max(6000).Def(float64(120))), f("expires_in_days", n().Int().Min(1).Max(730).Nullish())))}
	ops["DELETE /api/api-tokens/:id"] = operation{s.revokeToken, nil}
	ops["POST /api/webhook-endpoints/:id/rotate-secret"] = operation{s.rotateWebhook, nil}
	ops["DELETE /api/webhook-endpoints/:id"] = operation{s.deleteWebhook, nil}
	ops["POST /api/subscribers/:id/portal-access"] = operation{s.portalAccess, obj(o(f("email", str().Refine(func(v any) bool { return validEmail(v.(string)) }, "Invalid email")), f("password", str().Min(8, "senha deve ter ao menos 8 caracteres").Max(200))))}
	ops["POST /api/contracts/:id/acceptances"] = operation{s.requestAcceptance, obj(o(f("amendment_id", str().UUID().Opt()), f("title", str().Trimmed().Min(3).Max(120).Opt()), f("body", str().Trimmed().Min(1).Max(8000).Opt())))}
	ops["POST /api/acceptances/:id/cancel"] = operation{s.cancelAcceptance, nil}
	ops["POST /api/portal/acceptances/:id/accept"] = operation{nil, obj(o(f("agree", validate.LiteralMessage(true, "confirme que leu e concorda com o texto"))))}
}
func (s Service) apiToken(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	random, err := cryptox.RandomToken(32)
	if err != nil {
		return nil, err
	}
	token := "nxk_" + random
	c := auth.From(ctx)
	scopes := unique(b["scopes"].([]any))
	row, err := one(ctx, tx, "POST /api/api-tokens", 0, c.TenantID, b["name"], cryptox.SHA256(token), token[:12], scopes, b["rate_limit_per_min"], b["expires_in_days"], c.UserID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "já existe um token com este nome")
	}
	if err = record(ctx, tx, "api_token.create", "api_token", row.Get("id"), map[string]any{"name": b["name"], "scopes": row.Get("scopes"), "rate_limit_per_min": b["rate_limit_per_min"]}); err != nil {
		return nil, err
	}
	row.Set("token", token)
	return row, nil
}
func (s Service) revokeToken(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	if _, err := mustRow(ctx, tx, "DELETE /api/api-tokens/:id", 0, "token não encontrado", id); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "api_token.revoke", "api_token", id, nil)
}
func (s Service) rotateWebhook(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	token, err := cryptox.RandomToken(24)
	if err != nil {
		return nil, err
	}
	secret := "whsec_" + token
	encrypted, err := cryptox.EncryptSecret(secret)
	if err != nil {
		return nil, err
	}
	n, err := tx.Affected(ctx, query("POST /api/webhook-endpoints/:id/rotate-secret", 0), id, encrypted)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, "endpoint não encontrado")
	}
	return map[string]any{"secret": secret}, record(ctx, tx, "webhook.rotate_secret", "webhook_endpoint", id, nil)
}
func (s Service) deleteWebhook(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	n, err := tx.Affected(ctx, query("DELETE /api/webhook-endpoints/:id", 0), id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, "endpoint não encontrado")
	}
	return map[string]any{"ok": true}, record(ctx, tx, "webhook.delete", "webhook_endpoint", id, nil)
}
func (s Service) portalAccess(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/subscribers/:id/portal-access"
	sub, err := mustRow(ctx, tx, key, 0, "assinante não encontrado", id)
	if err != nil {
		return nil, err
	}
	hash, err := cryptox.HashPassword(b["password"].(string))
	if err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 1, auth.From(ctx).TenantID, b["email"], sub.Get("name"), hash, id)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "subscriber.portal_access", "subscriber", id, map[string]any{"email": b["email"]})
}
func (s Service) requestAcceptance(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/acceptances"
	contract, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	title, body := b["title"], b["body"]
	if b["amendment_id"] != nil {
		am, err := one(ctx, tx, key, 1, b["amendment_id"], id)
		if err != nil {
			return nil, err
		}
		if am == nil {
			return nil, apierr.New(400, "aditivo não encontrado neste contrato")
		}
		title, body = am.Get("title"), am.Get("body")
	}
	if title == nil || body == nil || title == "" || body == "" {
		return nil, apierr.New(400, "informe o título e o texto do documento (ou escolha um aditivo)")
	}
	portal, err := one(ctx, tx, key, 2, contract.Get("subscriber_id"))
	if err != nil {
		return nil, err
	}
	if portal == nil {
		return nil, apierr.New(409, "o assinante não tem acesso ao portal: crie o acesso antes de pedir o aceite")
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 3, c.TenantID, id, contract.Get("subscriber_id"), b["amendment_id"], title, body, cryptox.SHA256(body.(string)), c.UserID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "já existe um pedido pendente com este mesmo texto")
	}
	return map[string]any{"id": row.Get("id"), "status": "pending"}, record(ctx, tx, "acceptance.request", "contract", id, map[string]any{"acceptance_id": row.Get("id"), "title": title})
}
func (s Service) cancelAcceptance(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/acceptances/:id/cancel", 0, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "só um pedido pendente pode ser cancelado")
	}
	return map[string]any{"ok": true}, record(ctx, tx, "acceptance.cancel", "contract", row.Get("contract_id"), map[string]any{"acceptance_id": id})
}
func clientIP(ctx context.Context) string {
	r := httpx.Request(ctx)
	if os.Getenv("NEXO_TRUST_PROXY") == "1" {
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			return strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func (s Service) portalAccept(ctx context.Context, id string) (any, error) {
	const key = "POST /api/portal/acceptances/:id/accept"
	c := auth.From(ctx)
	if c.SubscriberID == "" || c.UserID == "" {
		return nil, apierr.New(403, "sessão sem assinante")
	}
	var own jsonx.Object
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error { var err error; own, err = one(ctx, tx, key, 0, id, c.SubscriberID); return err })
	if err != nil {
		return nil, err
	}
	if own == nil {
		return nil, apierr.New(404, "documento não encontrado")
	}
	if own.Get("status") != "pending" {
		message := "este pedido foi cancelado"
		if own.Get("status") == "accepted" {
			message = "documento já aceito"
		}
		return nil, apierr.New(409, message)
	}
	at := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	ip := clientIP(ctx)
	agent := utf16.Encode([]rune(httpx.Request(ctx).Header.Get("User-Agent")))
	if len(agent) > 300 {
		agent = agent[:300]
	}
	var ua any
	if len(agent) > 0 {
		ua = string(utf16.Decode(agent))
	}
	evidence, err := jsonx.Encode(jsonx.Object{{Name: "v", Value: 1}, {Name: "id", Value: own.Get("id")}, {Name: "contract", Value: own.Get("contract_id")}, {Name: "subscriber", Value: own.Get("subscriber_id")}, {Name: "body", Value: own.Get("body_hash")}, {Name: "user", Value: c.UserID}, {Name: "at", Value: at}, {Name: "ip", Value: ip}})
	if err != nil {
		return nil, err
	}
	hash := cryptox.SHA256(string(evidence))
	err = s.DB.WithScope(ctx, tenancy.Scope{TenantID: c.TenantID}, func(tx *db.Tx) error {
		row, err := one(ctx, tx, key, 1, id, at, c.UserID, ip, ua, hash)
		if err != nil {
			return err
		}
		if row == nil {
			return apierr.New(409, "documento já respondido")
		}
		return record(ctx, tx, "acceptance.accept", "contract", own.Get("contract_id"), map[string]any{"acceptance_id": id, "evidence_hash": hash})
	})
	return map[string]any{"id": id, "status": "accepted", "accepted_at": at, "evidence_hash": hash}, err
}

func (s Service) retryWebhook(ctx context.Context, id string) (any, error) {
	const key = "POST /api/webhook-deliveries/:id/retry"
	c := auth.From(ctx)
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		row, err := one(ctx, tx, key, 0, id)
		if err != nil {
			return err
		}
		if row == nil {
			return apierr.New(409, "só entregas que falharam podem ser reenviadas")
		}
		return record(ctx, tx, "webhook.retry", "webhook_delivery", id, nil)
	})
	if err != nil {
		return nil, err
	}
	return outbound.Webhooks(ctx, s.DB, c.TenantID)
}
