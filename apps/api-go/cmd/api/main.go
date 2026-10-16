package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"nexoisp/api-go/internal/agent"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/config"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jobs"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/cadastro"
	"nexoisp/api-go/internal/modules/escrita"
	"nexoisp/api-go/internal/modules/identity"
	"nexoisp/api-go/internal/modules/leitura"
	_ "time/tzdata"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if err := run(); err != nil {
		slog.Error("API encerrada", "error", err)
		os.Exit(1)
	}
}
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	shutdownTelemetry, err := httpx.Telemetry(ctx)
	if err != nil {
		return err
	}
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTelemetry(shutdown)
	}()
	reg := prometheus.NewRegistry()
	database, err := db.Open(ctx, cfg.URL, cfg.Plan, cfg.Pool, reg)
	if err != nil {
		return err
	}
	defer database.Close()
	authentication, err := auth.New(auth.DBLoader{DB: database}, cfg.TTL, cfg.RequireMFA, cfg.Rate, reg)
	if err != nil {
		return err
	}
	defer authentication.Close()
	auditor := audit.Writer{DB: database}
	authentication.Audit = auditor.Write
	listenerDone := make(chan struct{})
	go func() {
		defer close(listenerDone)
		database.Listen(ctx, authentication.Invalidate, authentication.State)
	}()
	defer func() { cancel(); <-listenerDone }()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(reg))
	registry := endpoint.New(authentication)
	registry.Protect("GET", "/api/subscribers", "subscribers:read", false)
	registry.Protect("GET", "/api/subscribers/{id}", "subscribers:read", false)
	registry.Protect("GET", "/api/contracts/{id}", "contracts:read", false)
	router.Use(registry.Middleware)
	router.NotFound(func(w http.ResponseWriter, r *http.Request) { apierr.Write(w, apierr.New(404, "rota não encontrada")) })
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	hc := huma.DefaultConfig("NexoISP Go", "1.0.0")
	hc.CreateHooks = nil
	hc.OpenAPIPath = ""
	hc.DocsPath = ""
	hc.SchemasPath = ""
	hc.Formats = map[string]huma.Format{"application/json": {Marshal: jsonx.Marshal, Unmarshal: json.Unmarshal}, "json": {Marshal: jsonx.Marshal, Unmarshal: json.Unmarshal}}
	api := humachi.New(router, hc)
	cadastro.Register(api, cadastro.Service{DB: database}, auditor)
	leitura.Register(api, registry, leitura.Service{DB: database, Audit: auditor, RequireMFA: cfg.RequireMFA})
	escrita.Register(api, registry, escrita.Service{DB: database})
	escrita.RegisterPublic(api, registry, escrita.Service{DB: database})
	escrita.RegisterGateway(api, registry, escrita.Service{DB: database})
	identity.Register(api, registry, identity.Service{DB: database, Audit: auditor})
	registry.PublicGet(api, "/api/health", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		if err := database.Verify(ctx); err != nil {
			return endpoint.Result{Status: 503, Value: map[string]any{"ok": false, "db": "indisponível"}}, nil
		}
		return endpoint.Result{Value: map[string]any{"ok": true, "db": "ok", "demo": os.Getenv("NEXO_DEMO_MODE") == "1"}}, nil
	})
	internal := http.NewServeMux()
	internal.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	internal.HandleFunc("/openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.OpenAPI())
	})
	internal.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := database.Verify(r.Context()); err != nil {
			apierr.Write(w, apierr.New(503, "banco indisponível"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	servers := []*http.Server{{Addr: cfg.Addr, Handler: router, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}, {Addr: cfg.InternalAddr, Handler: internal, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}}
	stopJobs, err := jobs.Start(ctx, database)
	if err != nil {
		return err
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = stopJobs(stopCtx)
	}()
	agentServer, err := agent.Server(database)
	if err != nil {
		return err
	}
	if agentServer != nil {
		servers = append(servers, agentServer)
	}
	fail := make(chan error, len(servers))
	for _, s := range servers {
		go func() {
			slog.Info("HTTP iniciado", "addr", s.Addr)
			if s.TLSConfig != nil {
				fail <- s.ListenAndServeTLS("", "")
			} else {
				fail <- s.ListenAndServe()
			}
		}()
	}
	select {
	case <-ctx.Done():
	case err = <-fail:
		cancel()
	}
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
