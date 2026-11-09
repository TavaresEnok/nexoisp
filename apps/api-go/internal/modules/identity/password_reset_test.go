package identity

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

// Redefinição administrativa de senha (AD-02) contra PostgreSQL real: senha
// provisória, rotas recusadas até a troca (inclusive com MFA), sessões encerradas
// e auditoria, com o carregador de sessão de produção.
func TestAdminPasswordResetRequiresChangePG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_PASSWORD_RESET_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; SQL não validado")
	}
	if os.Getenv("NEXO_SECRET_KEY") == "" {
		key := make([]byte, 32)
		_, _ = rand.Read(key)
		t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString(key))
	}
	t.Setenv("NEXO_TRUST_PROXY", "")
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var database, session string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(),session_user::text`).Scan(&database, &session)
	}); err != nil || database != "nexo_test" || session != "nexo_go" {
		t.Fatalf("requer nexo_test/nexo_go: %s %s %v", database, session, err)
	}
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	// Identificadores no fim da ordenação: outros testes usam o menor tenant do diretório.
	tenants := []string{"f" + uuid.NewString()[1:], "f" + uuid.NewString()[1:]}
	if err = d.WithScope(ctx, op, func(tx *db.Tx) error {
		for _, id := range tenants {
			if e := tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste senha',$2)`, id, "senha-"+strings.ReplaceAll(id, "-", "")[:20]); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=any($1::uuid[])`, tenants)
		}); e != nil {
			t.Error(e)
		}
	})
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	emails := map[string]string{"admin": "admin-" + suffix + "@example.invalid", "staff": "equipe-" + suffix + "@example.invalid", "other": "outro-" + suffix + "@example.invalid", "mfa": "mfa-" + suffix + "@example.invalid"}
	ids := map[string]string{}
	secret, err := cryptox.NewTOTP()
	if err != nil {
		t.Fatal(err)
	}
	for key, email := range emails {
		tenant, role := tenants[0], "attendant"
		if key == "admin" {
			role = "admin"
		}
		if key == "other" {
			tenant, role = tenants[1], "admin"
		}
		hash, e := cryptox.HashPassword("senha-inicial-123")
		if e != nil {
			t.Fatal(e)
		}
		e = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			var id string
			if e := tx.QueryRow(ctx, `insert into users (tenant_id,email,name,password_hash,role) values ($1,$2,$3,$4,$5) returning id`, tenant, email, "Usuário "+key, hash, role).Scan(&id); e != nil {
				return e
			}
			ids[key] = id
			if key == "mfa" {
				enc, e := cryptox.EncryptSecret(secret)
				if e != nil {
					return e
				}
				return tx.Exec(ctx, `update users set mfa_enabled=true, mfa_secret_enc=$2 where id=$1`, id, enc)
			}
			return nil
		})
		if e != nil {
			t.Fatal(e)
		}
	}

	old := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	defer func() { huma.NewError = old }()
	a, err := auth.New(auth.DBLoader{DB: d}, 0, false, 1000, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	cfg := huma.DefaultConfig("identity", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	api := humachi.New(router, cfg)
	Register(api, registry, Service{DB: d, Audit: audit.Writer{DB: d}})
	registry.Get(api, "/api/me", "", true, func(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
		c := auth.From(ctx)
		return endpoint.Result{Value: map[string]any{"id": c.UserID, "password_change_required": c.PasswordChangeRequired}}, nil
	})
	registry.Get(api, "/api/probe", "subscribers:read", false, func(context.Context, *http.Request) (endpoint.Result, error) {
		return endpoint.Result{Value: map[string]any{"ok": true}}, nil
	})
	address := "[2001:db8::" + suffix[:4] + ":" + suffix[4:8] + "]:4321"
	call := func(token, method, path string, body any, want int) *httptest.ResponseRecorder {
		t.Helper()
		var reader *bytes.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			reader = bytes.NewReader(raw)
		} else {
			reader = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, reader)
		req.RemoteAddr = address
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
			req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	login := func(key, password, code string, want int) string {
		t.Helper()
		body := map[string]any{"email": emails[key], "password": password}
		if code != "" {
			body["code"] = code
		}
		rec := call("", "POST", "/api/auth/login", body, want)
		for _, c := range rec.Result().Cookies() {
			if c.Name == "nexo_session" {
				return c.Value
			}
		}
		if want == 200 {
			t.Fatal("login sem cookie de sessão")
		}
		return ""
	}
	flag := func(token string) bool {
		t.Helper()
		var me struct {
			Flag bool `json:"password_change_required"`
		}
		if e := json.Unmarshal(call(token, "GET", "/api/me", nil, 200).Body.Bytes(), &me); e != nil {
			t.Fatal(e)
		}
		return me.Flag
	}
	denied := func(token, method, path string, body any) {
		t.Helper()
		rec := call(token, method, path, body, 403)
		if !strings.Contains(rec.Body.String(), `"code":"password_change_required"`) {
			t.Fatalf("%s %s sem código de troca obrigatória: %s", method, path, rec.Body.String())
		}
	}
	liveTokens := map[string][]string{}
	// Conta as sessões ainda aceitas pelo carregador de produção.
	sessions := func(user string) int {
		t.Helper()
		var alive int
		for _, token := range liveTokens[user] {
			req := httptest.NewRequest("GET", "/api/probe", nil)
			req.RemoteAddr = address
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != 401 {
				alive++
			}
		}
		return alive
	}

	admin := login("admin", "senha-inicial-123", "", 200)
	first := login("staff", "senha-inicial-123", "", 200)
	second := login("staff", "senha-inicial-123", "", 200)
	liveTokens["staff"] = []string{first, second}
	call(first, "GET", "/api/probe", nil, 200)
	if flag(first) {
		t.Fatal("usuário novo marcado para troca")
	}
	if sessions("staff") != 2 {
		t.Fatal("sessões iniciais ausentes")
	}

	// Administrador de outro provedor não alcança o usuário nem suas sessões.
	other := login("other", "senha-inicial-123", "", 200)
	call(other, "PATCH", "/api/users/"+ids["staff"], map[string]any{"password": "invasora-12345"}, 404)
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		var n int
		if e := tx.QueryRow(ctx, `select user_sessions_revoke($1)`, ids["staff"]).Scan(&n); e != nil || n != 0 {
			t.Fatalf("revogação atravessou provedor: %d %v", n, e)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if sessions("staff") != 2 {
		t.Fatal("sessões encerradas por outro provedor")
	}

	// O administrador não usa a redefinição para a própria senha.
	call(admin, "PATCH", "/api/users/"+ids["admin"], map[string]any{"password": "propria-12345"}, 400)

	call(admin, "PATCH", "/api/users/"+ids["staff"], map[string]any{"password": "provisoria-123"}, 200)
	if sessions("staff") != 0 {
		t.Fatal("sessões ativas sobreviveram à redefinição")
	}
	call(first, "GET", "/api/probe", nil, 401)
	call(second, "GET", "/api/me", nil, 401)
	var detail map[string]any
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var raw []byte
		var actor string
		if e := tx.QueryRow(ctx, `select actor_id, detail from audit_events where tenant_id=$1 and action='user.update' and entity_id=$2 order by id desc limit 1`, tenants[0], ids["staff"]).Scan(&actor, &raw); e != nil {
			return e
		}
		if actor != ids["admin"] {
			t.Fatalf("auditoria sem o administrador: %s", actor)
		}
		return json.Unmarshal(raw, &detail)
	}); e != nil {
		t.Fatal(e)
	}
	if detail["password_changed"] != true || detail["password_change_required"] != true || detail["sessions_revoked"] != float64(2) {
		t.Fatalf("auditoria incompleta: %v", detail)
	}
	if strings.Contains(strings.ToLower(jsonString(detail)), "provisoria-123") {
		t.Fatal("senha registrada na auditoria")
	}

	login("staff", "senha-inicial-123", "", 401)
	provisional := login("staff", "provisoria-123", "", 200)
	liveTokens["staff"] = []string{provisional}
	if !flag(provisional) {
		t.Fatal("sessão provisória sem troca obrigatória")
	}
	denied(provisional, "GET", "/api/probe", nil)
	denied(provisional, "POST", "/api/me/mfa/setup", map[string]any{})
	denied(provisional, "PATCH", "/api/users/"+ids["admin"], map[string]any{"name": "Tentativa"})
	call(provisional, "POST", "/api/me/password", map[string]any{"current": "provisoria-123", "next": "provisoria-123"}, 400)
	call(provisional, "POST", "/api/me/password", map[string]any{"current": "errada-12345", "next": "definitiva-456"}, 400)
	call(provisional, "POST", "/api/me/password", map[string]any{"current": "provisoria-123", "next": "definitiva-456"}, 200)
	if flag(provisional) {
		t.Fatal("troca de senha não removeu a exigência")
	}
	call(provisional, "GET", "/api/probe", nil, 200)
	login("staff", "provisoria-123", "", 401)
	login("staff", "definitiva-456", "", 200)

	// Com MFA ativo, o código não libera nada além da troca de senha.
	call(admin, "PATCH", "/api/users/"+ids["mfa"], map[string]any{"password": "provisoria-mfa-1"}, 200)
	login("mfa", "provisoria-mfa-1", "", 401)
	code, err := cryptox.TOTPCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	withMFA := login("mfa", "provisoria-mfa-1", code, 200)
	if !flag(withMFA) {
		t.Fatal("MFA dispensou a troca obrigatória")
	}
	denied(withMFA, "GET", "/api/probe", nil)
	denied(withMFA, "POST", "/api/me/mfa/disable", map[string]any{"password": "provisoria-mfa-1", "code": code})
	call(withMFA, "POST", "/api/auth/logout", nil, 200)
	call(withMFA, "GET", "/api/me", nil, 401)
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
