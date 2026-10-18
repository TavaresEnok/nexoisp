package db

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"os"
)

// Prepare adopts a complete pre-Go database or initializes a fresh one; never resets data.
func Prepare(ctx context.Context, root string) error {
	if e := Admin(ctx, "bootstrap", root, true); e != nil {
		return e
	}
	cfg, e := pgx.ParseConfig(os.Getenv("DATABASE_URL_OWNER"))
	if e != nil {
		return e
	}
	c := stdlib.OpenDB(*cfg)
	var legacy, goose bool
	e = c.QueryRowContext(ctx, `select to_regclass('public.schema_migrations') is not null,to_regclass('public.goose_db_version') is not null`).Scan(&legacy, &goose)
	_ = c.Close()
	if e != nil {
		return e
	}
	if legacy && !goose {
		if e = Admin(ctx, "baseline", root, false); e != nil {
			return fmt.Errorf("adoção recusada: %w", e)
		}
	}
	if e = Admin(ctx, "up", root, false); e != nil {
		return e
	}
	if e = JobsMigrate(ctx, os.Getenv("DATABASE_URL_OWNER")); e != nil {
		return e
	}
	return Admin(ctx, "verificar", root, false)
}
