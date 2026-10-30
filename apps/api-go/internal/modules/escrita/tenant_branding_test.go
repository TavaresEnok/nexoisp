package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
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
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

func TestTenantBrandingPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_TENANT_BRANDING_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; contrato SQL não comprovado")
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
	if err != nil {
		t.Fatal(err)
	}
	if database != "nexo_test" || session != "nexo_go" {
		t.Fatal("requer laboratório descartável nexo_test/nexo_go")
	}
	operator, err := tenancy.OperatorScope("gerenciar_provedores")
	if err != nil {
		t.Fatal(err)
	}
	tenants := []string{uuid.NewString(), uuid.NewString()}
	// Isolated fixtures are retained as suspended synthetic tenants because audit
	// records are immutable and application privileges do not allow deleting branding.
	err = d.WithScope(ctx, operator, func(tx *db.Tx) error {
		for _, id := range tenants {
			if e := tx.Exec(ctx, `insert into tenants (id,name,slug) values ($1,'Teste marca portal',$2)`, id, "brand-"+strings.ReplaceAll(id, "-", "")); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Cleanup also runs after Fatal; clear the synthetic branding and deactivate
		// the fixtures without deleting or altering their audit history.
		for _, id := range tenants {
			if e := d.WithScope(ctx, tenancy.Scope{TenantID: id}, func(tx *db.Tx) error {
				return tx.Exec(ctx, `update tenant_branding set display_name=null, logo_png=null, logo_sha256=null, logo_width=null, logo_height=null where tenant_id=$1`, id)
			}); e != nil {
				t.Errorf("limpeza da marca de teste: %v", e)
			}
		}
		if e := d.WithScope(ctx, operator, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=any($1::uuid[])`, tenants)
		}); e != nil {
			t.Errorf("encerramento dos provedores de teste: %v", e)
		}
	})
	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user, sub string, scope tenancy.Scope) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: user, TenantID: tenant, SubscriberID: sub, Role: role, Permissions: auth.Permissions[role], ExpiresAt: time.Now().Add(time.Hour), Scope: scope}
	}
	add("a", tenants[0], "admin", uuid.NewString(), "", tenancy.Scope{TenantID: tenants[0]})
	add("b", tenants[1], "admin", uuid.NewString(), "", tenancy.Scope{TenantID: tenants[1]})
	sub := uuid.NewString()
	add("subscriber", tenants[0], "subscriber", uuid.NewString(), sub, tenancy.Scope{TenantID: tenants[0], SubscriberID: sub})
	add("attendant", tenants[0], "attendant", uuid.NewString(), "", tenancy.Scope{TenantID: tenants[0]})
	add("platform", "", "saas_operator", uuid.NewString(), "", tenancy.Scope{})
	add("bad-audit", tenants[0], "admin", "\x00", "", tenancy.Scope{TenantID: tenants[0]})
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
	config := huma.DefaultConfig("branding", "1")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	registerTenantBranding(humachi.New(router, config), registry, Service{DB: d})
	call := func(token, method, path string, body any, csrf bool, want int) *httptest.ResponseRecorder {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
			if csrf {
				req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
			}
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: %d expected %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	get := "/api/tenant-branding"
	put := "/api/settings/portal-branding"
	// Fresh fixture tenants start without branding rows.
	for _, token := range []string{"a", "b"} {
		rec := call(token, "GET", get, nil, true, 200)
		if !strings.Contains(rec.Body.String(), `"display_name":null`) || !strings.Contains(rec.Body.String(), `"updated_at":null`) {
			t.Fatal("laboratório já possui marca", rec.Body.String())
		}
	}
	call("", "GET", get, nil, true, 401)
	call("platform", "GET", get, nil, true, 403)
	call("subscriber", "PUT", put, map[string]any{"display_name": nil, "logo_action": "keep"}, true, 403)
	call("attendant", "PUT", put, map[string]any{"display_name": nil, "logo_action": "keep"}, true, 403)
	call("a", "PUT", put, map[string]any{"display_name": nil, "logo_action": "keep"}, false, 403)
	img := image.NewRGBA(image.Rect(0, 0, 3, 2))
	img.Set(1, 1, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err = png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	input := append(buf.Bytes(), []byte("synthetic trailing data")...)
	encoded := base64.StdEncoding.EncodeToString(input)
	for _, body := range []any{map[string]any{"display_name": "Nome", "logo_action": "replace", "logo_content_base64": "!!!"}, map[string]any{"display_name": "Nome", "logo_action": "replace", "logo_content_base64": base64.StdEncoding.EncodeToString([]byte("<svg/>"))}, map[string]any{"display_name": "Nome", "logo_action": "keep", "logo_content_base64": "x"}, map[string]any{"display_name": "x", "logo_action": "keep"}} {
		call("a", "PUT", put, body, true, 400)
	}
	big := image.NewRGBA(image.Rect(0, 0, 513, 1))
	buf.Reset()
	_ = png.Encode(&buf, big)
	call("a", "PUT", put, map[string]any{"display_name": "Nome", "logo_action": "replace", "logo_content_base64": base64.StdEncoding.EncodeToString(buf.Bytes())}, true, 400)
	body := map[string]any{"display_name": "  Marca teste  ", "logo_action": "replace", "logo_content_base64": encoded}
	saved := call("a", "PUT", put, body, true, 200)
	var meta struct {
		DisplayName string       `json:"display_name"`
		Logo        brandingLogo `json:"logo"`
	}
	if err = json.Unmarshal(saved.Body.Bytes(), &meta); err != nil || meta.DisplayName != "Marca teste" {
		t.Fatal(saved.Body.String(), err)
	}
	raw := call("subscriber", "GET", get+"/logo", nil, true, 200)
	sum := sha256.Sum256(raw.Body.Bytes())
	if raw.Header().Get("Content-Type") != "image/png" || raw.Header().Get("X-Content-Type-Options") != "nosniff" || raw.Header().Get("Cache-Control") != "private, no-store" || hex.EncodeToString(sum[:]) != meta.Logo.SHA256 || bytes.Contains(raw.Body.Bytes(), []byte("synthetic trailing data")) || meta.Logo.Size != raw.Body.Len() || meta.Logo.Width != 3 || meta.Logo.Height != 2 {
		t.Fatal("PNG ou metadados incorretos")
	}
	call("b", "GET", get+"/logo", nil, true, 404)
	call("subscriber", "GET", get, nil, true, 200)
	failed := call("bad-audit", "PUT", put, map[string]any{"display_name": "Não persistir", "logo_action": "replace", "logo_content_base64": encoded}, true, 500)
	if strings.Contains(failed.Body.String(), encoded) {
		t.Fatal("conteúdo exposto")
	}
	after := call("a", "GET", get, nil, true, 200)
	if !strings.Contains(after.Body.String(), "Marca teste") {
		t.Fatal("falha de auditoria não reverteu alteração")
	}
	call("a", "PUT", put, map[string]any{"display_name": nil, "logo_action": "remove"}, true, 200)
	call("subscriber", "GET", get+"/logo", nil, true, 404)
}

func TestTenantBrandingRaster(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 2, 3))
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	source := append(b.Bytes(), []byte("extra")...)
	normalized, hash, width, height, err := brandingImage(base64.StdEncoding.EncodeToString(source))
	if err != nil || width != 2 || height != 3 || bytes.Contains(normalized, []byte("extra")) {
		t.Fatalf("normalização inválida: %v", err)
	}
	sum := sha256.Sum256(normalized)
	if hash != hex.EncodeToString(sum[:]) {
		t.Fatal("hash incorreto")
	}
	for _, input := range []string{"!!!", base64.StdEncoding.EncodeToString([]byte("<svg/>")), base64.StdEncoding.EncodeToString(source[:12])} {
		if _, _, _, _, err := brandingImage(input); err == nil {
			t.Fatal("raster inválido aceito")
		}
	}
}
