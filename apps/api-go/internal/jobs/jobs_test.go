package jobs

import (
	"context"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
	"os"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Real River workers and scoped SQL: a broken timezone must not starve a peer.
func TestTenantFailureAndRestart(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL não definido")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	reg := prometheus.NewRegistry()
	database, err := db.Open(ctx, url, "force_custom_plan", 4, reg)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var disposable bool
	if err = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, "select current_database()='nexo_test'").Scan(&disposable)
	}); err != nil || !disposable {
		t.Fatalf("este teste exige o banco descartável nexo_test: %v", err)
	}
	var tenants []string
	if err = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, "select tenant_id from worker_tenants() order by tenant_id limit 2")
		for _, row := range rows {
			tenants = append(tenants, row.Get("tenant_id").(string))
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if len(tenants) != 2 {
		t.Fatal("base descartável com dois provedores exigida")
	}
	for i, tenant := range tenants {
		zone := "UTC"
		if i == 0 {
			zone = "Invalid/Timezone"
		}
		if err = database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			return tx.Exec(ctx, `insert into tenant_settings(tenant_id,billing_auto,timezone) values($1,true,$2)
    on conflict(tenant_id) do update set billing_auto=true,timezone=excluded.timezone`, tenant, zone)
		}); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("NEXO_GO_JOBS", "1")
	t.Setenv("NEXO_GO_JOB_BILLING", "1")
	stop, err := Start(ctx, database, reg)
	if err != nil {
		t.Fatal(err)
	}
	stopped := false
	defer func() {
		if !stopped {
			_ = stop(context.Background())
		}
	}()
	waitState := func(tenant string, states ...string) {
		t.Helper()
		for ctx.Err() == nil {
			found := false
			err := database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
				return tx.QueryRow(ctx, `select exists(select 1 from nexo_jobs.river_job
     where kind='nexo_periodic' and args->>'task'='BILLING' and args->>'tenant_id'=$1 and state::text=any($2::text[]))`, tenant, states).Scan(&found)
			})
			if err != nil {
				t.Fatal(err)
			}
			if found {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("provedor não alcançou estados %v: %v", states, ctx.Err())
	}
	waitState(tenants[0], "retryable", "discarded")
	waitState(tenants[1], "completed")
	// Queue metrics also exercise collection with errored and completed jobs.
	if _, err = reg.Gather(); err != nil {
		t.Fatal(err)
	}
	if err = stop(ctx); err != nil {
		t.Fatal(err)
	}
	stopped = true
	// A second dispatch must preserve the failed tenant's pending retry.
	if err = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.EnqueuePeriodic(ctx, "BILLING", tenants[0]); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `select count(*) from nexo_jobs.river_job where args->>'tenant_id'=$1
   and args->>'task'='BILLING' and state in ('available','running','retryable','scheduled','pending')`, tenants[0]).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			t.Fatalf("retentativa duplicada: %d", n)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = database.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		return tx.Exec(ctx, "update tenant_settings set timezone='UTC' where tenant_id=$1", tenants[0])
	}); err != nil {
		t.Fatal(err)
	}
	if err = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update nexo_jobs.river_job set state='available',scheduled_at=now(),finalized_at=null
   where args->>'tenant_id'=$1 and args->>'task'='BILLING' and state in ('retryable','scheduled','discarded')`, tenants[0])
	}); err != nil {
		t.Fatal(err)
	}
	stop2, err := Start(ctx, database)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stop2(context.Background()) }()
	waitState(tenants[0], "completed")
	if err = database.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var duplicated bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from invoices where competence is not null
   group by contract_id,competence having count(*)>1)`).Scan(&duplicated); err != nil {
			return err
		}
		if duplicated {
			t.Fatal("cobrança duplicada após reinício")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
