// Package escrita implements transactional writes with tenant and POP scope.
package escrita

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/outbound"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

//go:embed rotas.json sql/*.sql
var sourceFiles embed.FS

type spec struct {
	Path, Permission string
	Queries          []string
}

var specs = func() map[string]spec {
	data, err := sourceFiles.ReadFile("rotas.json")
	if err != nil {
		panic(err)
	}
	var list []spec
	if err = json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	out := map[string]spec{}
	for _, s := range list {
		out[s.Path] = s
	}
	return out
}()

type Service struct{ DB *db.DB }
type handler func(context.Context, *db.Tx, string, map[string]any) (any, error)
type operation struct {
	handle handler
	schema *validate.Rule
}

func Register(api huma.API, registry *endpoint.Registry, s Service) {
	registerCustom(api,registry,s)
	for key, op := range s.operations() {
		descriptor, exists := specs[key]
		if !exists {
			panic("rota de escrita sem SQL revisado: " + key)
		}
		method, path, _ := strings.Cut(key, " ")
		pattern := regexp.MustCompile(`:([A-Za-z]+)`).ReplaceAllString(path, "{$1}")
		registry.Handle(api, method, pattern, descriptor.Permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if strings.Contains(pattern, "{id}") && !(key == "POST /api/webhook-deliveries/:id/retry" && regexp.MustCompile(`^\d+$`).MatchString(id)) {
				if err := validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			for _, name := range []string{"addonId", "itemId", "userId", "contractId", "paymentId"} {
				if value := chi.URLParam(r, name); value != "" {
					if err := validate.UUID(value); err != nil {
						return endpoint.Result{}, err
					}
				}
			}
			var body map[string]any
			if op.schema != nil {
				var raw any
				present := r.ContentLength != 0 || r.Header.Get("Content-Type") != ""
				if present {
					if err := apierr.DecodeJSON(r, &raw); err != nil {
						return endpoint.Result{}, err
					}
				}
				if !present && (strings.HasSuffix(path, "/addons/:addonId") || strings.HasSuffix(path, "/convert") || key == "POST /api/finance/generate" || key == "POST /api/finance/run-auto-suspend" || strings.HasSuffix(path, "/:action") || strings.HasSuffix(path, "/tunnel")) {
					raw = map[string]any{}
					present = true
				}
				var err error
				body, err = op.schema.Parse(raw, present)
				if err != nil {
					return endpoint.Result{}, err
				}
			}
			if key == "POST /api/import/preview" || key == "POST /api/import/apply" {
				value, err := s.importCSV(ctx, body, key == "POST /api/import/apply")
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/notice-rules/run" {
				value, err := s.noticeRun(ctx, nil, "", nil)
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/demo-gateway/pay" || key == "POST /api/portal/trust-release" {
				value, err := op.handle(ctx, nil, id, body)
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/network/disconnect" {
				value, err := s.disconnect(ctx, nil, "", body)
				return endpoint.Result{Value: value}, err
			}
			if integrationOutside(key) {
				value, err := s.integration(ctx, key, id, body)
				return endpoint.Result{Value: value}, err
			}
			if strings.Contains(path, "/cpe") {
				value, err := s.cpe(ctx, key, id, body)
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/plans/:id/reapply" {
				value, err := s.reapplyPlan(ctx, id)
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/notifications/deliver" {
				value, err := outbound.Notifications(ctx, s.DB, auth.From(ctx).TenantID)
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/webhook-deliveries/:id/retry" {
				value, err := s.retryWebhook(ctx, id)
				return endpoint.Result{Value: value}, err
			}
			if key == "POST /api/portal/acceptances/:id/accept" {
				value, err := s.portalAccept(ctx, id)
				return endpoint.Result{Value: value}, err
			}
			var value any
			err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error { var err error; value, err = op.handle(ctx, tx, id, body); return err })
			if err == nil && key == "POST /api/maintenance-notices/:id/notify" {
				tenant := auth.From(ctx).TenantID
				go func() { _, _ = outbound.Notices(context.Background(), s.DB, tenant, false) }()
			}
			if result, ok := value.(endpoint.Result); ok {
				return result, err
			}
			return endpoint.Result{Value: value}, err
		})
	}
}
func query(key string, index int) string {
	descriptor, exists := specs[key]
	if !exists || index >= len(descriptor.Queries) {
		panic("SQL de escrita não revisado: " + key)
	}
	data, err := sourceFiles.ReadFile("sql/" + descriptor.Queries[index])
	if err != nil {
		panic(err)
	}
	if strings.Contains(string(data), "{{") {
		panic("SQL não resolvido: " + key)
	}
	return string(data)
}
func rows(ctx context.Context, tx *db.Tx, key string, index int, args ...any) ([]jsonx.Object, error) {
	return tx.Objects(ctx, query(key, index), args...)
}
func one(ctx context.Context, tx *db.Tx, key string, index int, args ...any) (jsonx.Object, error) {
	r, err := rows(ctx, tx, key, index, args...)
	if err != nil || len(r) == 0 {
		return nil, err
	}
	return r[0], nil
}
func mustRow(ctx context.Context, tx *db.Tx, key string, index int, message string, args ...any) (jsonx.Object, error) {
	row, err := one(ctx, tx, key, index, args...)
	if err == nil && row == nil {
		err = apierr.New(404, message)
	}
	return row, err
}
func record(ctx context.Context, tx *db.Tx, action, entity string, id any, detail map[string]any) error {
	return audit.InTx(ctx, tx, auth.From(ctx), action, entity, id, detail, "ok")
}
func num(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	}
	panic(fmt.Sprintf("número inesperado: %T", v))
}
func has(body map[string]any, key string) bool { _, exists := body[key]; return exists }
func obj(rule validate.Rule) *validate.Rule    { return &rule }
func text(max float64) validate.Rule           { return validate.String().Trimmed().Max(max) }
func nilEmpty(v any) any {
	if v == "" {
		return nil
	}
	return v
}

func nullableUser(c *auth.Ctx) any {
	if c.UserID == "" {
		return nil
	}
	return c.UserID
}
