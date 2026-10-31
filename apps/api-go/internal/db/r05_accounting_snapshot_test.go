package db_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/radius"
)

func TestR05AccountingSnapshot(t *testing.T) {
	dsn, ownerDSN := os.Getenv("NEXO_GO_TEST_DATABASE_URL"), os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if dsn == "" || ownerDSN == "" {
		if os.Getenv("PG_REQUIRED") == "1" {
			t.Fatal("PG_REQUIRED=1 exige NEXO_GO_TEST_DATABASE_URL e NEXO_GO_TEST_DATABASE_OWNER_URL")
		}
		t.Skip("URLs do PostgreSQL descartável ausentes; SKIP não comprova SQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	owner, err := sql.Open("pgx", ownerDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.Close() })
	var name string
	if err = owner.QueryRowContext(ctx, `select current_database()`).Scan(&name); err != nil || name != "nexo_test" {
		t.Fatal("somente nexo_test", name, err)
	}
	database, err := db.Open(ctx, dsn, "force_custom_plan", 12, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var tenant, contract string
	if err = owner.QueryRowContext(ctx, `select tenant_id,id from contracts where status='active' limit 1`).Scan(&tenant, &contract); err != nil {
		t.Fatal("fixture requer contrato ativo", err)
	}
	device, resource, username := uuid.NewString(), uuid.NewString(), "r05-"+uuid.NewString()
	ip := fmt.Sprintf("198.18.%d.%d", int(time.Now().UnixNano()%200)+1, int(time.Now().UnixNano()%200)+1)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := owner.ExecContext(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`insert into devices(id,tenant_id,name,driver,vendor) values($1,$2,$3,'radius','generic')`, device, tenant, username)
	t.Cleanup(func() {
		for _, q := range []string{`delete from usage_hourly where resource_id=$1`, `delete from usage_daily where resource_id=$1`, `delete from usage_monthly where resource_id=$1`, `delete from service_sessions where resource_id=$1`, `delete from service_resources where id=$1`} {
			if _, e := owner.Exec(q, resource); e != nil {
				t.Error("cleanup", e)
			}
		}
		for _, q := range []string{`delete from radius_postauth where tenant_id=$1 and username=$2`, `delete from radius_accounting_events where tenant_id=$1 and username=$2`, `delete from radius_acct where tenant_id=$1 and username=$2`} {
			if _, e := owner.Exec(q, tenant, username); e != nil {
				t.Error("cleanup", e)
			}
		}
		if _, e := owner.Exec(`delete from radius_nas where device_id=$1`, device); e != nil {
			t.Error(e)
		}
		if _, e := owner.Exec(`delete from devices where id=$1`, device); e != nil {
			t.Error(e)
		}
	})
	exec(`insert into radius_nas(device_id,tenant_id,nas_ip,secret) values($1,$2,$3,'synthetic-secret-1234')`, device, tenant, ip)
	// Clone a contract because a resource has a unique contract association.
	var newContract string
	if err = owner.QueryRowContext(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day) select tenant_id,subscriber_id,plan_version_id,due_day from contracts where id=$1 returning id`, contract).Scan(&newContract); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, e := owner.Exec(`delete from contracts where id=$1`, newContract); e != nil {
			t.Error("contract cleanup", e)
		}
	})
	// Cleanup executes LIFO: remove the resource before its contract.
	t.Cleanup(func() {
		_, _ = owner.Exec(`delete from usage_hourly where resource_id=$1`, resource)
		_, _ = owner.Exec(`delete from usage_daily where resource_id=$1`, resource)
		_, _ = owner.Exec(`delete from usage_monthly where resource_id=$1`, resource)
		_, _ = owner.Exec(`delete from service_sessions where resource_id=$1`, resource)
		_, _ = owner.Exec(`delete from service_resources where id=$1`, resource)
	})
	exec(`insert into service_resources(id,tenant_id,contract_id,device_id,pppoe_username,desired_profile) values($1,$2,$3,$4,$5,'synthetic')`, resource, tenant, newContract, device, username)
	base := time.Now().UTC().Add(-time.Minute).Unix()
	ingest := func(kind string, seconds, bytes int64) {
		t.Helper()
		data, _ := json.Marshal(map[string]any{"kind": kind, "timestamp": base + seconds, "seconds": seconds, "unique_id": username, "session_id": username, "username": username, "input": fmt.Sprint(bytes), "output": "0"})
		var result string
		if e := owner.QueryRowContext(ctx, `select radius_record_accounting($1,$2,$3::jsonb)`, tenant, ip, string(data)).Scan(&result); e != nil || result != "applied" {
			t.Fatalf("ingest %s: %s %v", kind, result, e)
		}
	}
	ingest("start", 0, 0)
	ingest("interim-update", 10, 100)
	consumer := &radius.Executor{DB: database}
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	ingest("interim-update", 20, 150)
	// SQL 5 must update this NAS during the consumer transaction; otherwise
	// the historical NAS/queue lock inversion is not exercised.
	exec(`insert into radius_postauth(tenant_id,username,reply,nas_ip) values($1,$2,'Access-Accept',$3)`, tenant, username, ip)
	lock, err := owner.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback()
	if _, err = lock.ExecContext(ctx, `select 1 from service_sessions where resource_id=$1 for update`, resource); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- consumer.Sync(ctx, tenant) }()
	// A blocked upsert proves the statement snapshot exists before the producer commits.
	waitForSnapshot := func() {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			var waiting bool
			err = owner.QueryRowContext(ctx, `select exists(select 1 from pg_stat_activity where application_name='nexo-go' and wait_event_type='Lock' and query like '%with source as materialized%')`).Scan(&waiting)
			if err != nil {
				t.Fatal(err)
			}
			if waiting {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("consumer did not reach snapshot barrier")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitForSnapshot()
	// The producer waits for the NAS lock, held before the consumer freezes
	// the mark. Both transactions must succeed and the update stays pending.
	producerDone := make(chan error, 1)
	go func() {
		data, _ := json.Marshal(map[string]any{"kind": "interim-update", "timestamp": base + 30, "seconds": 30, "unique_id": username, "session_id": username, "username": username, "input": "200", "output": "0"})
		var result string
		e := owner.QueryRowContext(ctx, `select radius_record_accounting($1,$2,$3::jsonb)`, tenant, ip, string(data)).Scan(&result)
		if e == nil && result != "applied" {
			e = fmt.Errorf("ingest: %s", result)
		}
		producerDone <- e
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var waiting bool
		if err = owner.QueryRowContext(ctx, `select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%radius_record_accounting%' and pid <> pg_backend_pid())`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("producer did not wait for consumer")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err = lock.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil {
		t.Fatal(err)
	}
	if err = <-producerDone; err != nil {
		t.Fatal(err)
	}
	// Keep the later long-transaction watermark test independent of the NAS
	// barrier: it deliberately synchronizes before that producer commits.
	exec(`delete from radius_postauth where tenant_id=$1 and username=$2`, tenant, username)
	check := func(want int64) {
		t.Helper()
		var daily, hourly, baseline int64
		e := owner.QueryRowContext(ctx, `select (select coalesce(sum(bytes_in),0) from usage_daily where resource_id=$1),(select coalesce(sum(bytes_in),0) from usage_hourly where resource_id=$1),(select bytes_in from service_sessions where resource_id=$1)`, resource).Scan(&daily, &hourly, &baseline)
		if e != nil || daily != want || hourly != want || baseline != want {
			t.Fatalf("want %d daily/hourly/baseline got %d/%d/%d: %v", want, daily, hourly, baseline, e)
		}
	}
	check(150)
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(200)
	ingest("interim-update", 35, 225)
	lock2, err := owner.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer lock2.Rollback()
	if _, err = lock2.ExecContext(ctx, `select 1 from service_sessions where resource_id=$1 for update`, resource); err != nil {
		t.Fatal(err)
	}
	interrupted, interrupt := context.WithCancel(ctx)
	go func() { result <- consumer.Sync(interrupted, tenant) }()
	waitForSnapshot()
	interrupt()
	if err = <-result; err == nil {
		t.Fatal("cancelled sync succeeded")
	}
	if err = lock2.Commit(); err != nil {
		t.Fatal(err)
	}
	check(200)
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(225)
	ingest("interim-update", 40, 250)
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- (&radius.Executor{DB: database}).Sync(ctx, tenant) }()
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	check(250)
	if err = (&radius.Executor{DB: database}).Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(250)

	// An uncommitted producer can predate the five-second watermark overlap.
	producer, err := owner.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Rollback()
	data, _ := json.Marshal(map[string]any{"kind": "interim-update", "timestamp": base + 50, "seconds": 50, "unique_id": username, "session_id": username, "username": username, "input": "300", "output": "0"})
	var applied string
	if err = producer.QueryRowContext(ctx, `select radius_record_accounting($1,$2,$3::jsonb)`, tenant, ip, string(data)).Scan(&applied); err != nil || applied != "applied" {
		t.Fatalf("pending producer: %s %v", applied, err)
	}
	time.Sleep(6 * time.Second)
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	if err = producer.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(300)

	// Rollback cannot create a durable mark or consumption; multiple commits
	// before a sync coalesce without dropping their cumulative counters.
	rolled, err := owner.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(map[string]any{"kind": "interim-update", "timestamp": base + 60, "seconds": 60, "unique_id": username, "session_id": username, "username": username, "input": "350", "output": "0"})
	if err = rolled.QueryRowContext(ctx, `select radius_record_accounting($1,$2,$3::jsonb)`, tenant, ip, string(data)).Scan(&applied); err != nil || applied != "applied" {
		t.Fatalf("rollback producer: %s %v", applied, err)
	}
	if err = rolled.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(300)
	ingest("interim-update", 60, 350)
	ingest("interim-update", 70, 400)
	if err = (&radius.Executor{DB: database}).Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(400)

	// An unmapped mark remains available after the resource is restored.
	exec(`update service_resources set pppoe_username=$2 where id=$1`, resource, username+"-unmapped")
	ingest("interim-update", 80, 450)
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(400)
	var pending int
	if err = owner.QueryRowContext(ctx, `select count(*) from radius_accounting_pending p join radius_acct a on a.id=p.accounting_id where a.tenant_id=$1 and a.username=$2`, tenant, username).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("unmapped pending = %d: %v", pending, err)
	}
	exec(`update service_resources set pppoe_username=$2 where id=$1`, resource, username)
	if err = consumer.Sync(ctx, tenant); err != nil {
		t.Fatal(err)
	}
	check(450)
}
