package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestR01AuthContext(t *testing.T) {
	base := Ctx{TokenHash: hashToken("token"), UserID: "u", TenantID: "t", Role: "admin", MFAEnabled: true, Permissions: []string{"a"}, Modules: []string{"m"}, PopIDs: []string{"p"}, ExpiresAt: time.Now().Add(time.Hour)}
	for name, change := range map[string]func(*Ctx){
		"equal": func(*Ctx) {}, "user": func(c *Ctx) { c.UserID = "other" }, "tenant": func(c *Ctx) { c.TenantID = "other" }, "support": func(c *Ctx) { c.Support = true }, "role": func(c *Ctx) { c.Role = "other" }, "permissions": func(c *Ctx) { c.Permissions = []string{"b"} }, "modules": func(c *Ctx) { c.Modules = []string{"b"} }, "pop": func(c *Ctx) { c.PopIDs = []string{"b"} }, "mfa": func(c *Ctx) { c.MFAEnabled = false }, "session": func(c *Ctx) { c.TokenHash = "other" },
	} {
		t.Run(name, func(t *testing.T) {
			current := base
			change(&current)
			a := newTest(t, loaderFunc(func(context.Context, string) (*Ctx, error) { return &current, nil }))
			called := false
			handler := a.Require("", true, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			r := httptest.NewRequest("POST", "/api/test", nil)
			r.Header.Set("Authorization", "Bearer token")
			r.Header.Set("X-Nexo-Context", ContextMarker(&base))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if name == "equal" {
				if !called || w.Code != 200 {
					t.Fatalf("equal: %d %v", w.Code, called)
				}
			} else if called || w.Code != 409 {
				t.Fatalf("changed: %d %v", w.Code, called)
			}
		})
	}
}
