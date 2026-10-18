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
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	database, e := db.Open(ctx, os.Getenv("DATABASE_URL_GO"), "force_custom_plan", 4, prometheus.NewRegistry())
	if e == nil {
		defer database.Close()
		e = vpn.Run(ctx, database)
	}
	if e != nil {
		slog.Error("VPN encerrada", "error", e)
		os.Exit(1)
	}
}
