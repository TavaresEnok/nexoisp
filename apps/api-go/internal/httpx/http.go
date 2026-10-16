package httpx

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/requestctx"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

type requestKey struct{}
type responseKey struct{}

func Header(ctx context.Context, name, value string) {
	if w, ok := ctx.Value(responseKey{}).(http.ResponseWriter); ok {
		w.Header().Set(name, value)
	}
}

type routeKey struct{}
type routeLabel struct{ value string }

func SetRoute(ctx context.Context, route string) {
	if state := requestctx.From(ctx); state != nil {
		state.Route = route
	}
	if label, ok := ctx.Value(routeKey{}).(*routeLabel); ok {
		label.value = route
	}
}

func Request(ctx context.Context) *http.Request {
	r, _ := ctx.Value(requestKey{}).(*http.Request)
	return r
}

type writer struct {
	http.ResponseWriter
	status int
}

func (w *writer) WriteHeader(n int) { w.status = n; w.ResponseWriter.WriteHeader(n) }
func (w *writer) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(p)
}
func (w *writer) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func Security(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("x-content-type-options", "nosniff")
	if h.Get("x-frame-options") == "" {
		h.Set("x-frame-options", "DENY")
	}
	h.Set("referrer-policy", "same-origin")
	h.Set("permissions-policy", "camera=(), microphone=(), geolocation=(self), payment=()")
	if os.Getenv("NEXO_COOKIE_SECURE") == "1" || r.Header.Get("X-Forwarded-Proto") == "https" {
		h.Set("strict-transport-security", "max-age=31536000")
	}
}
func Middleware(reg prometheus.Registerer) func(http.Handler) http.Handler {
	latency := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "nexo_http_request_seconds", Buckets: prometheus.DefBuckets}, []string{"route", "status", "cell"})
	reg.MustRegister(latency)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			label := &routeLabel{}
			state := &requestctx.State{RequestID: uuid.NewString()}
			ctx, span := otel.Tracer("nexo.http").Start(r.Context(), r.Method)
			ctx = context.WithValue(ctx, requestctx.Key{}, state)
			Security(w, r)
			w.Header().Set("X-Request-Id", state.RequestID)
			sw := &writer{ResponseWriter: w}
			defer func() {
				if v := recover(); v != nil {
					slog.Error("panic HTTP", "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
					apierr.Write(sw, apierr.New(500, "erro interno"))
				}
				status := sw.status
				if status == 0 {
					status = 200
				}
				route := r.URL.Path
				if route != "/api/subscribers" {
					if strings.HasPrefix(route, "/api/subscribers/") {
						route = "/api/subscribers/:id"
					} else if strings.HasPrefix(route, "/api/contracts/") {
						route = "/api/contracts/:id"
					} else {
						route = "other"
					}
				}
				if label.value != "" {
					route = label.value
				}
				latency.WithLabelValues(route, fmt.Sprint(status), "c1").Observe(time.Since(start).Seconds())
				span.SetAttributes(attribute.String("http.route", route), attribute.Int("http.response.status_code", status))
				if status >= 500 {
					span.SetStatus(codes.Error, "HTTP 5xx")
				}
				span.End()
				slog.Info("requisição HTTP", "request_id", state.RequestID, "route", route, "method", r.Method, "status", status, "duration_ms", float64(time.Since(start).Microseconds())/1000, "tenant_id", state.TenantID, "user_id", state.UserID, "cell", "c1")
			}()
			ctx = context.WithValue(ctx, requestKey{}, r)
			ctx = context.WithValue(ctx, routeKey{}, label)
			ctx = context.WithValue(ctx, responseKey{}, sw)
			next.ServeHTTP(sw, r.WithContext(ctx))
		})
	}
}
