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

func TestTenantLockDoesNotBlockAnotherTenant(t *testing.T) {
	d := integrationDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	first, err := d.TryTenantWorkerLock(ctx, "tenant-a", func() error {
		acquired, err := d.TryTenantWorkerLock(ctx, "tenant-a", func() error {
			t.Error("mesmo provedor executou duas vezes")
			return nil
		})
		if err != nil {
			return err
		}
		if acquired {
			t.Error("trava concorrente concedida")
		}
		acquired, err = d.TryTenantWorkerLock(ctx, "tenant-b", func() error {
			return d.WithScope(ctx, tenancy.Scope{}, func(tx *Tx) error { return tx.Exec(ctx, "select 1") })
		})
		if !acquired {
			t.Error("outro provedor ficou bloqueado")
		}
		return err
	})
	if err != nil || !first {
		t.Fatalf("execução inicial: %v, %v", first, err)
	}
	acquired, err := d.TryTenantWorkerLock(ctx, "tenant-a", func() error { return nil })
	if err != nil || !acquired {
		t.Fatalf("trava não liberada: %v", err)
	}
}
