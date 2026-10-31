package leitura

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

type r04Loader struct{ actor *auth.Ctx }

func (l r04Loader) Load(context.Context, string) (*auth.Ctx, error) { return l.actor, nil }

func r04Request(t *testing.T, d *db.DB, actor *auth.Ctx) *httptest.ResponseRecorder {
	t.Helper()
	a, err := auth.New(r04Loader{actor}, 0, false, 100, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	cfg := huma.DefaultConfig("R04", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath, cfg.DocsPath, cfg.SchemasPath = "", "", ""
	registerDinamicas(humachi.New(router, cfg), registry, Service{DB: d})
	req := httptest.NewRequest(http.MethodGet, "/api/radius/status", nil)
	req.AddCookie(&http.Cookie{Name: "nexo_session", Value: "r04"})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	return w
}

func r04Actor(tenant, role string, pops []string) *auth.Ctx {
	return &auth.Ctx{UserID: uuid.NewString(), TenantID: tenant, Role: role, Permissions: auth.Permissions[role], PopIDs: pops, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, PopIDs: pops}}
}

func TestR04DeniedBeforeDatabase(t *testing.T) {
	tenant := uuid.NewString()
	for _, pops := range [][]string{{uuid.NewString()}, {}} {
		actor := r04Actor(tenant, "noc", pops)
		w := r04Request(t, nil, actor) // A transaction would dereference the nil DB.
		if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), `"vpn"`) || strings.Contains(w.Body.String(), `"counts"`) {
			t.Fatalf("restricted POP: %d %s", w.Code, w.Body.String())
		}
		ctx := auth.With(context.Background(), actor)
		if _, err := (Service{}).radiusCapabilities(ctx, nil); err == nil {
			t.Fatal("capabilities reached database")
		}
		if _, err := (Service{}).radiusStatus(ctx, nil, nil, nil); err == nil {
			t.Fatal("status reached database")
		}
	}
	for _, actor := range []*auth.Ctx{r04Actor(tenant, "subscriber", nil), r04Actor("", "admin", nil), r04Actor("", "saas_operator", nil)} {
		w := r04Request(t, nil, actor)
		if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), `"vpn"`) || strings.Contains(w.Body.String(), `"counts"`) {
			t.Fatalf("unauthorized: %d %s", w.Code, w.Body.String())
		}
	}
	support := r04Actor(tenant, "admin", []string{})
	support.Support = true
	if w := r04Request(t, nil, support); w.Code != http.StatusForbidden {
		t.Fatalf("suporte com POP restrito: %d %s", w.Code, w.Body.String())
	}
}

func TestR04Postgres(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("PG_REQUIRED") == "1" {
			t.Fatal("PG_REQUIRED=1: NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("NEXO_GO_TEST_DATABASE_URL ausente: PostgreSQL e RLS não foram comprovados")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatal("db.Open falhou para banco de teste")
	}
	t.Cleanup(d.Close)
	var database, user, tenantA, tenantB string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(),session_user::text, coalesce((select tenant_id::text from nexo_go_directory() order by tenant_id limit 1),''), coalesce((select tenant_id::text from nexo_go_directory() order by tenant_id offset 1 limit 1),'')`).Scan(&database, &user, &tenantA, &tenantB)
	})
	if err != nil || database != "nexo_test" || user != "nexo_go" || tenantA == "" || tenantB == "" {
		t.Fatal("requer nexo_test/nexo_go e dois tenants existentes")
	}
	baseline := map[string][4]int64{}
	for _, tenant := range []string{tenantA, tenantB} {
		var n [4]int64
		if err := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select (select count(*) from radius_nas), (select count(*) from radius_account), (select count(*) from radius_acct where stopped_at is null), (select count(*) from radius_accounting_events where status='quarantine')`).Scan(&n[0], &n[1], &n[2], &n[3])
		}); err != nil {
			t.Fatal("não foi possível consultar a contagem inicial")
		}
		baseline[tenant] = n
	}
	// Use committed synthetic rows so the actual route sees them in its own transactions.
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	deviceIDs := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for i, id := range ids {
		tenant := tenantA
		if i == 2 {
			tenant = tenantB
		}
		err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			if e := tx.Exec(ctx, `insert into devices(id,tenant_id,name,driver,vendor) values($1,$2,$3,'radius','generic')`, deviceIDs[i], tenant, "R04 "+id); e != nil {
				return e
			}
			if e := tx.Exec(ctx, `insert into radius_account(tenant_id,username,secret_enc,policy,profile,applied_version) values($1,$2,decode('00','hex'),'active','r04',1)`, tenant, "r04-"+id); e != nil {
				return e
			}
			return tx.Exec(ctx, `insert into radius_nas(device_id,tenant_id,nas_ip,secret) values($1,$2,$3,'r04-synthetic-secret')`, deviceIDs[i], tenant, "2001:db8:"+strings.ReplaceAll(deviceIDs[i], "-", "")[:4]+":"+strings.ReplaceAll(deviceIDs[i], "-", "")[4:8]+"::1")
		})
		if err != nil {
			t.Fatalf("preparo sintético falhou: %v", err)
		}
		t.Cleanup(func() {
			if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
				if e := tx.Exec(ctx, `delete from radius_account where username=$1`, "r04-"+id); e != nil {
					return e
				}
				if e := tx.Exec(ctx, `delete from radius_nas where device_id=$1`, deviceIDs[i]); e != nil {
					return e
				}
				if e := tx.Exec(ctx, `delete from devices where id=$1`, deviceIDs[i]); e != nil {
					return e
				}
				return nil
			}); e != nil {
				t.Errorf("limpeza R04: %v", e)
			}
		})
	}
	// POPs need no committed visibility: the route must reject the partial actor
	// before any query. Rollback avoids requiring DELETE on pops for nexo_app.
	rollback := errors.New("rollback fixture POP R04")
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenantA}, func(tx *db.Tx) error {
		for _, id := range ids[:2] {
			if e := tx.Exec(ctx, `insert into pops(id,tenant_id,name) values($1,$2,$3)`, id, tenantA, "R04 "+id); e != nil {
				return e
			}
		}
		for _, tc := range []struct {
			tenant string
			pops   []string
			status int
		}{{tenantA, ids[:1], 403}, {tenantA, []string{}, 403}, {tenantA, nil, 200}, {tenantB, nil, 200}} {
			w := r04Request(t, d, r04Actor(tc.tenant, "admin", tc.pops))
			if w.Code != tc.status {
				t.Fatalf("status: %d %s", w.Code, w.Body.String())
			}
			if tc.status != 200 {
				if strings.Contains(w.Body.String(), `"vpn"`) || strings.Contains(w.Body.String(), `"counts"`) {
					t.Fatal("dados em resposta recusada")
				}
				continue
			}
			var body struct {
				Capabilities struct {
					Counts map[string]any `json:"counts"`
				} `json:"capabilities"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			expected := baseline[tc.tenant]
			expected[0] += 2
			expected[1] += 2
			if tc.tenant == tenantB {
				expected[0]--
				expected[1]--
			}
			for i, field := range []string{"nas", "accounts", "open_sessions", "quarantined_events"} {
				if body.Capabilities.Counts[field] != float64(expected[i]) {
					t.Fatalf("contagem %s divergente: %v / %d", field, body.Capabilities.Counts[field], expected[i])
				}
			}
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("fixture POP R04: %v", err)
	}
}
