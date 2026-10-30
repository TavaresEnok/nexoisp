package escrita

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
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

func TestNetworkSitesPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_NETWORK_SITES_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; SQL não validado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var database, session string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(),session_user::text`).Scan(&database, &session)
	})
	if err != nil || database != "nexo_test" || session != "nexo_go" {
		t.Fatalf("requer nexo_test/nexo_go: %s %s %v", database, session, err)
	}
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	tenants := []string{uuid.NewString(), uuid.NewString()}
	pops := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	err = d.WithScope(ctx, op, func(tx *db.Tx) error {
		for _, id := range tenants {
			if e := tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste locais',$2)`, id, "sites-"+strings.ReplaceAll(id, "-", "")); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=any($1::uuid[])`, tenants)
		}); e != nil {
			t.Error(e)
		}
	})
	for i, id := range pops {
		tenant := tenants[0]
		if i == 2 {
			tenant = tenants[1]
		}
		err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			return tx.Exec(ctx, `insert into pops(id,tenant_id,name) values($1,$2,$3)`, id, tenant, "POP "+id)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user, sub string, ps []string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: user, TenantID: tenant, Role: role, SubscriberID: sub, PopIDs: ps, Permissions: auth.Permissions[role], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, SubscriberID: sub, PopIDs: ps}}
	}
	add("a", tenants[0], "admin", uuid.NewString(), "", nil)
	add("b", tenants[1], "admin", uuid.NewString(), "", nil)
	add("limited", tenants[0], "noc", uuid.NewString(), "", pops[:1])
	add("read", tenants[0], "attendant", uuid.NewString(), "", nil)
	add("portal", tenants[0], "subscriber", uuid.NewString(), uuid.NewString(), nil)
	add("bad", tenants[0], "admin", "\x00", "", nil)
	a, err := auth.New(ftthLoader{actors}, 0, false, 100, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	old := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	defer func() { huma.NewError = old }()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	cfg := huma.DefaultConfig("sites", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	registerNetworkSites(humachi.New(router, cfg), registry, Service{DB: d})
	call := func(token, method, path string, body any, want int) *httptest.ResponseRecorder {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
		req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	assertList := func(token, query string, total, limit, offset int, ids ...string) {
		t.Helper()
		rec := call(token, "GET", "/api/network/sites"+query, nil, 200)
		var result struct {
			Items []struct {
				ID string `json:"id"`
			} `json:"items"`
			Total  int `json:"total"`
			Limit  int `json:"limit"`
			Offset int `json:"offset"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Total != total || result.Limit != limit || result.Offset != offset || len(result.Items) != len(ids) {
			t.Fatalf("lista %s: %s", query, rec.Body.String())
		}
		for i, id := range ids {
			if result.Items[i].ID != id {
				t.Fatalf("ordem/conteúdo %s: %s", query, rec.Body.String())
			}
		}
	}
	base := "/api/network/sites"
	body := map[string]any{"pop_id": pops[0], "kind": "pole", "name": " Poste ", "notes": "preservar", "latitude": -22.0, "longitude": -44.0}
	rec := call("a", "POST", base, body, 200)
	var site map[string]any
	if e := json.Unmarshal(rec.Body.Bytes(), &site); e != nil {
		t.Fatal(e)
	}
	id := site["id"].(string)
	path := base + "/" + id
	call("b", "GET", path, nil, 404)
	call("portal", "GET", base, nil, 403)
	call("read", "POST", base, body, 403)
	call("limited", "POST", base, map[string]any{"pop_id": pops[1], "kind": "tower", "name": "Torre"}, 404)
	call("a", "POST", base, map[string]any{"pop_id": pops[2], "kind": "tower", "name": "Torre"}, 404)
	hidden := call("a", "POST", base, map[string]any{"pop_id": pops[1], "kind": "tower", "name": "Oculto"}, 200)
	var hiddenSite map[string]any
	if e := json.Unmarshal(hidden.Body.Bytes(), &hiddenSite); e != nil {
		t.Fatal(e)
	}
	hiddenPath := base + "/" + hiddenSite["id"].(string)
	call("limited", "GET", hiddenPath, nil, 404)
	call("limited", "PATCH", hiddenPath, map[string]any{"name": "Não visível"}, 404)
	call("limited", "GET", path, nil, 200)
	call("limited", "GET", base+"?pop_id="+pops[1], nil, 404)
	call("limited", "PATCH", path, map[string]any{"pop_id": pops[1]}, 404)
	rec = call("a", "PATCH", path, map[string]any{"name": "Alterado"}, 200)
	if !strings.Contains(rec.Body.String(), `"notes":"preservar"`) || !strings.Contains(rec.Body.String(), `"latitude":-22`) {
		t.Fatal(rec.Body.String())
	}
	call("a", "PATCH", path, map[string]any{"latitude": 1}, 400)
	call("a", "PATCH", path, map[string]any{"active": false}, 200)
	call("a", "GET", path, nil, 200)
	assertList("a", "?status=archived&kind=pole&q=Alterado", 1, 50, 0, id)
	assertList("limited", "?status=archived", 1, 50, 0, id)
	assertList("b", "?status=all", 0, 50, 0)
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error { return tx.Exec(ctx, `update pops set active=false where id=$1`, pops[0]) }); e != nil {
		t.Fatal(e)
	}
	call("a", "PATCH", path, map[string]any{"notes": "correção"}, 200)
	call("a", "PATCH", path, map[string]any{"active": true}, 400)
	call("a", "POST", base, body, 400)
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error { return tx.Exec(ctx, `update pops set active=true where id=$1`, pops[0]) }); e != nil {
		t.Fatal(e)
	}
	call("a", "PATCH", path, map[string]any{"active": true}, 200)
	duplicate := call("a", "POST", base, map[string]any{"pop_id": pops[0], "kind": "pole", "name": "Alterado"}, 200)
	var duplicateSite map[string]any
	if e := json.Unmarshal(duplicate.Body.Bytes(), &duplicateSite); e != nil {
		t.Fatal(e)
	}
	poleIDs := []string{id, duplicateSite["id"].(string)}
	sort.Strings(poleIDs)
	assertList("a", "?status=all", 3, 50, 0, poleIDs[0], poleIDs[1], hiddenSite["id"].(string))
	assertList("a", "?status=all&limit=1&offset=1", 3, 1, 1, poleIDs[1])
	assertList("a", "?kind=tower&q=Oculto&pop_id="+pops[1], 1, 50, 0, hiddenSite["id"].(string))
	assertList("limited", "?status=all", 2, 50, 0, poleIDs...)
	assertList("b", "?status=all", 0, 50, 0)
	call("a", "GET", base+"?limit=1&limit=2", nil, 400)
	call("bad", "POST", base, body, 500)
	assertList("a", "?status=all", 3, 50, 0, poleIDs[0], poleIDs[1], hiddenSite["id"].(string))
}
