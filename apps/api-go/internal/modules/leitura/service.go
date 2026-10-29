package leitura

import (
	"context"
	"net/http"
	"os"
	"time"
	_ "time/tzdata"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

type Service struct {
	DB         *db.DB
	Audit      audit.Writer
	RequireMFA bool
}

func first(rows []jsonx.Object) any {
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
func object(rows []jsonx.Object) jsonx.Object {
	if len(rows) == 0 {
		return jsonx.Object{}
	}
	return rows[0]
}
func (s Service) rows(ctx context.Context, query string, args ...any) ([]jsonx.Object, error) {
	var rows []jsonx.Object
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error { var err error; rows, err = tx.Objects(ctx, query, args...); return err })
	return rows, err
}
func (s Service) simple(query string, kind string, id bool, subscriber bool) endpoint.Handler {
	return func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		args := []any{}
		if subscriber {
			sid := auth.From(ctx).SubscriberID
			if sid == "" {
				return endpoint.Result{}, apierr.New(403, "sessão sem assinante")
			}
			args = append(args, sid)
		}
		if id {
			value := chi.URLParam(r, "id")
			if err := validate.UUID(value); err != nil {
				return endpoint.Result{}, err
			}
			args = append(args, value)
		}
		rows, err := s.rows(ctx, query, args...)
		var value any = rows
		if kind == "one" {
			value = first(rows)
		}
		return endpoint.Result{Value: value}, err
	}
}
func Register(api huma.API, r *endpoint.Registry, s Service) {
	registerConsultas(api, r, s)
	registerGrupos(api, r, s)
	registerAuxiliares(api, r, s)
	registerDinamicas(api, r, s)
	registerRadiusAccounting(api, r, s)
	registerRadiusHistory(api, r, s)
	registerRadiusTelemetry(api, r, s)
	registerImportReconciliation(api, r, s)
	registerImportRevertEligibility(api, r, s)
	registerCloudNoticeJournal(api, r, s)
	r.PublicGet(api, "/aviso/{slug}", s.notice)
	r.Get(api, "/api/me", "", true, s.me)
	r.Get(api, "/api/plans", "plans:read", false, s.simple(gen.Plans0, "many", false, false))
	r.Get(api, "/api/plans/{id}/versions", "plans:read", false, s.simple(gen.PlanVersions0, "many", true, false))
	r.Get(api, "/api/subscribers/{id}/portal-access", "subscribers:read", false, s.simple(gen.PortalAccess0, "one", true, false))
	r.Get(api, "/api/dashboard", "subscribers:read", false, s.simple(gen.Dashboard0, "one", false, false))
	r.Get(api, "/api/contracts", "contracts:read", false, s.contracts)
	r.Get(api, "/api/portal/overview", "portal:self", false, s.overview)
	r.Get(api, "/api/portal/usage-series", "portal:self", false, s.usage)
	r.Get(api, "/api/portal/acceptances", "portal:self", false, s.simple(gen.Acceptances0, "many", false, false))
	r.Get(api, "/api/portal/tickets", "portal:self", false, s.simple(gen.Tickets0, "many", false, true))
	r.Get(api, "/api/portal/tickets/{id}", "portal:self", false, s.ticket)
	r.Get(api, "/api/portal/surveys", "portal:self", false, s.simple(gen.Surveys0, "many", false, true))
}
func (s Service) me(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
	c := auth.From(ctx)
	var tenant any
	var enabled bool
	if c.TenantID != "" {
		rows, err := s.rows(ctx, gen.Me0, c.TenantID)
		if err != nil {
			return endpoint.Result{}, err
		}
		tenant = first(rows)
	}
	err := s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, "select mfa_enabled from user_self_get($1)", c.UserID).Scan(&enabled)
	})
	return endpoint.Result{Value: map[string]any{"id": c.UserID, "name": c.Name, "email": c.Email, "role": c.Role, "perms": c.Permissions, "support": c.Support, "tenant": tenant, "modules": c.Modules, "pop_restricted": len(c.PopIDs) > 0, "demo": os.Getenv("NEXO_DEMO_MODE") == "1", "mfa_enabled": enabled, "csrf_token": auth.CSRF(c.TokenHash), "mfa_pending": os.Getenv("NEXO_REQUIRE_ADMIN_MFA") == "1" && (c.Role == "admin" || c.Role == "saas_operator") && !c.MFAEnabled}}, err
}
func (s Service) ticket(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	sid := auth.From(ctx).SubscriberID
	if sid == "" {
		return endpoint.Result{}, apierr.New(403, "sessão sem assinante")
	}
	id := chi.URLParam(r, "id")
	if err := validate.UUID(id); err != nil {
		return endpoint.Result{}, err
	}
	var result jsonx.Object
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, gen.Ticket0, id, sid)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			return apierr.New(404, "atendimento não encontrado")
		}
		result = rows[0]
		thread, err := tx.Objects(ctx, gen.Ticket1, id)
		result.Set("thread", thread)
		return err
	})
	return endpoint.Result{Value: result}, err
}
func (s Service) overview(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
	c := auth.From(ctx)
	if c.SubscriberID == "" {
		return endpoint.Result{}, apierr.New(403, "sessão sem assinante")
	}
	result := jsonx.Object{}
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		for i, q := range []struct{ name, sql string }{{"subscriber", gen.Overview0}, {"contracts", gen.Overview1}, {"invoices", gen.Overview2}, {"notices", gen.Overview3}, {"usage", gen.Overview4}} {
			rows, err := tx.Objects(ctx, q.sql, c.SubscriberID)
			if err != nil {
				return err
			}
			if i == 0 {
				if len(rows) > 0 {
					result.Set(q.name, rows[0])
				}
				continue
			}
			if i == 1 {
				for j, k := range rows {
					trust, err := trustState(ctx, tx, c.TenantID, k.Get("id").(string))
					if err != nil {
						return err
					}
					var until any
					if active, ok := trust["active"].(jsonx.Object); ok {
						until = active.Get("expires_at")
					}
					rows[j].Set("trust_release", map[string]any{"enabled": trust["enabled"], "eligible": trust["eligible"], "reason": trust["reason"], "max_days": trust["max_days"], "active_until": until})
				}
			}
			result.Set(q.name, rows)
		}
		return nil
	})
	return endpoint.Result{Value: result}, err
}
func trustState(ctx context.Context, tx *db.Tx, tenant, contract string) (map[string]any, error) {
	settings, err := tx.Objects(ctx, gen.Trust0, tenant)
	if err != nil {
		return nil, err
	}
	config := object(settings)
	enabled, _ := config.Get("trust_release_enabled").(bool)
	maxDays, gap := 3, 30
	if len(settings) > 0 {
		maxDays = int(config.Get("trust_release_days").(int32))
		gap = int(config.Get("trust_release_gap_days").(int32))
	}
	rows, err := tx.Objects(ctx, gen.Trust1, contract)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "contrato não encontrado")
	}
	k := rows[0]
	history, err := tx.Objects(ctx, gen.Trust2, contract)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	var active jsonx.Object
	var next time.Time
	for _, h := range history {
		if active == nil && h.Get("status") == "active" && asTime(h.Get("expires_at")).After(now) {
			active = h
		}
		if next.IsZero() && h.Get("status") != "canceled" {
			next = asTime(h.Get("granted_at")).Add(time.Duration(gap) * 24 * time.Hour)
		}
	}
	var reason any
	switch {
	case !enabled:
		reason = "a liberação por confiança não está habilitada para este provedor"
	case k.Get("status") != "active":
		reason = "contrato encerrado"
	case active != nil:
		reason = "já existe uma liberação em curso"
	case k.Get("desired_policy") == nil:
		reason = "o contrato não tem acesso provisionado"
	case k.Get("desired_policy") != "suspended":
		reason = "o acesso não está suspenso"
	case next.After(now):
		loc, _ := time.LoadLocation("America/Sao_Paulo")
		reason = "nova liberação a partir de " + next.In(loc).Format("02/01/2006")
	}
	var activeValue, nextValue any
	if active != nil {
		v := jsonx.Object{}
		for _, field := range []string{"id", "granted_at", "expires_at", "source", "days"} {
			v.Set(field, active.Get(field))
		}
		activeValue = v
	}
	if next.After(now) {
		nextValue = jsonx.Time{Time: next}
	}
	return map[string]any{"enabled": enabled, "eligible": reason == nil, "reason": reason, "max_days": maxDays, "active": activeValue, "next_allowed_at": nextValue, "history": history}, nil
}
func asTime(v any) time.Time {
	switch v := v.(type) {
	case jsonx.Time:
		return v.Time
	case time.Time:
		return v
	case string:
		t, _ := time.Parse(time.RFC3339Nano, v)
		return t
	}
	return time.Time{}
}
