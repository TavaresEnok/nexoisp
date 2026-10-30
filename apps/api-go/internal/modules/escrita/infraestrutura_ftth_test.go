package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

type ftthLoader struct{ actors map[string]*auth.Ctx }

func (l ftthLoader) Load(_ context.Context, hash string) (*auth.Ctx, error) {
	a := l.actors[hash]
	if a == nil {
		return nil, fmt.Errorf("sessão desconhecida")
	}
	return a, nil
}

func TestFTTHContratoPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_FTTH_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_FTTH_PG_REQUIRED=1")
		}
		t.Skip("PostgreSQL ausente: contrato FTTH não comprovado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var database, session, current string
	var tenants []string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&database, &session, &current); e != nil {
			return e
		}
		rows, e := tx.Objects(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id`)
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
	if database != "nexo_test" || session != "nexo_go" || current != "nexo_go" || len(tenants) < 2 {
		t.Fatalf("requer laboratório descartável nexo_test/nexo_go com dois tenants: %s %s %s (%d)", database, session, current, len(tenants))
	}
	// Os tokens e usuários são sintéticos; o Guard e as permissões das rotas são reais.
	actors := map[string]*auth.Ctx{}
	for i, tenant := range tenants[:2] {
		token := fmt.Sprintf("ftth-token-%d", i)
		actor := &auth.Ctx{UserID: uuid.NewString(), TenantID: tenant, Role: "admin", Permissions: auth.Permissions["admin"], Modules: []string{"ftth"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant}}
		actors[ftthHash(token)] = actor
	}
	a, err := auth.New(ftthLoader{actors}, 0, false, 100, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	oldError := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	defer func() { huma.NewError = oldError }()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	config := huma.DefaultConfig("FTTH", "1")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	Register(humachi.New(router, config), registry, Service{DB: d})
	call := func(tenant int, method, path string, body map[string]any, success bool) map[string]any {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		token := fmt.Sprintf("ftth-token-%d", tenant)
		req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
		req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if success && (w.Code < 200 || w.Code >= 300) || !success && (w.Code < 400 || w.Code >= 500) {
			t.Fatalf("%s %s: HTTP %d %s", method, path, w.Code, w.Body.String())
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	create := func(i int, parent string) string {
		b := map[string]any{"name": "FTTH teste " + uuid.NewString(), "kind": "cto", "ports": 4}
		if parent != "" {
			b["parent_id"] = parent
		}
		row := call(i, "POST", "/api/ftth/boxes", b, true)
		id, ok := row["id"].(string)
		if !ok {
			t.Fatalf("caixa: %#v", row)
		}
		return id
	}
	contracts := make([]string, 2)
	for i, tenant := range tenants[:2] {
		err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			var subscriber string
			if e := tx.QueryRow(ctx, `insert into subscribers (tenant_id,name) values ($1, $2) returning id::text`, tenant, "FTTH "+uuid.NewString()).Scan(&subscriber); e != nil {
				return e
			}
			return tx.QueryRow(ctx, `insert into contracts (tenant_id,subscriber_id,plan_version_id,due_day) select $1,$2,plan_version_id,10 from contracts limit 1 returning id::text`, tenant, subscriber).Scan(&contracts[i])
		})
		if err != nil {
			t.Fatalf("fixture contrato sintético: %v", err)
		}
	}

	root := create(0, "")
	child := create(0, root)
	leaf := create(0, "")
	foreign := create(1, "")
	reserve := call(0, "POST", "/api/ftth/boxes/"+root+"/drops", map[string]any{"port": 4, "note": "reserva sintética"}, true)
	drop := reserve["id"].(string)
	linked := call(0, "POST", "/api/ftth/boxes/"+leaf+"/drops", map[string]any{"port": 1, "contract_id": contracts[0]}, true)
	linkedDrop := linked["id"].(string)
	if linked["contract_id"] != contracts[0] {
		t.Fatalf("vínculo próprio: %#v", linked)
	}
	foreignDrop := call(1, "POST", "/api/ftth/boxes/"+foreign+"/drops", map[string]any{"port": 1, "note": "reserva sintética"}, true)["id"].(string)
	snapshot := func(tenant int, box, dropID string) string {
		t.Helper()
		var result string
		e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[tenant]}, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select row_to_json(b)::text || coalesce((select json_agg(row_to_json(x) order by x.id)::text from ftth_drops x where x.box_id=b.id),'[]') || (select count(*)::text from audit_events where entity_id in (b.id::text, $2)) from ftth_boxes b where b.id=$1`, box, dropID).Scan(&result)
		})
		if e != nil {
			t.Fatal(e)
		}
		return result
	}
	before, childBefore := snapshot(0, root, drop), snapshot(0, child, "")
	leafBefore, other := snapshot(0, leaf, linkedDrop), snapshot(1, foreign, foreignDrop)
	call(0, "POST", "/api/ftth/boxes/"+root+"/drops", map[string]any{"port": 4, "note": "não sobrescrever"}, false)
	call(0, "PATCH", "/api/ftth/boxes/"+root, map[string]any{"ports": 3}, false)
	call(0, "POST", "/api/ftth/boxes/"+leaf+"/drops", map[string]any{"port": 1, "note": "não sobrescrever vínculo"}, false)
	call(0, "DELETE", "/api/ftth/boxes/"+leaf, nil, false)
	call(0, "PATCH", "/api/ftth/boxes/"+root, map[string]any{"parent_id": root}, false)
	call(0, "PATCH", "/api/ftth/boxes/"+root, map[string]any{"parent_id": child}, false)
	call(0, "PATCH", "/api/ftth/boxes/"+root, map[string]any{"parent_id": foreign}, false)
	call(0, "POST", "/api/ftth/boxes/"+foreign+"/drops", map[string]any{"port": 2, "note": "cruzado"}, false)
	call(0, "POST", "/api/ftth/boxes/"+root+"/drops", map[string]any{"port": 2, "contract_id": contracts[1]}, false)
	call(0, "DELETE", "/api/ftth/drops/"+foreignDrop, nil, false)
	call(0, "PATCH", "/api/ftth/boxes/"+foreign, map[string]any{"name": "cruzado"}, false)
	if before != snapshot(0, root, drop) || childBefore != snapshot(0, child, "") || leafBefore != snapshot(0, leaf, linkedDrop) || other != snapshot(1, foreign, foreignDrop) {
		t.Fatal("negativas alteraram estado ou auditoria da fixture")
	}
	call(0, "POST", "/api/ftth/boxes/"+root+"/drops", map[string]any{"port": 1, "note": "operação própria após negativas"}, true)
}

func ftthHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
