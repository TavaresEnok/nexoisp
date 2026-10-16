// Package identity implements login, self service and provider administration.
package identity

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

//go:embed rotas.json sql/*.sql
var files embed.FS
var queries = func() map[string][]string {
	data, err := files.ReadFile("rotas.json")
	if err != nil {
		panic(err)
	}
	var list []struct {
		Path    string
		Queries []string
	}
	if err = json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	out := map[string][]string{}
	for _, entry := range list {
		out[entry.Path] = entry.Queries
	}
	return out
}()

func query(key string, index int) string {
	data, err := files.ReadFile("sql/" + queries[key][index])
	if err != nil {
		panic(err)
	}
	return string(data)
}
func one(ctx context.Context, tx *db.Tx, key string, index int, args ...any) (jsonx.Object, error) {
	rows, err := tx.Objects(ctx, query(key, index), args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

type Service struct {
	DB    *db.DB
	Audit audit.Writer
}
type operation struct {
	permission      string
	pending, public bool
	schema          *validate.Rule
}

func rule(r validate.Rule) *validate.Rule { return &r }
func Register(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, str, b, e := validate.F, validate.Object, validate.String, validate.Boolean, validate.Enum
	password := str().Min(8, "senha deve ter ao menos 8 caracteres").Max(200)
	email := str().Refine(func(v any) bool {
		return regexp.MustCompile(`(?i)^([A-Z0-9_'+.\-]*)[A-Z0-9_+\-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$`).MatchString(v.(string)) && !strings.HasPrefix(v.(string), ".") && !strings.Contains(v.(string), "..")
	}, "Invalid email")
	code := str().Trimmed().Min(6).Max(10)
	role := e("admin", "attendant", "finance", "noc")
	ops := map[string]operation{
		"POST /api/auth/login":     {public: true, schema: rule(o(f("email", email), f("password", str().Min(1)), f("code", str().Trimmed().Max(10).Opt())))},
		"POST /api/auth/logout":    {pending: true},
		"POST /api/me/password":    {pending: true, schema: rule(o(f("current", str().Min(1)), f("next", password)))},
		"POST /api/me/mfa/setup":   {pending: true},
		"POST /api/me/mfa/enable":  {pending: true, schema: rule(o(f("code", code)))},
		"POST /api/me/mfa/disable": {pending: true, schema: rule(o(f("password", str().Min(1)), f("code", code)))},
		"POST /api/tenants":        {permission: "tenants:manage", schema: rule(o(f("name", str().Trimmed().Min(2).Max(120)), f("slug", str().Pattern(`^[a-z0-9-]{2,40}$`, "identificador: letras minúsculas, números e hífen")), f("admin_name", str().Trimmed().Min(2)), f("admin_email", email), f("admin_password", password)))},
		"PATCH /api/tenants/:id": {permission: "tenants:manage", schema: rule(o(f("name", str().Trimmed().Min(2).Opt()), f("status", e("active", "suspended").Opt()), f("modules", validate.Array(e("olt", "ipam", "field", "ftth", "crm", "noc", "notices", "messages", "api")).Max(9).Then(func(v any) any {
			out := []any{}
			seen := map[string]bool{}
			for _, x := range v.([]any) {
				if !seen[x.(string)] {
					out = append(out, x)
					seen[x.(string)] = true
				}
			}
			return out
		}, false).Opt())))},
		"POST /api/support/enter": {permission: "tenants:manage", schema: rule(o(f("tenant_id", str().UUID()), f("reason", str().Trimmed().Min(5, "informe o motivo do acesso"))))},
		"POST /api/support/exit":  {},
		"POST /api/users":         {permission: "users:manage", schema: rule(o(f("name", str().Trimmed().Min(2)), f("email", email), f("role", role), f("password", password)))},
		"PATCH /api/users/:id":    {permission: "users:manage", schema: rule(o(f("name", str().Trimmed().Min(2).Opt()), f("role", role.Opt()), f("active", b().Opt()), f("password", password.Opt()), f("reset_mfa", b().Opt())))},
	}
	for key, op := range ops {
		method, path, _ := strings.Cut(key, " ")
		path = strings.ReplaceAll(path, ":id", "{id}")
		handler := func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			c := auth.From(ctx)
			if strings.Contains(key, " /api/tenants") && c.Support {
				return endpoint.Result{}, apierr.New(400, "saia do acesso de suporte para gerenciar provedores")
			}
			id := chi.URLParam(r, "id")
			if id != "" {
				if err := validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			var body map[string]any
			if op.schema != nil {
				var raw any
				present := r.ContentLength != 0 || r.Header.Get("Content-Type") != ""
				if present {
					if err := apierr.DecodeJSON(r, &raw); err != nil {
						return endpoint.Result{}, err
					}
				}
				var err error
				body, err = op.schema.Parse(raw, present)
				if err != nil {
					return endpoint.Result{}, err
				}
			}
			return s.handle(ctx, r, key, id, body)
		}
		if op.public {
			registry.PublicHandle(api, method, path, handler)
		} else if op.pending {
			registry.Pending(api, method, path, handler)
		} else {
			registry.Handle(api, method, path, op.permission, handler)
		}
	}
}
func ip(r *http.Request) string {
	if os.Getenv("NEXO_TRUST_PROXY") == "1" && r.Header.Get("X-Forwarded-For") != "" {
		return strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}
func cookie(r *http.Request, token string) string {
	age := 0
	if token != "" {
		age = 43200
	}
	secure := ""
	if os.Getenv("NEXO_COOKIE_SECURE") == "1" || r.Header.Get("X-Forwarded-Proto") == "https" {
		secure = "; Secure"
	}
	return fmt.Sprintf("nexo_session=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d%s", token, age, secure)
}
func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}
func (s Service) login(ctx context.Context, r *http.Request, b map[string]any) (endpoint.Result, error) {
	const key = "POST /api/auth/login"
	email := strings.ToLower(b["email"].(string))
	address := ip(r)
	wait := float64(0)
	err := s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		for _, limit := range []struct {
			key string
			n   int
		}{{"email:" + email, 8}, {"ip:" + address, 40}} {
			row, err := one(ctx, tx, "helper:throttle", 0, limit.key, limit.n)
			if err != nil {
				return err
			}
			wait = math.Max(wait, number(row.Get("s")))
		}
		return nil
	})
	if err != nil {
		return endpoint.Result{}, err
	}
	if wait > 0 {
		return endpoint.Result{}, apierr.New(429, fmt.Sprintf("muitas tentativas; aguarde %.0f minuto(s)", math.Ceil(wait/60)))
	}
	var u jsonx.Object
	err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { var err error; u, err = one(ctx, tx, key, 0, b["email"]); return err })
	if err != nil {
		return endpoint.Result{}, err
	}
	ok := u != nil && u.Get("active") == true && (u.Get("tenant_status") == nil || u.Get("tenant_status") == "active") && cryptox.VerifyPassword(b["password"].(string), u.Get("password_hash").(string))
	if ok && u.Get("mfa_enabled") == true {
		if !jsonx.Truthy(b["code"]) {
			return endpoint.Result{}, &apierr.Error{Status: 401, Message: "informe o código de verificação", Code: "mfa_required"}
		}
		secret, err := cryptox.DecryptSecret(u.Get("mfa_secret_enc").(string))
		if err != nil {
			return endpoint.Result{}, err
		}
		ok = cryptox.CheckTOTP(b["code"].(string), secret)
	}
	var c *auth.Ctx
	if u != nil {
		c = &auth.Ctx{UserID: u.Get("id").(string)}
		if u.Get("tenant_id") != nil {
			c.TenantID = u.Get("tenant_id").(string)
			c.Scope = tenancy.Scope{TenantID: c.TenantID}
		} else {
			c.Scope, _ = tenancy.OperatorScope("auditoria_negativa")
		}
	}
	if !ok {
		err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
			for _, k := range []string{"email:" + email, "ip:" + address} {
				if err := tx.Exec(ctx, query("helper:failed", 0), k, 600); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		if c != nil {
			if err = s.Audit.Write(ctx, c, "auth.login", "user", c.UserID, nil, "denied"); err != nil {
				return endpoint.Result{}, err
			}
		}
		return endpoint.Result{}, apierr.New(401, "e-mail ou senha inválidos")
	}
	token, err := cryptox.RandomToken(32)
	if err != nil {
		return endpoint.Result{}, err
	}
	err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, query(key, 1), c.UserID, cryptox.SHA256(token)) })
	if err != nil {
		return endpoint.Result{}, err
	}
	if err = s.Audit.Write(ctx, c, "auth.login", "user", c.UserID, nil, "ok"); err != nil {
		return endpoint.Result{}, err
	}
	err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, query("helper:cleared", 0), "email:"+email) })
	return endpoint.Result{Value: map[string]any{"token": token}, Cookie: cookie(r, token)}, err
}
func (s Service) handle(ctx context.Context, r *http.Request, key, id string, b map[string]any) (endpoint.Result, error) {
	if key == "POST /api/auth/login" {
		return s.login(ctx, r, b)
	}
	c := auth.From(ctx)
	if key == "POST /api/auth/logout" {
		err := s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, query(key, 0), c.TokenHash) })
		return endpoint.Result{Value: map[string]any{"ok": true}, Cookie: cookie(r, "")}, err
	}
	if strings.HasPrefix(key, "POST /api/me/") {
		return s.self(ctx, key, b)
	}
	if strings.Contains(key, " /api/support/") {
		return s.support(ctx, key, b)
	}
	var value any
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		var err error
		switch key {
		case "POST /api/tenants":
			t, err := one(ctx, tx, key, 0, b["name"], b["slug"])
			if err != nil {
				return err
			}
			hash, err := cryptox.HashPassword(b["admin_password"].(string))
			if err != nil {
				return err
			}
			if err = tx.Exec(ctx, query(key, 1), t.Get("id"), b["admin_email"], b["admin_name"], hash); err != nil {
				return err
			}
			value = t
			return tx.Exec(ctx, query(key, 2), t.Get("id"), c.UserID)
		case "PATCH /api/tenants/:id":
			t, err := one(ctx, tx, key, 0, id, b["name"], b["status"], b["modules"])
			if err != nil {
				return err
			}
			if t == nil {
				return apierr.New(404, "provedor não encontrado")
			}
			raw, err := json.Marshal(b)
			if err != nil {
				return err
			}
			value = t
			return tx.Exec(ctx, query(key, 1), id, c.UserID, raw)
		case "POST /api/users":
			hash, err := cryptox.HashPassword(b["password"].(string))
			if err != nil {
				return err
			}
			u, err := one(ctx, tx, key, 0, c.TenantID, b["email"], b["name"], hash, b["role"])
			if err != nil {
				return err
			}
			value = u
			return audit.InTx(ctx, tx, c, "user.create", "user", u.Get("id"), map[string]any{"role": b["role"]}, "ok")
		case "PATCH /api/users/:id":
			if id == c.UserID && (b["active"] == false || b["role"] != nil && b["role"] != "admin") {
				return apierr.New(400, "você não pode remover o próprio acesso de administrador")
			}
			var hash any
			if b["password"] != nil {
				hash, err = cryptox.HashPassword(b["password"].(string))
				if err != nil {
					return err
				}
			}
			u, err := one(ctx, tx, key, 0, id, c.TenantID, b["name"], b["role"], b["active"], hash)
			if err != nil {
				return err
			}
			if u == nil {
				return apierr.New(404, "usuário não encontrado")
			}
			if b["reset_mfa"] == true {
				if err = tx.Exec(ctx, query(key, 1), id, c.TenantID); err != nil {
					return err
				}
			}
			detail := map[string]any{"password_changed": b["password"] != nil, "mfa_reset": b["reset_mfa"] == true}
			for _, k := range []string{"name", "role", "active"} {
				if v, ok := b[k]; ok {
					detail[k] = v
				}
			}
			value = u
			return audit.InTx(ctx, tx, c, "user.update", "user", id, detail, "ok")
		}
		return fmt.Errorf("rota de identidade desconhecida")
	})
	return endpoint.Result{Value: value}, err
}
