package leitura

import (
	"context"
	"embed"
	"encoding/json"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

//go:embed dinamicas.json dinamicas/*.sql
var dynamicFiles embed.FS

type dynamicSpec struct {
	Path, Permission string
	Queries          []string
}

var dynamicSpecs = func() map[string]dynamicSpec {
	data, err := dynamicFiles.ReadFile("dinamicas.json")
	if err != nil {
		panic(err)
	}
	var specs []dynamicSpec
	if err = json.Unmarshal(data, &specs); err != nil {
		panic(err)
	}
	result := map[string]dynamicSpec{}
	for _, spec := range specs {
		result[spec.Path] = spec
	}
	return result
}()

// SQL variables are fixed SQL fragments, validated numeric pagination, or enum choices.
// Request text and identifiers are always passed separately as PostgreSQL parameters.
func dynamicSQL(path string, index int, variables map[string]string) string {
	spec, ok := dynamicSpecs[path]
	if !ok || index >= len(spec.Queries) {
		panic("SQL dinâmico não revisado: " + path)
	}
	data, err := dynamicFiles.ReadFile("dinamicas/" + spec.Queries[index])
	if err != nil {
		panic(err)
	}
	query := string(data)
	for key, value := range variables {
		query = strings.ReplaceAll(query, "{{"+key+"}}", value)
	}
	if strings.Contains(query, "{{") {
		panic("variável SQL não resolvida: " + path)
	}
	return query
}

type complexHandler func(context.Context, *db.Tx, *http.Request, map[string]any) (endpoint.Result, error)

func registerDinamicas(api huma.API, registry *endpoint.Registry, s Service) {
	handlers := map[string]complexHandler{
		"/api/contracts/:id/termination-quote": s.terminationQuote,
		"/api/invoices":                        s.invoices,
		"/api/crm/report":                      s.crmReport,
		"/api/reports/sla":                     s.slaReport,
		"/api/contracts/:id/availability":      s.availability,
		"/api/agenda":                          s.agenda,
		"/api/agenda/free":                     s.agendaFree,
		"/api/dashboard/panels":                s.dashboardPanels,
	}
	handlers["/api/today"] = s.today
	handlers["/api/radius/status"] = s.radiusStatus
	handlers["/api/radius/devices/:id/setup"] = s.radiusSetup
	handlers["/api/subscribers/:id/timeline"] = s.timeline
	handlers["/api/search"] = s.search
	handlers["/api/map/points"] = s.mapPoints
	handlers["/api/cgnat/plans"] = s.cgnat
	handlers["/api/cgnat/plans/:id/map"] = s.cgnat
	handlers["/api/cgnat/plans/:id/lookup"] = s.cgnat

	for path, handler := range handlers {
		spec := dynamicSpecs[path]
		pattern := strings.ReplaceAll(path, ":id", "{id}")
		registry.Get(api, pattern, spec.Permission, false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if strings.Contains(pattern, "{id}") {
				if err := validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			input, err := parseComplex(path, r)
			if err != nil {
				return endpoint.Result{}, err
			}
			input["id"] = id
			var result endpoint.Result
			scope := auth.From(ctx).Scope
			if path == "/api/radius/status" {
				scope = tenancy.Scope{}
			}
			err = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error { var err error; result, err = handler(ctx, tx, r, input); return err })
			if err == nil && path == "/api/radius/status" {
				// VPN configuration is installation-wide in c1. Tenant/POP
				// metrics need their own actor/cell scope after that TX closes.
				var capabilities map[string]any
				err = s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error { var e error; capabilities, e = s.radiusCapabilities(ctx, tx); return e })
				if err == nil {
					result.Value.(map[string]any)["capabilities"] = capabilities
				}
			}
			if err == nil && path == "/api/invoices" {
				return s.export(ctx, r, result)
			}
			return result, err
		})
	}
}
func parseComplex(path string, r *http.Request) (map[string]any, error) {
	q := validate.Query{Values: r.URL.Query()}
	v := map[string]any{}
	switch path {
	case "/api/subscribers/:id/timeline":
		v["limit"] = q.Integer("limit", 150, 10, 500)
		for i, issue := range q.Issues {
			q.Issues[i] = strings.Replace(issue, "limit:", "dados:", 1)
		}
	case "/api/search":
		v["q"] = q.Text("q", true, true, 2, 100)
	case "/api/map/points":
		v["south"] = q.Number("south", nil, -90, 90, false)
		v["north"] = q.Number("north", nil, -90, 90, false)
		v["west"] = q.Number("west", nil, -180, 180, false)
		v["east"] = q.Number("east", nil, -180, 180, false)
		if _, ok := r.URL.Query()["layers"]; ok {
			v["layers"] = q.String("layers", false, false)
		} else {
			v["layers"] = "contracts,boxes,pops"
		}
		v["status"] = null(q.Enum("status", "", "active", "suspended", "ended"))
	case "/api/contracts/:id/termination-quote":
		v["date"] = null(q.Date("date", false, "data inválida"))
	case "/api/contracts/:id/availability":
		v["days"] = q.Integer("days", 7, 1, 31)
	case "/api/invoices":
		v["q"] = null(q.String("q", true, false))
		v["status"] = null(q.Enum("status", "", "open", "paid", "reconciling", "canceled", "overdue"))
		v["contract_id"] = null(q.UUID("contract_id", false))
		v["company_id"] = null(q.UUID("company_id", false))
		v["format"] = q.String("format", false, false)
		v["page"] = q.Page()
	case "/api/crm/report":
		v["from"] = q.Date("from", true, "data inválida")
		v["to"] = q.Date("to", true, "data inválida")
	case "/api/reports/sla":
		v["from"] = null(q.Date("from", false, "use AAAA-MM-DD"))
		v["to"] = null(q.Date("to", false, "use AAAA-MM-DD"))
	case "/api/cgnat/plans/:id/map":
		v["limit"] = q.Integer("limit", 256, 1, 2000)
		zero := float64(0)
		v["offset"] = q.Number("offset", &zero, 0, math.Inf(1), true)
	case "/api/cgnat/plans/:id/lookup":
		before := len(q.Issues)
		ip := q.String("private_ip", true, true)
		if len(q.Issues) == before {
			if _, ok := ipv4Number(ip); !ok {
				q.Issues = append(q.Issues, "private_ip: IP inválido")
			}
		}
		v["private_ip"] = ip
	case "/api/agenda":
		v["date"] = q.Date("date", true, "use AAAA-MM-DD")
		v["days"] = q.Integer("days", 1, 1, 14)
		v["assignee_id"] = null(q.UUID("assignee_id", false))
	case "/api/agenda/free":
		v["assignee_id"] = q.UUID("assignee_id", true)
		v["date"] = q.Date("date", true, "use AAAA-MM-DD")
		v["minutes"] = q.Integer("minutes", 60, 5, 480)
		v["from_hour"] = q.Integer("from_hour", 8, 0, 23)
		v["to_hour"] = q.Integer("to_hour", 18, 1, 24)
	}
	if err := q.Err(); err != nil {
		return v, err
	}
	if path == "/api/crm/report" && v["to"].(string) < v["from"].(string) {
		return v, apierr.New(400, "período inválido")
	}
	if path == "/api/agenda/free" && v["to_hour"].(int) <= v["from_hour"].(int) {
		return v, apierr.New(400, "o fim do expediente deve ser depois do início")
	}
	return v, nil
}
func complexRows(ctx context.Context, tx *db.Tx, path string, index int, args ...any) ([]jsonx.Object, error) {
	return tx.Objects(ctx, dynamicSQL(path, index, nil), args...)
}
func tzFor(ctx context.Context, tx *db.Tx, tenant string) (any, error) {
	rows, err := tx.Objects(ctx, "select timezone from tenant_settings where tenant_id=$1", tenant)
	tz := object(rows).Get("timezone")
	if tz == nil {
		tz = "America/Sao_Paulo"
	}
	return tz, err
}
func (s Service) terminationQuote(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	date := v["date"]
	if date == nil {
		rows, err := complexRows(ctx, tx, "helper:localToday", 0, 0)
		if err != nil {
			return endpoint.Result{}, err
		}
		date = object(rows).Get("d")
	}
	rows, err := balanceRowsInTx(ctx, tx, balanceReaderTerminationQuoteGet, dynamicSQL("helper:terminationQuote", 0, nil), v["id"], date)
	if err != nil {
		return endpoint.Result{}, err
	}
	if len(rows) == 0 {
		return endpoint.Result{}, apierr.New(404, "contrato não encontrado")
	}
	k := rows[0]
	within := k.Get("within_loyalty") == true
	remaining, penalty := float64(0), float64(0)
	if within {
		remaining = num(k.Get("remaining_months"))
		penalty = num(k.Get("penalty_cents"))
		if k.Get("penalty_model") == "monthly" {
			penalty *= remaining
		}
	}
	return endpoint.Result{Value: map[string]any{"status": k.Get("status"), "loyalty_until": k.Get("loyalty_until"), "within_loyalty": within, "remaining_months": remaining, "penalty_model": k.Get("penalty_model"), "penalty_unit_cents": k.Get("penalty_cents"), "penalty_cents": penalty, "open_invoices": k.Get("open_count"), "open_invoices_cents": k.Get("open_cents"), "total_cents": penalty + num(k.Get("open_cents"))}}, nil
}
func (s Service) invoices(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	today, err := complexRows(ctx, tx, "/api/invoices", 0, auth.From(ctx).TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	args := []any{v["contract_id"], v["status"], object(today).Get("d"), v["q"], v["company_id"]}
	p := v["page"].(validate.Page)
	cap := 500
	if v["format"] == "csv" {
		cap = 5000
	}
	limit := cap
	if p.HasLimit {
		limit = min(p.Limit, cap)
	}
	query := dynamicSQL("/api/invoices", 1, map[string]string{"limit": strconv.Itoa(limit), "offset": strconv.FormatFloat(p.Offset, 'f', -1, 64)})
	rows, err := balanceRowsInTx(ctx, tx, balanceReaderInvoiceList, query, args...)
	if err != nil {
		return endpoint.Result{}, err
	}
	total := int64(len(rows))
	if p.Offset != 0 || len(rows) >= limit {
		err = tx.QueryRow(ctx, dynamicSQL("/api/invoices", 2, nil), args...).Scan(&total)
	}
	return endpoint.Result{Value: rows, Total: strconv.FormatInt(total, 10)}, err
}
func (s Service) crmReport(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	tz, err := tzFor(ctx, tx, auth.From(ctx).TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	args := []any{v["from"], v["to"], tz}
	leads, err := complexRows(ctx, tx, "/api/crm/report", 1, args...)
	if err != nil {
		return endpoint.Result{}, err
	}
	tickets, err := complexRows(ctx, tx, "/api/crm/report", 2, args...)
	if err != nil {
		return endpoint.Result{}, err
	}
	var work any
	if slices.Contains(auth.From(ctx).Permissions, "os:read") {
		rows, err := complexRows(ctx, tx, "/api/crm/report", 3, args...)
		if err != nil {
			return endpoint.Result{}, err
		}
		work = rows
	}
	return endpoint.Result{Value: map[string]any{"from": v["from"], "to": v["to"], "timezone": tz, "leads": leads, "tickets": tickets, "work_orders": work}}, nil
}
func (s Service) slaReport(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	tz, err := tzFor(ctx, tx, auth.From(ctx).TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	rows, err := complexRows(ctx, tx, "/api/reports/sla", 0, v["from"], v["to"], tz)
	return endpoint.Result{Value: map[string]any{"timezone": tz, "rows": rows}}, err
}
func jsRound(n float64) float64 { return math.Floor(n + 0.5) }
