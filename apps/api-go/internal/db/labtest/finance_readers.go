package labtest

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// FinanceReadersTransaction opens a dedicated laboratory connection for the
// R08/R09 temporary financial relations. It accepts only nexo_test as nexo_go;
// it never uses an owner connection or the application's pool. The test owns
// the transaction until cleanup, which always rolls back and closes it.
// No server should import this laboratory helper.
func FinanceReadersTransaction(t *testing.T, rawURL string) (context.Context, pgx.Tx) {
	t.Helper()
	cfg, err := pgx.ParseConfig(rawURL)
	if err != nil || cfg.Database != labDatabase || cfg.User != "nexo_go" {
		t.Fatal("fixture requires disposable nexo_test as nexo_go")
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 15 * time.Second
	}
	ctx := context.Background()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal("cannot connect to disposable PostgreSQL (details redacted)")
	}
	// Register immediately so identity/begin failures also close the connection.
	// Cleanup has its own context, independent of fixture query cancellation.
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = conn.Close(cleanupCtx)
	})
	var database, sessionUser, currentUser string
	if err := conn.QueryRow(ctx, identitySQL).Scan(&database, &sessionUser, &currentUser); err != nil || database != labDatabase || sessionUser != "nexo_go" || currentUser != "nexo_go" {
		t.Fatal("unexpected database or effective role; fixture refused")
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal("cannot begin synthetic fixture")
	}
	// Cleanups run in reverse order: rollback precedes connection close, even
	// when a fixture assertion calls Fatal or a subtest fails.
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
	})
	return ctx, tx
}
