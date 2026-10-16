package httpx

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"go.opentelemetry.io/otel"
)

type requestKey struct{}

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
			Security(w, r)
			w.Header().Set("X-Request-Id", uuid.NewString())
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
				latency.WithLabelValues(route, fmt.Sprint(status), "c1").Observe(time.Since(start).Seconds())
			}()
			ctx, span := otel.Tracer("nexo.http").Start(r.Context(), r.Method)
			defer span.End()
			ctx = context.WithValue(ctx, requestKey{}, r)
			next.ServeHTTP(sw, r.WithContext(ctx))
		})
	}
}
