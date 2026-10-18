package escrita

import (
	"context"
	"fmt"
	"net/url"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/outbound"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"time"
)

func integrationOutside(key string) bool {
	switch key {
	case "POST /api/notice-channels", "POST /api/notice-channels/:id/test", "PUT /api/notifications/settings", "POST /api/notifications/test", "POST /api/webhook-endpoints", "PATCH /api/webhook-endpoints/:id", "POST /api/webhook-endpoints/:id/test":
		return true
	}
	return false
}
func (s Service) integrationOperations(ops map[string]operation) {
	f, o, str := validate.F, validate.Object, validate.String
	endpointURL := str().Trimmed().Refine(func(v any) bool { u, err := url.Parse(v.(string)); return err == nil && u.Scheme != "" }, "Invalid url").Max(500)
	events := validate.Array(validate.Enum("invoice.paid", "ticket.created", "access.suspend_requested", "access.resume_requested", "access.suspended", "access.resumed", "access.change_failed", "work_order.created", "work_order.status_changed", "sla.breached", "survey.answered", "contract.changed")).Min(1).Max(12)
	ops["POST /api/notice-channels"] = operation{nil, obj(o(f("name", str().Trimmed().Min(2).Max(60)), f("url", endpointURL), f("phone_field", str().Pattern(`^[A-Za-z0-9_.-]{1,40}$`, "").Def("to")), f("message_field", str().Pattern(`^[A-Za-z0-9_.-]{1,40}$`, "").Def("message")), f("extra_body", validate.Record(validate.Union(str().Max(200), validate.Number(), validate.Boolean())).Def(map[string]any{})), f("headers", validate.Record(str().Max(500)).Def(map[string]any{}))))}
	ops["POST /api/notice-channels/:id/test"] = operation{nil, obj(o(f("phone", str().Trimmed().Min(8).Max(20)), f("message", str().Trimmed().Min(2).Max(160).Def("Teste de aviso do NexoISP."))))}
	ops["PUT /api/notifications/settings"] = operation{nil, obj(o(f("webhook_url", text(500).Null().Then(nilEmpty, false))))}
	ops["POST /api/notifications/test"] = operation{nil, nil}
	ops["POST /api/webhook-endpoints"] = operation{nil, obj(o(f("name", str().Trimmed().Min(2).Max(60)), f("url", endpointURL), f("events", events)))}
	ops["PATCH /api/webhook-endpoints/:id"] = operation{nil, obj(o(f("url", endpointURL.Opt()), f("events", events.Opt()), f("active", validate.Boolean().Opt())))}
	ops["POST /api/webhook-endpoints/:id/test"] = operation{nil, nil}
}
func (s Service) integration(ctx context.Context, key, id string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	scoped := func(fn func(*db.Tx) error) error { return s.DB.WithScope(ctx, c.Scope, fn) }
	if key == "PUT /api/notifications/settings" {
		if b["webhook_url"] != nil {
			if _, err := outbound.SafeURL(ctx, b["webhook_url"].(string)); err != nil {
				return nil, err
			}
		}
		err := scoped(func(tx *db.Tx) error {
			if err := tx.Exec(ctx, query(key, 0), c.TenantID, b["webhook_url"], c.UserID); err != nil {
				return err
			}
			return record(ctx, tx, "notifications.settings_update", "tenant_settings", c.TenantID, map[string]any{"configured": b["webhook_url"] != nil})
		})
		return b, err
	}
	if key == "POST /api/notifications/test" {
		var settings jsonx.Object
		err := scoped(func(tx *db.Tx) error { var err error; settings, err = one(ctx, tx, key, 0, c.TenantID); return err })
		if err != nil {
			return nil, err
		}
		if !jsonx.Truthy(settings.Get("notify_webhook_url")) {
			return nil, apierr.New(400, "configure o endereço do webhook primeiro")
		}
		status, err := outbound.Post(ctx, settings.Get("notify_webhook_url").(string), jsonx.Object{{Name: "text", Value: "NexoISP: aviso de teste. Se você está lendo isto, o webhook está funcionando."}, {Name: "event", Value: "test"}}, nil, 5*time.Second)
		if err == nil && (status < 200 || status >= 300) {
			err = fmt.Errorf("o destino respondeu %d", status)
		}
		if err != nil {
			return nil, apierr.New(502, "o aviso de teste não foi entregue: "+err.Error())
		}
		return map[string]any{"ok": true}, nil
	}
	if key == "POST /api/notice-channels/:id/test" {
		var ch jsonx.Object
		err := scoped(func(tx *db.Tx) error {
			var err error
			ch, err = mustRow(ctx, tx, key, 0, "canal não encontrado", id)
			return err
		})
		if err != nil {
			return nil, err
		}
		sendErr := outbound.Message(ctx, ch, b["phone"].(string), b["message"].(string))
		err = scoped(func(tx *db.Tx) error {
			if sendErr != nil {
				if err := audit.InTx(ctx, tx, c, "notice_channel.test", "notice_channel", id, map[string]any{"ok": false, "error": sendErr.Error()}, "error"); err != nil {
					return err
				}
				return apierr.New(502, "o envio de teste falhou: "+sendErr.Error())
			}
			if err := tx.Exec(ctx, query(key, 1), c.TenantID, b["phone"]); err != nil {
				return err
			}
			return record(ctx, tx, "notice_channel.test", "notice_channel", id, map[string]any{"ok": true})
		})
		return map[string]any{"ok": true}, err
	}
	if key == "POST /api/webhook-endpoints/:id/test" {
		var endpoint jsonx.Object
		err := scoped(func(tx *db.Tx) error {
			var err error
			endpoint, err = mustRow(ctx, tx, key, 0, "endpoint não encontrado", id)
			return err
		})
		if err != nil {
			return nil, err
		}
		secret, sendErr := cryptox.DecryptSecret(endpoint.Get("secret_enc").(string))
		status := 0
		if sendErr == nil {
			status, sendErr = outbound.Webhook(ctx, endpoint.Get("url").(string), secret, "test", "test", jsonx.Object{{Name: "event", Value: "test"}, {Name: "created_at", Value: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, {Name: "data", Value: jsonx.Object{{Name: "message", Value: "Evento de teste do NexoISP"}}}})
		}
		if sendErr != nil {
			return map[string]any{"ok": false, "status": nil, "error": outbound.ErrorText(sendErr)}, nil
		}
		out := map[string]any{"ok": status >= 200 && status < 300, "status": status}
		if status >= 300 {
			out["error"] = fmt.Sprintf("o destino respondeu %d", status)
		}
		return out, nil
	}
	var parsed *url.URL
	var err error
	if b["url"] != nil {
		parsed, err = outbound.SafeURL(ctx, b["url"].(string))
		if err != nil {
			return nil, err
		}
	}
	if key == "POST /api/notice-channels" {
		headers := b["headers"].(jsonx.Object)
		names := []string{}
		for _, h := range headers {
			if !regexp.MustCompile(`^[A-Za-z0-9-]{1,40}$`).MatchString(h.Name) {
				return nil, apierr.New(400, "cabeçalho inválido: "+h.Name)
			}
			names = append(names, h.Name)
		}
		extra, err := jsonx.Encode(b["extra_body"])
		if err != nil {
			return nil, err
		}
		var encrypted any
		if len(headers) > 0 {
			raw, err := jsonx.Encode(headers)
			if err != nil {
				return nil, err
			}
			encrypted, err = cryptox.EncryptSecret(string(raw))
			if err != nil {
				return nil, err
			}
		}
		var row jsonx.Object
		err = scoped(func(tx *db.Tx) error {
			var err error
			row, err = one(ctx, tx, key, 0, c.TenantID, b["name"], b["url"], b["phone_field"], b["message_field"], extra, encrypted)
			if err != nil {
				return err
			}
			if row == nil {
				return apierr.New(409, "já existe um canal com este nome")
			}
			return record(ctx, tx, "notice_channel.create", "notice_channel", row.Get("id"), map[string]any{"name": b["name"], "url_host": parsed.Host, "headers": names})
		})
		return row, err
	}
	if key == "POST /api/webhook-endpoints" {
		token, err := cryptox.RandomToken(24)
		if err != nil {
			return nil, err
		}
		secret := "whsec_" + token
		encrypted, err := cryptox.EncryptSecret(secret)
		if err != nil {
			return nil, err
		}
		var row jsonx.Object
		err = scoped(func(tx *db.Tx) error {
			var err error
			row, err = one(ctx, tx, key, 0, c.TenantID, b["name"], b["url"], encrypted, unique(b["events"].([]any)))
			if err != nil {
				return err
			}
			if row == nil {
				return apierr.New(409, "já existe um endpoint com este nome")
			}
			return record(ctx, tx, "webhook.create", "webhook_endpoint", row.Get("id"), map[string]any{"name": b["name"], "host": parsed.Host, "events": row.Get("events")})
		})
		if err != nil {
			return nil, err
		}
		row.Set("secret", secret)
		return row, nil
	}
	var events any
	if b["events"] != nil {
		events = unique(b["events"].([]any))
	}
	var row jsonx.Object
	err = scoped(func(tx *db.Tx) error {
		var err error
		row, err = mustRow(ctx, tx, key, 0, "endpoint não encontrado", id, b["url"], events, b["active"])
		if err != nil {
			return err
		}
		detail := map[string]any{}
		for k, v := range b {
			detail[k] = v
		}
		delete(detail, "url")
		if parsed != nil {
			detail["url"] = parsed.Host
		}
		return record(ctx, tx, "webhook.update", "webhook_endpoint", id, detail)
	})
	return row, err
}
