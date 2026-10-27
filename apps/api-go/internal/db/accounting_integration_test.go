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
	_ "github.com/jackc/pgx/v5/stdlib"
)

// No ambient database fallback: this test requires the explicitly owned lab.
func TestAccountingGenerationsAndReview(t *testing.T) {
	dsn := os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if dsn == "" {
		t.Skip("requires owned disposable PostgreSQL")
	}
	owner, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = owner.Close() })
	var database string
	if e = owner.QueryRow("select current_database()").Scan(&database); e != nil || database != "nexo_test" {
		t.Fatal("only nexo_test is allowed", e)
	}
	ctx := context.Background()
	tenant := uuid.NewString()
	other := uuid.NewString()
	device := uuid.NewString()
	device2 := uuid.NewString()
	actor := uuid.NewString()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := owner.ExecContext(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`insert into tenants(id,name,slug) values($1,'Synthetic accounting',$2),($3,'Synthetic accounting peer',$4)`, tenant, "acct-"+tenant[:30], other, "acct-"+other[:30])
	exec(`insert into devices(id,tenant_id,name,driver,vendor) values($1,$2,'Synthetic accounting NAS','radius','generic'),($3,$4,'Synthetic accounting peer NAS','radius','generic')`, device, tenant, device2, other)
	// Test-only private sources, allocated uniquely; no packet is sent to these IPs.
	ip1 := "198.18." + fmt.Sprint(int(time.Now().UnixNano()%200)+1) + ".31"
	ip2 := ip1[:len(ip1)-2] + "32"
	exec(`insert into radius_nas(device_id,tenant_id,nas_ip,secret) values($1,$2,$3,'synthetic-accounting-only'),($4,$5,$6,'synthetic-accounting-only')`, device, tenant, ip1, device2, other, ip2)
	exec(`insert into users(id,tenant_id,email,name,password_hash,role) values($1,$2,$3,'Synthetic reviewer','disabled','admin')`, actor, tenant, actor+"@invalid.test")
	t.Cleanup(func() {
		for _, q := range []string{`delete from audit_events where tenant_id in ($1,$2)`, `delete from radius_accounting_events where tenant_id in ($1,$2)`, `delete from radius_acct where tenant_id in ($1,$2)`, `delete from radius_nas where tenant_id in ($1,$2)`, `delete from devices where tenant_id in ($1,$2)`, `delete from users where tenant_id in ($1,$2)`, `delete from tenants where id in ($1,$2)`} {
			if _, err := owner.Exec(q, tenant, other); err != nil {
				t.Error("cleanup", err)
			}
		}
	})
	base := time.Now().UTC().Truncate(time.Second).Add(-10 * time.Minute).Unix()
	event := func(kind string, at, seconds int64) map[string]any {
		return map[string]any{"kind": kind, "timestamp": at, "seconds": seconds, "unique_id": "same-raw-id", "session_id": "same-sid", "username": "same-user"}
	}
	ingest := func(tenant, ip string, v map[string]any) (string, error) {
		b, _ := json.Marshal(v)
		var result string
		e := owner.QueryRowContext(ctx, `select radius_record_accounting($1,$2,$3::jsonb)`, tenant, ip, string(b)).Scan(&result)
		return result, e
	}
	must := func(tenant, ip string, v map[string]any, want string) {
		t.Helper()
		got, e := ingest(tenant, ip, v)
		if e != nil || got != want {
			t.Fatalf("%s: got %q %v want %s", v["kind"], got, e, want)
		}
	}
	// Concurrent replay persists exactly one session and one event.
	var wg sync.WaitGroup
	failures := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, e := ingest(tenant, ip1, event("start", base, 0))
			if e != nil {
				failures <- e
			} else if got != "applied" && got != "duplicate" {
				failures <- fmt.Errorf("unexpected %s", got)
			}
		}()
	}
	wg.Wait()
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	var rows, deliveries int
	if e = owner.QueryRow(`select count(*),max(deliveries) from radius_accounting_events where tenant_id=$1`, tenant).Scan(&rows, &deliveries); e != nil || rows != 1 || deliveries != 12 {
		t.Fatal(rows, deliveries, e)
	}
	update := event("interim-update", base+120, 120)
	update["input"] = "4294967300"
	update["output"] = "8589934599"
	update["framed_ipv6_address"] = "2001:db8::20"
	update["framed_ipv6_prefix"] = "2001:db8:1::/64"
	update["delegated_ipv6_prefix"] = "2001:db8:200::/56"
	must(tenant, ip1, update, "applied")
	must(tenant, ip1, event("interim-update", base+60, 60), "ignored")
	must(tenant, ip1, event("stop", base+180, 180), "applied")
	must(tenant, ip1, event("start", base, 0), "duplicate")
	must(tenant, ip1, event("interim-update", base+200, 200), "ignored")
	var closed bool
	var incoming int64
	var v6 string
	if e = owner.QueryRow(`select stopped_at is not null,bytes_in,host(framed_ipv6_address) from radius_acct where tenant_id=$1`, tenant).Scan(&closed, &incoming, &v6); e != nil || !closed || incoming != 4294967300 || v6 != "2001:db8::20" {
		t.Fatal(closed, incoming, v6, e)
	}
	// Raw IDs collide across tenants/NAS; they must never collide in storage.
	must(other, ip2, event("start", base, 0), "applied")
	must(tenant, ip1, event("accounting-on", base+250, 0), "applied")
	must(tenant, ip1, event("start", base+300, 0), "applied")
	must(tenant, ip1, event("stop", base+240, 240), "applied") // Late old Stop cannot close the new generation.
	if e = owner.QueryRow(`select count(*) from radius_acct where tenant_id=$1 and stopped_at is null`, tenant).Scan(&rows); e != nil || rows != 1 {
		t.Fatal(rows, e)
	}
	// A new generation without a reboot/Stop proof must not overlap the open one.
	must(tenant, ip1, event("start", base+320, 0), "quarantine")
	// A session may legitimately start in the same second as Accounting-On.
	sameSecond := event("start", base+250, 0)
	sameSecond["session_id"] = "same-second"
	must(tenant, ip1, sameSecond, "applied")
	// Source/tunnel transition keeps the stable NAS/session identity.
	exec(`update radius_nas set nas_ip=$2 where device_id=$1`, device, ip1[:len(ip1)-2]+"33")
	ip3 := ip1[:len(ip1)-2] + "33"
	v := event("interim-update", base+360, 60)
	v["unique_id"] = "changed-on-tunnel"
	must(tenant, ip3, v, "applied")
	// A packet without uptime cannot be guessed into a non-existing generation.
	orphan := event("stop", base+400, 0)
	delete(orphan, "seconds")
	orphan["session_id"] = "orphan"
	orphan["unique_id"] = "orphan-id"
	must(tenant, ip3, orphan, "quarantine")
	var id int64
	if e = owner.QueryRow(`select id from radius_accounting_events where tenant_id=$1 and session_id='orphan'`, tenant).Scan(&id); e != nil {
		t.Fatal(e)
	}
	start := event("start", base+390, 0)
	start["session_id"] = "orphan"
	start["unique_id"] = "orphan-id"
	must(tenant, ip3, start, "applied")
	var seenBefore, changedBefore, packetBefore time.Time
	if e = owner.QueryRow(`select seen_at,changed_at from radius_acct where tenant_id=$1 and session_id='orphan'`, tenant).Scan(&seenBefore, &changedBefore); e != nil {
		t.Fatal(e)
	}
	if e = owner.QueryRow(`select last_packet_at from radius_nas where device_id=$1`, device).Scan(&packetBefore); e != nil {
		t.Fatal(e)
	}
	tx, e := owner.BeginTx(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`set local role nexo_app`); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(`select set_config('app.tenant_id',$1,true)`, tenant); e != nil {
		t.Fatal(e)
	}
	var result string
	if e = tx.QueryRow(`select radius_retry_accounting($1,$2,'Conferido o Start sintético correspondente')`, id, actor).Scan(&result); e != nil || result != "applied" {
		t.Fatal(result, e)
	}
	if e = tx.QueryRow(`select radius_retry_accounting($1,$2,'Repetida a mesma revisão sintética')`, id, actor).Scan(&result); e != nil || result != "already_processed" {
		t.Fatal(result, e)
	}
	if _, e = tx.Exec(`select set_config('app.tenant_id',$1,true)`, other); e != nil {
		t.Fatal(e)
	}
	if e = tx.QueryRow(`select count(*) from radius_accounting_events where tenant_id=$1`, tenant).Scan(&rows); e != nil || rows != 0 {
		t.Fatal("RLS leak", rows, e)
	}
	if e = tx.Commit(); e != nil {
		t.Fatal(e)
	}
	var seenAfter, changedAfter, packetAfter time.Time
	if e = owner.QueryRow(`select seen_at,changed_at from radius_acct where tenant_id=$1 and session_id='orphan'`, tenant).Scan(&seenAfter, &changedAfter); e != nil {
		t.Fatal(e)
	}
	if e = owner.QueryRow(`select last_packet_at from radius_nas where device_id=$1`, device).Scan(&packetAfter); e != nil {
		t.Fatal(e)
	}
	if !seenBefore.Equal(seenAfter) || !packetBefore.Equal(packetAfter) || !changedAfter.After(changedBefore) {
		t.Fatal("review must wake sync without simulating a NAS packet")
	}
	bad := event("interim-update", base+420, 120)
	bad["input"] = "18446744073709551616"
	must(tenant, ip3, bad, "quarantine")
	// The transport role cannot invoke the administrative replay overload.
	if e = owner.QueryRow(`select has_function_privilege('nexo_radius','radius_record_accounting(uuid,inet,jsonb,bigint)','EXECUTE')`).Scan(&closed); e != nil || closed {
		t.Fatal("transport replay privilege", closed, e)
	}
	t.Log("concurrent duplicates, counters/IPv6, ordering, reboot generations, NAS isolation/transition, quarantined review and tenant RLS passed")
}
