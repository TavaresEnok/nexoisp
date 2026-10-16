package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/riverdriver"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

// River uses an isolated schema. Business data still goes through WithScope.
func (d *DB) JobsDriver() riverdriver.Driver[pgx.Tx] { return riverpgxv5.New(d.pool) }
func JobsMigrate(ctx context.Context, ownerURL string) error {
	if ownerURL == "" {
		return fmt.Errorf("DATABASE_URL_OWNER obrigatória")
	}
	pool, e := pgxpool.New(ctx, ownerURL)
	if e != nil {
		return e
	}
	defer pool.Close()
	if _, e = pool.Exec(ctx, "create schema if not exists nexo_jobs; revoke all on schema nexo_jobs from public"); e != nil {
		return e
	}
	m, e := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: "nexo_jobs"})
	if e != nil {
		return e
	}
	if _, e = m.Migrate(ctx, rivermigrate.DirectionUp, nil); e != nil {
		return e
	}
	_, e = pool.Exec(ctx, `revoke all on all tables in schema nexo_jobs from public,nexo_app; grant usage on schema nexo_jobs to nexo_go; grant all on all tables in schema nexo_jobs to nexo_go; grant usage,select on all sequences in schema nexo_jobs to nexo_go`)
	return e
}

// WithWorkerLock shares the legacy session lock during coexistence.
func (d *DB) WithWorkerLock(ctx context.Context, key int64, fn func() error) error {
	c, e := d.pool.Acquire(ctx)
	if e != nil {
		return e
	}
	defer c.Release()
	if _, e = c.Exec(ctx, "select pg_advisory_lock($1)", key); e != nil {
		return e
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		_, _ = c.Exec(cleanup, "select pg_advisory_unlock($1)", key)
	}()
	return fn()
}
