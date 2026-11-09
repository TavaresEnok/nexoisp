package main

import (
	"context"
	"github.com/prometheus/client_golang/prometheus"
	"log/slog"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/vpn"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const (
	dbRetryInitial = 2 * time.Second
	dbRetryMax     = time.Minute
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	database, e := waitFor(ctx, dbRetryInitial, dbRetryMax, func(ctx context.Context) (*db.DB, error) {
		return db.Open(ctx, os.Getenv("DATABASE_URL_GO"), "force_custom_plan", 4, prometheus.NewRegistry())
	})
	if e == nil {
		defer database.Close()
		e = vpn.Run(ctx, database)
	}
	if e != nil && ctx.Err() == nil {
		slog.Error("VPN encerrada", "error", e)
		os.Exit(1)
	}
}

// waitFor insiste em open com espera crescente até obter sucesso ou ctx ser
// cancelado. Banco indisponível na partida não encerra o processo: com
// restart: unless-stopped, encerrar faria o Docker reiniciar o container
// indefinidamente enquanto o banco estivesse fora.
func waitFor[T any](ctx context.Context, initial, max time.Duration, open func(context.Context) (T, error)) (T, error) {
	delay := initial
	for attempt := 1; ; attempt++ {
		value, e := open(ctx)
		if e == nil {
			if attempt > 1 {
				slog.Info("banco disponível; VPN iniciando", "tentativas", attempt)
			}
			return value, nil
		}
		if ctx.Err() != nil {
			return value, ctx.Err()
		}
		slog.Error("banco indisponível; aguardando para tentar de novo", "tentativa", attempt, "espera", delay.String(), "error", e)
		select {
		case <-ctx.Done():
			return value, ctx.Err()
		case <-time.After(delay):
		}
		if delay *= 2; delay > max {
			delay = max
		}
	}
}
