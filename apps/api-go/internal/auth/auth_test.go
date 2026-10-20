package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type loaderFunc func(context.Context, string) (*Ctx, error)

func (f loaderFunc) Load(ctx context.Context, h string) (*Ctx, error) { return f(ctx, h) }
func newTest(t *testing.T, l Loader) *Auth {
	t.Helper()
	a, e := New(l, 5*time.Second, true, 30, prometheus.NewRegistry())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(a.Close)
	return a
}
func TestControlOrder(t *testing.T) {
	a := newTest(t, nil)
	c := &Ctx{Role: "subscriber", TokenHash: "test", Permissions: []string{"portal:self"}}
	audited := 0
	a.Audit = func(context.Context, *Ctx, string, string, any, map[string]any, string) error {
		audited++
		return errors.New("falha de auditoria simulada")
	}
	r := httptest.NewRequest("GET", "/api/tickets", nil)
	w := httptest.NewRecorder()
	err := a.Guard(context.Background(), w, r, c, "crm:read", false)
	if err == nil || err.Error() != "sem permissão para esta ação" || audited != 1 {
		t.Fatalf("negativa antes de módulo: %v; auditoria=%d", err, audited)
	}
	c.Permissions = []string{"crm:read"}
	c.TenantID = "tenant"
	if err = a.Guard(context.Background(), w, r, c, "crm:read", false); err == nil || apierr.Map(err).Code != "module_disabled" {
		t.Fatalf("módulo: %v", err)
	}
	c.Role = "admin"
	c.MFAEnabled = false
	if err = a.Guard(context.Background(), w, r, c, "crm:read", false); err == nil || apierr.Map(err).Code != "mfa_setup_required" {
		t.Fatalf("MFA antes de módulo: %v", err)
	}
	c.Modules = []string{"crm"}
	if err = a.Guard(context.Background(), w, r, c, "crm:read", true); err != nil {
		t.Fatalf("allowMfaPending: %v", err)
	}
}
func TestTokenPrecedenceAndCSRF(t *testing.T) {
	for _, c := range []struct {
		method, authorization, cookie, csrf, token string
		status                                     int
	}{{"POST", "", "nexo_session=invalid", "", "", 403}, {"POST", "Bearer bearer", "nexo_session=cookie", "", "bearer", 0}, {"GET", "", "nexo_session=cookie", "", "cookie", 0}, {"POST", "", "nexo_session=cookie", SessionCSRF("cookie"), "cookie", 0}, {"POST", "", "nexo_session=cookie", "1", "", 403}, {"POST", "", "nexo_session=cookie", SessionCSRF("outra"), "", 403}, {"GET", "", "", "", "", 401}, {"POST", "Bearer ", "nexo_session=cookie", "", "", 403}} {
		r := httptest.NewRequest(c.method, "/", nil)
		r.Header.Set("Authorization", c.authorization)
		r.Header.Set("Cookie", c.cookie)
		r.Header.Set("X-Nexo-Csrf", c.csrf)
		v, e := Token(r)
		if c.status == 0 {
			if e != nil || v != c.token {
				t.Fatalf("%+v: %q %v", c, v, e)
			}
		} else if e == nil || apierr.Map(e).Status != c.status {
			t.Fatalf("%+v: %v", c, e)
		}
	}
}
func TestRate(t *testing.T) {
	a := newTest(t, nil)
	c := &Ctx{Role: "admin", MFAEnabled: true, TokenHash: "rate"}
	r := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	for i := 1; i <= 31; i++ {
		e := a.Guard(context.Background(), w, r, c, "", false)
		if i <= 30 && e != nil {
			t.Fatal(e)
		}
		if i == 31 && (e == nil || apierr.Map(e).Code != "rate_limited" || w.Header().Get("Retry-After") == "") {
			t.Fatalf("31ª: %v", e)
		}
	}
}
func TestCacheInvalidationAndDisconnect(t *testing.T) {
	var n atomic.Int64
	l := loaderFunc(func(ctx context.Context, h string) (*Ctx, error) {
		n.Add(1)
		return &Ctx{UserID: "user", TenantID: "tenant", TokenHash: h, ExpiresAt: time.Now().Add(time.Hour)}, nil
	})
	a := newTest(t, l)
	a.State(true)
	for i := 0; i < 2; i++ {
		if _, e := a.Load(context.Background(), "token"); e != nil {
			t.Fatal(e)
		}
	}
	if n.Load() != 1 {
		t.Fatalf("cache não acertou: %d", n.Load())
	}
	a.Invalidate(db.Notification{Kind: "user", User: "user"})
	_, _ = a.Load(context.Background(), "token")
	if n.Load() != 2 {
		t.Fatal("usuário não invalidado")
	}
	a.Invalidate(db.Notification{Kind: "tenant", Tenant: "tenant"})
	_, _ = a.Load(context.Background(), "token")
	if n.Load() != 3 {
		t.Fatal("tenant não invalidado")
	}
	a.State(false)
	_, _ = a.Load(context.Background(), "token")
	_, _ = a.Load(context.Background(), "token")
	if n.Load() != 5 {
		t.Fatal("cache ativo sem LISTEN")
	}
}
func TestInvalidationDuringLoad(t *testing.T) {
	started, finish := make(chan struct{}), make(chan struct{})
	var n atomic.Int64
	a := newTest(t, loaderFunc(func(ctx context.Context, h string) (*Ctx, error) {
		if n.Add(1) == 1 {
			close(started)
			<-finish
		}
		return &Ctx{UserID: "user", TokenHash: h, ExpiresAt: time.Now().Add(time.Hour)}, nil
	}))
	a.State(true)
	done := make(chan struct{})
	go func() { defer close(done); _, _ = a.Load(context.Background(), "race") }()
	<-started
	a.Invalidate(db.Notification{Kind: "user", User: "user"})
	close(finish)
	<-done
	_, _ = a.Load(context.Background(), "race")
	if n.Load() != 2 {
		t.Fatal("contexto antigo reinserido após invalidação")
	}
}
func TestCacheExpiresAt(t *testing.T) {
	var n atomic.Int64
	a := newTest(t, loaderFunc(func(ctx context.Context, h string) (*Ctx, error) {
		if n.Add(1) > 1 {
			return nil, apierr.New(401, "sessão inválida ou expirada")
		}
		return &Ctx{TokenHash: h, ExpiresAt: time.Now().Add(20 * time.Millisecond)}, nil
	}))
	a.State(true)
	_, _ = a.Load(context.Background(), "expiry")
	time.Sleep(30 * time.Millisecond)
	if _, e := a.Load(context.Background(), "expiry"); e == nil {
		t.Fatal("sessão expirada aceita")
	}
}
func TestAuthorizationContract(t *testing.T) {
	if !reflect.DeepEqual(Permissions["saas_operator"], []string{"tenants:manage"}) || !reflect.DeepEqual(Permissions["subscriber"], []string{"portal:self"}) {
		t.Fatal("permissões centrais divergentes")
	}
	for path, want := range map[string][]string{
		"/api/subscribers":    nil,
		"/api/contracts/x":    nil,
		"/api/tickets":        {"crm"},
		"/api/portal/surveys": {"field"},
		"/api/reports/sla":    {"crm", "field"},
		"/api/stock/items":    {"field"},
	} {
		if !reflect.DeepEqual(Modules(path), want) {
			t.Fatalf("módulo %s", path)
		}
	}
}

func TestTenantFromSession(t *testing.T) {
	a := newTest(t, loaderFunc(func(context.Context, string) (*Ctx, error) {
		return &Ctx{Role: "attendant", TenantID: "tenant-original", Permissions: Permissions["attendant"], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: "tenant-original"}}, nil
	}))
	r := httptest.NewRequest("GET", "/api/subscribers", nil)
	r.Header.Set("Authorization", "Bearer synthetic")
	r.Header.Set("X-Bench-Tenant", "tenant-forjado")
	w := httptest.NewRecorder()
	called := false
	a.Require("subscribers:read", false, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if From(r.Context()).Scope.TenantID != "tenant-original" {
			t.Error("tenant veio do cabeçalho")
		}
	})).ServeHTTP(w, r)
	if !called {
		t.Fatal("handler não executado")
	}
}
