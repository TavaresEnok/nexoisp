package acs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
)

type syntheticACS struct {
	mu               sync.Mutex
	tenant, id, ssid string
	timestamp        string
	pending          bool
	lost             bool
	writes           int
	key, remote      string
}

func (f *syntheticACS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.Method == "GET" && r.URL.Path == "/devices/" {
		_ = json.NewEncoder(w).Encode([]any{map[string]any{"_id": f.id, "_tags": []string{TenantTag(f.tenant)}, "_deviceId": map[string]string{"_SerialNumber": f.id}, "InternetGatewayDevice": map[string]any{"DeviceInfo": map[string]any{"ModelName": map[string]any{"_value": "Synthetic"}}, "LANDevice": map[string]any{"1": map[string]any{"WLANConfiguration": map[string]any{"1": map[string]any{"SSID": map[string]any{"_value": f.ssid, "_timestamp": f.timestamp}}}}}}}})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/tasks/" {
		out := []any{}
		if f.pending {
			out = append(out, map[string]string{"_id": f.remote, "device": f.id, "uniqueKey": f.key})
		}
		_ = json.NewEncoder(w).Encode(out)
		return
	}
	if r.Method == "GET" && r.URL.Path == "/faults/" {
		_, _ = w.Write([]byte(`[]`))
		return
	}
	if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/tasks") {
		f.writes++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.key, _ = body["uniqueKey"].(string)
		f.remote = "0123456789abcdef01234567"
		f.pending = true
		if f.lost {
			f.ssid = "new-synthetic"
			f.timestamp = time.Now().UTC().Add(time.Second).Format(time.RFC3339Nano)
			f.pending = false
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"error":"synthetic response lost after effect"}`))
			return
		}
		w.WriteHeader(202)
		_ = json.NewEncoder(w).Encode(map[string]string{"_id": f.remote, "device": f.id, "uniqueKey": f.key})
		return
	}
	w.WriteHeader(404)
	_, _ = w.Write([]byte(`{}`))
}
func acsTestDB(t *testing.T) (*db.DB, tenancy.Scope, string, string) {
	t.Helper()
	dsn := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires owned disposable PostgreSQL")
	}
	d, e := db.Open(context.Background(), dsn, "force_custom_plan", 8, prometheus.NewRegistry())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(d.Close)
	ctx := context.Background()
	var tenant, contract, actor string
	if e = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); e != nil {
		t.Fatal(e)
	}
	scope := tenancy.Scope{TenantID: tenant}
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select id from users where role='admin' order by id limit 1`).Scan(&actor); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day) select tenant_id,subscriber_id,plan_version_id,due_day from contracts where status='active' order by id limit 1 returning id`).Scan(&contract)
	}); e != nil {
		t.Fatal(e)
	}
	return d, scope, contract, actor
}
func TestOwnedLookupRejectsForeignAmbiguousAndUnassignedDevices(t *testing.T) {
	tenant := uuid.NewString()
	foreign := uuid.NewString()
	for _, tags := range [][]any{{TenantTag(foreign)}, {TenantTag(tenant), TenantTag(foreign)}, {}} {
		if OwnedBy(map[string]any{"_tags": tags}, tenant) {
			t.Fatal("foreign/ambiguous/free CPE claimed")
		}
	}
	if !OwnedBy(map[string]any{"_tags": []any{TenantTag(tenant)}}, tenant) {
		t.Fatal("operator-owned CPE unavailable")
	}
	fake := &syntheticACS{tenant: foreign, id: "SYNTHETIC-FOREIGN"}
	server := httptest.NewServer(fake)
	defer server.Close()
	t.Setenv("NEXO_ACS_URL", server.URL)
	if device, e := GetOwned(context.Background(), tenant, fake.id, ""); e != nil || device != nil {
		t.Fatal("ACS filter bypass leaked foreign device", device, e)
	}
}
func TestTaskIntentRecoversLostCommitAndVerifiesFreshReadback(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope, contract, actor := acsTestDB(t)
	ctx := context.Background()
	fake := &syntheticACS{tenant: scope.TenantID, id: "SYNTHETIC-" + uuid.NewString(), ssid: "old-synthetic", timestamp: time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano), lost: true}
	server := httptest.NewServer(fake)
	defer server.Close()
	t.Setenv("NEXO_ACS_URL", server.URL)
	t.Setenv("NEXO_ACS_INSTANCE_ID", "synthetic-instance")
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `insert into cpe_links(tenant_id,contract_id,acs_device_id) values($1,$2,$3)`, scope.TenantID, contract, fake.id)
	}); e != nil {
		t.Fatal(e)
	}
	ssid := "new-synthetic"
	input := TaskRequest{IntentID: uuid.NewString(), Kind: "wifi", Index: "1", SSID: &ssid}
	payload := map[string]any{"name": "setParameterValues", "parameterValues": [][3]string{{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", ssid, "xsd:string"}}}
	var id string
	for i := 0; i < 2; i++ {
		if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			item, created, e := PrepareTask(ctx, tx, scope.TenantID, contract, actor, fake.id, input, payload, map[string]any{})
			if e != nil {
				return e
			}
			if created != (i == 0) {
				t.Fatal("replay prepared another task")
			}
			if id == "" {
				id = item.Get("id").(string)
			} else if id != item.Get("id") {
				t.Fatal("intention ID changed")
			}
			return nil
		}); e != nil {
			t.Fatal(e)
		}
	}
	if e := DispatchTasks(ctx, d, scope, true); e != nil {
		t.Fatal(e)
	}
	if fake.writes != 1 {
		t.Fatal("initial mutation count", fake.writes)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var state string
		if e := tx.QueryRow(ctx, `select state from acs_task_intents where id=$1`, id).Scan(&state); e != nil {
			return e
		}
		if state != "uncertain" {
			t.Fatal("lost response did not preserve uncertainty", state)
		}
		return tx.Exec(ctx, `update acs_task_intents set next_attempt_at=now() where id=$1`, id)
	}); e != nil {
		t.Fatal(e)
	}
	if e := DispatchTasks(ctx, d, scope, false); e != nil {
		t.Fatal(e)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var state string
		if e := tx.QueryRow(ctx, `select state from acs_task_intents where id=$1`, id).Scan(&state); e != nil {
			return e
		}
		if state != "observed" || fake.writes != 1 {
			t.Fatal("recovery resent task or ignored fresh readback", state, fake.writes)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		_, e := tx.Objects(ctx, `select payload_enc from acs_task_intents where id=$1`, id)
		return e
	})
	var denied *pgconn.PgError
	if !errors.As(err, &denied) || denied.Code != "42501" {
		t.Fatalf("expected column permission denial: %v", err)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var pop string
		if e := tx.QueryRow(ctx, `insert into pops(tenant_id,name) values($1,'Synthetic ACS isolation POP') returning id`, scope.TenantID).Scan(&pop); e != nil {
			return e
		}
		return tx.Exec(ctx, `update contracts set pop_id=$2 where id=$1`, contract, pop)
	}); e != nil {
		t.Fatal(e)
	}
	var foreign string
	if e := d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id from nexo_go_directory() where tenant_id<>$1 order by tenant_id limit 1`, scope.TenantID).Scan(&foreign)
	}); e != nil {
		t.Fatal(e)
	}
	for _, restricted := range []tenancy.Scope{{TenantID: foreign}, {TenantID: scope.TenantID, SubscriberID: uuid.NewString()}, {TenantID: scope.TenantID, PopIDs: []string{uuid.NewString()}}} {
		if e := d.WithScope(ctx, restricted, func(tx *db.Tx) error {
			var value *string
			if e := tx.QueryRow(ctx, `select acs_task_payload($1)`, id).Scan(&value); e != nil {
				return e
			}
			if value != nil {
				t.Fatal("envelope escaped tenant/subscriber/POP scope")
			}
			var count int
			if e := tx.QueryRow(ctx, `select count(*) from acs_task_intents where id=$1`, id).Scan(&count); e != nil {
				return e
			}
			if count != 0 {
				t.Fatal("task metadata escaped tenant/subscriber/POP scope")
			}
			return nil
		}); e != nil {
			t.Fatal(e)
		}
	}

}

func TestAcceptedQueueIsNotApplicationAndWorkersNeverResend(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope, contract, actor := acsTestDB(t)
	ctx := context.Background()
	fake := &syntheticACS{tenant: scope.TenantID, id: "SYNTHETIC-" + uuid.NewString(), ssid: "same-synthetic", timestamp: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)}
	server := httptest.NewServer(fake)
	defer server.Close()
	t.Setenv("NEXO_ACS_URL", server.URL)
	t.Setenv("NEXO_ACS_INSTANCE_ID", "synthetic-instance")
	ssid := "same-synthetic"
	intent := uuid.NewString()
	var id string
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.Exec(ctx, `insert into cpe_links(tenant_id,contract_id,acs_device_id) values($1,$2,$3)`, scope.TenantID, contract, fake.id); e != nil {
			return e
		}
		task, _, e := PrepareTask(ctx, tx, scope.TenantID, contract, actor, fake.id, TaskRequest{IntentID: intent, Kind: "wifi", Index: "1", SSID: &ssid}, map[string]any{"name": "setParameterValues", "parameterValues": [][3]string{{"InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", ssid, "xsd:string"}}}, nil)
		if e == nil {
			id = task.Get("id").(string)
		}
		return e
	}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := DispatchTasks(ctx, d, scope, true); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var state string
		if e := tx.QueryRow(ctx, `select state from acs_task_intents where id=$1`, id).Scan(&state); e != nil {
			return e
		}
		if state != "queued" || fake.writes != 1 {
			t.Fatal("queue is not application / duplicate POST", state, fake.writes)
		}
		return tx.Exec(ctx, `update acs_task_intents set next_attempt_at=now() where id=$1`, id)
	}); err != nil {
		t.Fatal(err)
	}
	fake.mu.Lock()
	fake.pending = false
	fake.mu.Unlock()
	if e := DispatchTasks(ctx, d, scope, false); e != nil {
		t.Fatal(e)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var state string
		if e := tx.QueryRow(ctx, `select state from acs_task_intents where id=$1`, id).Scan(&state); e != nil {
			return e
		}
		if state != "queued" || fake.writes != 1 {
			t.Fatal("missing task plus stale matching data must not imply application", state, fake.writes)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}
