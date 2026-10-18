package leitura

import (
	"context"
	"math"
	"net/http"
	"os"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

var apiScopes = []string{"subscribers:read", "contracts:read", "invoices:read", "tickets:write", "work_orders:read", "work_orders:write"}
var webhookEvents = []string{"invoice.paid", "ticket.created", "access.suspend_requested", "access.resume_requested", "access.suspended", "access.resumed", "access.change_failed", "work_order.created", "work_order.status_changed", "sla.breached", "survey.answered", "contract.changed"}

func registerAuxiliares(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, "/api/contracts/{id}/usage-series", "network:read", false, s.contractUsage)
	r.Get(api, "/api/integrations/catalog", "settings:manage", false, func(context.Context, *http.Request) (endpoint.Result, error) {
		return endpoint.Result{Value: map[string]any{"scopes": apiScopes, "events": webhookEvents}}, nil
	})
	r.Get(api, "/api/acs/status", "network:read", false, func(context.Context, *http.Request) (endpoint.Result, error) {
		url := os.Getenv("NEXO_ACS_URL")
		var public any
		if value, present := os.LookupEnv("NEXO_ACS_PUBLIC_URL"); present {
			public = value
		}
		return endpoint.Result{Value: map[string]any{"enabled": strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "https://"), "public_url": public}}, nil
	})
	for _, route := range []struct{ path, perm string }{{"/api/finance/settings", "finance:read"}, {"/api/invoices/{id}/due", "finance:read"}, {"/api/contracts/{id}/trust-release", "contracts:read"}, {"/api/noc/settings", "network:read"}} {
		r.Get(api, route.path, route.perm, false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if strings.Contains(route.path, "{id}") {
				if err := validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			c := auth.From(ctx)
			var result any
			err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
				switch route.path {
				case "/api/finance/settings":
					settings, err := GetSettings(ctx, tx, c.TenantID)
					settings.Set("demo_mode", os.Getenv("NEXO_DEMO_MODE") == "1")
					result = settings
					return err
				case "/api/invoices/{id}/due":
					var err error
					result, err = DueBreakdown(ctx, tx, id)
					return err
				case "/api/contracts/{id}/trust-release":
					var err error
					result, err = trustState(ctx, tx, c.TenantID, id)
					return err
				case "/api/noc/settings":
					rows, err := tx.Objects(ctx, "select onu_rx_min_dbm, pon_outage_min, onu_remove_on_contract_end from tenant_settings where tenant_id=$1", c.TenantID)
					value := object(rows)
					var rx any
					if v := value.Get("onu_rx_min_dbm"); v != nil {
						rx = num(v)
					}
					min := value.Get("pon_outage_min")
					if min == nil {
						min = 3
					}
					remove := value.Get("onu_remove_on_contract_end")
					if remove == nil {
						remove = false
					}
					result = map[string]any{"onu_rx_min_dbm": rx, "pon_outage_min": min, "onu_remove_on_contract_end": remove}
					return err
				}
				return nil
			})
			return endpoint.Result{Value: result}, err
		})
	}
}
func GetSettings(ctx context.Context, tx *db.Tx, tenant string) (jsonx.Object, error) {
	rows, err := tx.Objects(ctx, gen.Trust0, tenant)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		return rows[0], nil
	}
	defaults := jsonx.Object{{Name: "tenant_id", Value: tenant}, {Name: "timezone", Value: "America/Sao_Paulo"}, {Name: "gateway", Value: "none"}, {Name: "billing_auto", Value: false}, {Name: "auto_suspend", Value: false}, {Name: "suspend_after_days", Value: nil}, {Name: "auto_resume_on_payment", Value: false}, {Name: "suspension_mode", Value: "reject"}, {Name: "suspension_profile", Value: nil}, {Name: "trust_release_enabled", Value: false}, {Name: "trust_release_days", Value: 3}, {Name: "trust_release_gap_days", Value: 30}, {Name: "late_fee_percent", Value: 0}, {Name: "interest_monthly_percent", Value: 0}, {Name: "prorate_first_month", Value: false}}
	return defaults, nil
}
func DueBreakdown(ctx context.Context, tx *db.Tx, id string) (map[string]any, error) {
	rows, err := tx.Objects(ctx, gen.Due, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "fatura não encontrada")
	}
	r := rows[0]
	amount, fee, discount, paid, days := num(r.Get("amount_cents")), num(r.Get("fee_cents")), num(r.Get("discount_cents")), num(r.Get("paid_cents")), num(r.Get("days_late"))
	fine, interest := float64(0), float64(0)
	if days > 0 {
		fine = math.Floor(amount*num(r.Get("fine_pct"))/100 + 0.5)
		interest = math.Floor(amount*num(r.Get("int_pct"))/100*days/30 + 0.5)
	}
	return map[string]any{"status": r.Get("status"), "due_date": r.Get("due_date"), "amount_cents": amount, "fee_cents": fee, "discount_cents": discount, "paid_cents": paid, "remaining_cents": math.Max(0, amount+fee-discount-paid), "days_late": days, "fine_cents": fine, "interest_cents": interest, "fee_if_applied_cents": math.Max(fee, fine+interest)}, nil
}
