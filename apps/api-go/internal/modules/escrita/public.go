package escrita

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

var publicScopes = []string{"subscribers:read", "contracts:read", "invoices:read", "tickets:write", "work_orders:read", "work_orders:write"}

func RegisterPublic(api huma.API, registry *endpoint.Registry, s Service) {
	routes := map[string]string{"GET /public/v1": "", "GET /public/v1/subscribers": "subscribers:read", "GET /public/v1/subscribers/:id": "subscribers:read", "GET /public/v1/contracts": "contracts:read", "GET /public/v1/invoices": "invoices:read", "POST /public/v1/tickets": "tickets:write", "POST /public/v1/work-orders": "work_orders:write", "GET /public/v1/work-orders/:id": "work_orders:read"}
	for key, scope := range routes {
		method, path, _ := strings.Cut(key, " ")
		registry.PublicHandle(api, method, strings.ReplaceAll(path, ":id", "{id}"), func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			if scope == "" {
				return endpoint.Result{Value: map[string]any{"version": "v1", "scopes": publicScopes, "docs": "docs/api-publica.md"}}, nil
			}
			token, err := s.publicAuth(ctx, r, scope)
			if err != nil {
				return endpoint.Result{}, err
			}
			ctx = auth.With(ctx, &auth.Ctx{TenantID: token.Get("tenant_id").(string), Scope: tenancy.Scope{TenantID: token.Get("tenant_id").(string)}})
			id := chi.URLParam(r, "id")
			if strings.Contains(path, ":id") {
				if err = validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			if method == "POST" {
				return s.publicWrite(ctx, r, key, token)
			}
			q := validate.Query{Values: r.URL.Query()}
			var args []any
			switch path {
			case "/public/v1/subscribers":
				a := q.BoundedString("q", true, 2, 100)
				b := q.BoundedString("document", true, 0, 20)
				args = []any{publicOptional(q, "q", a), publicOptional(q, "document", b)}
			case "/public/v1/contracts":
				a := q.UUID("subscriber_id", false)
				b := q.Enum("status", "", "active", "ended")
				args = []any{publicOptional(q, "subscriber_id", a), publicOptional(q, "status", b)}
			case "/public/v1/invoices":
				a := q.UUID("subscriber_id", false)
				b := q.UUID("contract_id", false)
				c := q.Enum("status", "", "open", "paid", "canceled", "reconciling")
				args = []any{publicOptional(q, "subscriber_id", a), publicOptional(q, "contract_id", b), publicOptional(q, "status", c)}
			}
			p := validate.Page{}
			if id == "" {
				p = q.Page()
			}
			if err = q.Err(); err != nil {
				return endpoint.Result{}, err
			}
			var result endpoint.Result
			err = s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				if id != "" {
					message := "assinante não encontrado"
					if strings.Contains(path, "work-orders") {
						message = "ordem de serviço não encontrada"
					}
					value, e := mustRow(ctx, tx, key, 0, message, id)
					result.Value = firstObject(value)
					return e
				}
				limit := 500
				if p.HasLimit {
					limit = min(p.Limit, 500)
				}
				sql := query(key, 0)
				value, e := tx.Objects(ctx, fmt.Sprintf("select x.* from (%s) x limit %d offset %g", sql, limit, p.Offset), args...)
				if e != nil {
					return e
				}
				total := int64(len(value))
				if p.Offset != 0 || len(value) >= limit {
					if e = tx.QueryRow(ctx, "select count(*) from ("+sql+") x", args...).Scan(&total); e != nil {
						return e
					}
				}
				result.Value = value
				result.Total = fmt.Sprint(total)
				return nil
			})
			return result, err
		})
	}
}
func publicOptional(q validate.Query, key, value string) any {
	if _, ok := q.Values[key]; ok {
		return value
	}
	return nil
}
func publicStrings(v any) []string {
	if a, ok := v.([]string); ok {
		return a
	}
	a, _ := v.([]any)
	out := []string{}
	for _, s := range a {
		out = append(out, fmt.Sprint(s))
	}
	return out
}
func publicError(status int, message, code string) error {
	return &apierr.Error{Status: status, Message: message, Code: code}
}
func (s Service) publicAuth(ctx context.Context, r *http.Request, scope string) (jsonx.Object, error) {
	const key = "helper:guardApi"
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if os.Getenv("NEXO_TRUST_PROXY") == "1" && r.Header.Get("X-Forwarded-For") != "" {
		ip = strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
	}
	throttle := "apikey:ip:" + ip
	var token jsonx.Object
	err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		row, e := one(ctx, tx, key, 0, throttle, 30)
		if e != nil {
			return e
		}
		if wait := num(row.Get("s")); wait > 0 {
			httpx.Header(ctx, "retry-after", fmt.Sprint(wait))
			return publicError(429, "muitas tentativas com token inválido; aguarde", "rate_limited")
		}
		raw := r.Header.Get("X-API-Key")
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			raw = h[7:]
		}
		if !strings.HasPrefix(raw, "nxk_") {
			return nil
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	rawKey := r.Header.Get("X-API-Key")
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		rawKey = h[7:]
	}
	if strings.HasPrefix(rawKey, "nxk_") {
		found, _, e := s.DB.Lookup(ctx, query(key, 2), cryptox.SHA256(rawKey))
		if e != nil {
			return nil, e
		}
		if len(found) > 0 {
			token = found[0]
		}
	}
	if token == nil {
		if err = s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, query(key, 1), throttle, 600) }); err != nil {
			return nil, err
		}
		message := "token ausente, inválido, expirado ou revogado"
		raw := r.Header.Get("X-API-Key")
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			raw = h[7:]
		}
		if !strings.HasPrefix(raw, "nxk_") {
			message = "token ausente ou inválido"
		}
		return nil, apierr.New(401, message)
	}
	if !slices.Contains(publicStrings(token.Get("modules")), "api") {
		return nil, publicError(403, "a API pública não está liberada para o provedor", "module_disabled")
	}
	if !slices.Contains(publicStrings(token.Get("scopes")), scope) {
		return nil, publicError(403, "o token não tem o escopo "+scope, "scope_missing")
	}
	var calls float64
	err = s.DB.WithScope(ctx, tenancy.Scope{TenantID: token.Get("tenant_id").(string)}, func(tx *db.Tx) error {
		row, e := one(ctx, tx, key, 3, token.Get("tenant_id"), token.Get("token_id"))
		if e != nil {
			return e
		}
		calls = num(row.Get("n"))
		last, _ := time.Parse(time.RFC3339Nano, nocTime(token.Get("last_used_at")))
		if last.IsZero() || time.Since(last) > time.Minute {
			return tx.Exec(ctx, query(key, 4), token.Get("token_id"))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	limit := num(token.Get("rate_limit_per_min"))
	httpx.Header(ctx, "x-ratelimit-limit", fmt.Sprint(limit))
	httpx.Header(ctx, "x-ratelimit-remaining", fmt.Sprint(max(0, limit-calls)))
	if calls > limit {
		httpx.Header(ctx, "retry-after", fmt.Sprint(60-time.Now().Second()))
		return nil, publicError(429, "limite de chamadas por minuto excedido", "rate_limited")
	}
	return token, nil
}
func (s Service) publicWrite(ctx context.Context, r *http.Request, key string, token jsonx.Object) (endpoint.Result, error) {
	f, o, str, e := validate.F, validate.Object, validate.String, validate.Enum
	uuid := str().UUID()
	schema := o(f("subscriber_id", uuid), f("contract_id", uuid.Nullish()), f("subject", str().Trimmed().Min(3).Max(200)), f("category", e("technical", "financial", "commercial", "other")), f("priority", e("low", "normal", "high").Def("normal")), f("body", str().Trimmed().Min(1).Max(4000)))
	if strings.HasSuffix(key, "work-orders") {
		schema = o(f("kind", e("install", "repair", "address_change", "removal", "other")), f("subscriber_id", uuid), f("contract_id", uuid.Nullish()), f("description", str().Trimmed().Min(1).Max(2000)), f("scheduled_for", str().Refine(validDateTime, "Invalid datetime").Nullish()))
	}
	var raw any
	if err := apierr.DecodeJSON(r, &raw); err != nil {
		return endpoint.Result{}, err
	}
	b, err := schema.Parse(raw, true)
	if err != nil {
		return endpoint.Result{}, err
	}
	idem, present := r.Header["Idempotency-Key"]
	ik := ""
	if present {
		ik = strings.Join(idem, ",")
		n := len(utf16.Encode([]rune(ik)))
		if n < 1 || n > 64 {
			return endpoint.Result{}, apierr.New(400, "Idempotency-Key deve ter de 1 a 64 caracteres")
		}
	}
	result := endpoint.Result{Status: 201}
	c := auth.From(ctx)
	err = s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		if ik != "" {
			if e := tx.Exec(ctx, query("helper:idempotent", 0), fmt.Sprint(token.Get("token_id"))+":"+ik); e != nil {
				return e
			}
			prev, e := one(ctx, tx, "helper:idempotent", 1, token.Get("token_id"), ik)
			if e != nil {
				return e
			}
			if prev != nil {
				httpx.Header(ctx, "idempotent-replay", "true")
				result.Status = int(num(prev.Get("status")))
				result.Value = prev.Get("response")
				return nil
			}
		}
		var row jsonx.Object
		var e error
		action, entity := "ticket.create", "ticket"
		detail := map[string]any{"via": "api", "token": token.Get("name")}
		if strings.HasSuffix(key, "tickets") {
			found, e := one(ctx, tx, key, 0, b["subscriber_id"])
			if e != nil {
				return e
			}
			if found == nil {
				return apierr.New(400, "assinante não encontrado")
			}
			if b["contract_id"] != nil {
				found, e = one(ctx, tx, key, 1, b["contract_id"], b["subscriber_id"])
				if e != nil {
					return e
				}
				if found == nil {
					return apierr.New(400, "o contrato não pertence a este assinante")
				}
			}
			b["origin"] = "api"
			row, e = openTicket(ctx, tx, b)
			if e != nil {
				return e
			}
			e = domain.QueueNotice(ctx, tx, c.TenantID, "ticket.opened", fmt.Sprintf("novo atendimento pela API (%v) — protocolo %v: %v", token.Get("name"), row.Get("number"), b["subject"]), map[string]any{"ticket_id": row.Get("id"), "number": row.Get("number")})
			if e != nil {
				return e
			}
		} else {
			b["estimated_minutes"] = float64(60)
			b["address_origin"] = "subscriber"
			row, e = createWork(ctx, tx, b)
			if e != nil {
				return e
			}
			action, entity = "work_order.create", "work_order"
			detail["kind"] = b["kind"]
		}
		detail["number"] = row.Get("number")
		encoded, e := jsonx.Encode(detail)
		if e != nil {
			return e
		}
		if e = tx.Exec(ctx, `insert into audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,result,detail) values ($1,'api',$2,$3,$4,$5,'ok',$6)`, c.TenantID, token.Get("token_id"), action, entity, row.Get("id"), encoded); e != nil {
			return e
		}
		result.Value = map[string]any{"id": row.Get("id"), "number": row.Get("number"), "status": row.Get("status"), "sla_due_at": row.Get("sla_due_at")}
		if ik != "" {
			encoded, e = jsonx.Encode(result.Value)
			if e != nil {
				return e
			}
			return tx.Exec(ctx, query("helper:idempotent", 2), c.TenantID, token.Get("token_id"), ik, encoded)
		}
		return nil
	})
	return result, err
}
