// Package endpoint binds the Huma contract and the authentication policy together.
package endpoint

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

type policy struct {
	permission string
	pending    bool
	public     bool
}
type Registry struct {
	auth     *auth.Auth
	matcher  *chi.Mux
	policies map[string]policy
}

func New(a *auth.Auth) *Registry { return &Registry{a, chi.NewRouter(), map[string]policy{}} }
func (r *Registry) Protect(method, path, permission string, pending bool) {
	key := method + " " + path
	if _, ok := r.policies[key]; ok {
		panic("política duplicada: " + key)
	}
	r.policies[key] = policy{permission: permission, pending: pending}
	r.matcher.MethodFunc(method, path, func(http.ResponseWriter, *http.Request) {})
}
func (r *Registry) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		method := req.Method
		if method == http.MethodHead {
			method = http.MethodGet
		}
		pattern := r.matcher.Find(chi.NewRouteContext(), method, req.URL.Path)
		if pattern == "" {
			next.ServeHTTP(w, req)
			return
		}
		httpx.SetRoute(req.Context(), strings.ReplaceAll(strings.ReplaceAll(pattern, "{", ":"), "}", ""))
		p := r.policies[method+" "+pattern]
		handler := next
		if req.Method == http.MethodHead {
			handler = http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
				copy := q.Clone(q.Context())
				copy.Method = http.MethodGet
				next.ServeHTTP(w, copy)
			})
		}
		if p.public {
			handler.ServeHTTP(w, req)
			return
		}
		ctx := auth.WithRoute(req.Context(), strings.ReplaceAll(strings.ReplaceAll(pattern, "{", ":"), "}", ""))
		r.auth.Require(p.permission, p.pending, handler).ServeHTTP(w, req.WithContext(ctx))
	})
}

type Result struct {
	Value                                    any
	Total                                    string
	CSV                                      []byte
	Filename                                 string
	Status                                   int
	ContentType, CacheControl, CSP, Referrer string
	Raw                                      []byte
	Cookie                                   string
	Disposition                              string
}
type output struct {
	Cookie       string `header:"Set-Cookie"`
	ContentType  string `header:"Content-Type"`
	Total        string `header:"X-Total-Count"`
	Disposition  string `header:"Content-Disposition"`
	Body         []byte
	Status       int
	CacheControl string `header:"Cache-Control"`
	CSP          string `header:"Content-Security-Policy"`
	Referrer     string `header:"Referrer-Policy"`
}
type Handler func(context.Context, *http.Request) (Result, error)

func (r *Registry) Get(api huma.API, path, permission string, pending bool, handler Handler) {
	r.register(api, http.MethodGet, path, permission, pending, false, handler)
}
func (r *Registry) PublicGet(api huma.API, path string, handler Handler) {
	r.register(api, http.MethodGet, path, "", false, true, handler)
}
func (r *Registry) Handle(api huma.API, method, path, permission string, handler Handler) {
	r.register(api, method, path, permission, false, false, handler)
}
func (r *Registry) PublicHandle(api huma.API, method, path string, handler Handler) {
	r.register(api, method, path, "", false, true, handler)
}
func (r *Registry) Pending(api huma.API, method, path string, handler Handler) {
	r.register(api, method, path, "", true, false, handler)
}
func (r *Registry) register(api huma.API, method, path, permission string, pending, public bool, handler Handler) {
	r.Protect(method, path, permission, pending)
	key := method + " " + path
	p := r.policies[key]
	p.public = public
	r.policies[key] = p
	huma.Register(api, huma.Operation{OperationID: strings.ToLower(method) + "-" + strings.NewReplacer("/", "-", "{", "", "}", "").Replace(path), Method: method, Path: path, SkipValidateParams: true, SkipValidateBody: true}, func(ctx context.Context, _ *struct{}) (*output, error) {
		result, err := handler(ctx, httpx.Request(ctx))
		if err != nil {
			return nil, err
		}
		out := &output{ContentType: "application/json; charset=utf-8", Total: result.Total, Status: result.Status, CacheControl: result.CacheControl, CSP: result.CSP, Referrer: result.Referrer, Cookie: result.Cookie, Disposition: result.Disposition}
		if out.Status == 0 {
			out.Status = http.StatusOK
		}
		if result.Raw != nil {
			out.Body = result.Raw
			out.ContentType = result.ContentType
		} else if result.CSV != nil {
			out.Body = result.CSV
			out.ContentType = "text/csv; charset=utf-8"
			out.Disposition = fmt.Sprintf(`attachment; filename="%s"`, result.Filename)
		} else {
			out.Body, err = jsonx.Encode(result.Value)
		}
		return out, err
	})
}
