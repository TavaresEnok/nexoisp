package db

import (
	"context"
	"nexoisp/api-go/internal/tenancy"
	"testing"
	"time"
)

func TestWorkerLockWithSingleConnectionPool(t *testing.T) {
	d := integrationDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := d.WithWorkerLock(ctx, 7411999, func() error {
		return d.WithScope(ctx, tenancy.Scope{}, func(tx *Tx) error { return tx.Exec(ctx, "select 1") })
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = d.WithWorkerLock(ctx, 7411999, func() error { return nil }); err != nil {
		t.Fatalf("trava não liberada: %v", err)
	}
}
