package escrita

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

// Atores padronizados dos testes de liquidação, custo médio e contas a pagar.
const (
	actorAdminA = iota
	actorAdminB
	actorFinanceReadA
	actorStockReadA
	actorStockWriteA
	actorPopA
	actorFinanceWriteA
)

type pgHarness struct {
	t       *testing.T
	ctx     context.Context
	d       *db.DB
	tenants []string
	router  *chi.Mux
	prefix  string
}

type pgResponse struct {
	status int
	json   map[string]any
	body   []byte
	header http.Header
}

// newPGHarness abre o laboratório nexo_test (papel nexo_go, dois provedores) e
// registra as rotas pedidas atrás do middleware real de sessão e CSRF.
func newPGHarness(t *testing.T, prefix string, register func(huma.API, *endpoint.Registry, Service)) *pgHarness {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PostgreSQL ausente; SKIP não comprova SQL, gatilhos ou RLS")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var database, session string
	var tenants []string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, "select current_database(), session_user::text").Scan(&database, &session); e != nil {
			return e
		}
		rows, e := tx.Objects(ctx, "select tenant_id::text from nexo_go_directory() order by tenant_id")
		if e != nil {
			return e
		}
		for _, row := range rows {
			tenants = append(tenants, row.Get("tenant_id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if database != "nexo_test" || session != "nexo_go" || len(tenants) < 2 {
		t.Fatal("requer laboratório nexo_test/nexo_go com dois provedores")
	}
	// Sessões reais têm usuário: autoria (created_by, paid_by) usa um usuário do provedor.
	users := map[string]string{}
	for _, tenant := range tenants[:2] {
		var user string
		if err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, "select id::text from users where tenant_id = app_tenant() and role = 'admin' order by created_at, id limit 1").Scan(&user)
		}); err != nil {
			t.Fatal(err)
		}
		users[tenant] = user
	}
	all := auth.Permissions["admin"]
	modules := []string{"field"}
	specs := []struct {
		permissions []string
		scope       tenancy.Scope
		tenant      string
	}{
		actorAdminA:        {all, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		actorAdminB:        {all, tenancy.Scope{TenantID: tenants[1]}, tenants[1]},
		actorFinanceReadA:  {[]string{"finance:read"}, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		actorStockReadA:    {[]string{"stock:read"}, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		actorStockWriteA:   {[]string{"stock:read", "stock:write"}, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		actorPopA:          {all, tenancy.Scope{TenantID: tenants[0], PopIDs: []string{uuid.NewString()}}, tenants[0]},
		actorFinanceWriteA: {[]string{"finance:read", "finance:write"}, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
	}
	actors := map[string]*auth.Ctx{}
	for i, spec := range specs {
		actors[ftthHash(fmt.Sprintf("%s-token-%d", prefix, i))] = &auth.Ctx{UserID: users[spec.tenant], TenantID: spec.tenant, Role: "admin", Permissions: spec.permissions, Modules: modules, ExpiresAt: time.Now().Add(time.Hour), Scope: spec.scope}
	}
	a, err := auth.New(ftthLoader{actors}, 0, false, 100, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	old := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	t.Cleanup(func() { huma.NewError = old })
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	config := huma.DefaultConfig(prefix, "1")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	api := humachi.New(router, config)
	register(api, registry, Service{DB: d})
	return &pgHarness{t: t, ctx: ctx, d: d, tenants: tenants, router: router, prefix: prefix}
}

func (h *pgHarness) request(actor int, method, path string, body any) pgResponse {
	h.t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	token := fmt.Sprintf("%s-token-%d", h.prefix, actor)
	req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
	req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return pgResponse{status: w.Code, json: out, body: w.Body.Bytes(), header: w.Header()}
}

func (h *pgHarness) call(actor int, method, path string, body any, want int) map[string]any {
	h.t.Helper()
	r := h.request(actor, method, path, body)
	if r.status != want {
		h.t.Fatalf("%s %s: %d esperado %d: %s", method, path, r.status, want, string(r.body))
	}
	return r.json
}

// scope executa SQL de preparação ou verificação no escopo de um provedor.
func (h *pgHarness) scope(tenant int, fn func(tx *db.Tx) error) {
	h.t.Helper()
	if err := h.d.WithScope(h.ctx, tenancy.Scope{TenantID: h.tenants[tenant]}, fn); err != nil {
		h.t.Fatal(err)
	}
}

func centsOf(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case string:
		var parsed int64
		fmt.Sscan(n, &parsed)
		return parsed
	}
	return -1
}

func scopeOf(h *pgHarness, tenant int) tenancy.Scope {
	return tenancy.Scope{TenantID: h.tenants[tenant]}
}

// registerCommissionReportForTest expõe o relatório de comissões (operação do
// registrador genérico) com a mesma permissão do manifesto.
func registerCommissionReportForTest(api huma.API, registry *endpoint.Registry, s Service) {
	routeScoped(api, registry, s, http.MethodGet, "/api/reports/commissions", specs["GET /api/reports/commissions"].Permission, nil, false,
		func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, _ map[string]any) (any, error) {
			return s.commissions(ctx, tx, "", nil)
		})
}
