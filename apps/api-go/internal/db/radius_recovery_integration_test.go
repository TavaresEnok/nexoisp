package db_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/md5"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/radius"
	"nexoisp/api-go/internal/tenancy"
)

func TestRadiusDisconnectJournalRecoversWithoutResendAndScopesNAS(t *testing.T) {
	dsn, ownerDSN := os.Getenv("NEXO_GO_TEST_DATABASE_URL"), os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if dsn == "" || ownerDSN == "" {
		t.Skip("requires explicitly owned disposable PostgreSQL")
	}
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	t.Setenv("NEXO_RADIUS_KEY", "synthetic-radius-key-isolated-0001")
	t.Setenv("NEXO_RADIUS_COA_RELAY", "")
	t.Setenv("NEXO_RADIUS_DISCONNECT_WRITE", "1")
	ctx := context.Background()
	owner, e := sql.Open("pgx", ownerDSN)
	if e != nil {
		t.Fatal(e)
	}
	defer owner.Close()
	var name string
	if e = owner.QueryRowContext(ctx, `select current_database()`).Scan(&name); e != nil || name != "nexo_test" {
		t.Fatal("only owned nexo_test is allowed", name, e)
	}
	database, e := db.Open(ctx, dsn, "force_custom_plan", 8, prometheus.NewRegistry())
	if e != nil {
		t.Fatal(e)
	}
	defer database.Close()
	var tenant, agent, device string
	if e = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); e != nil {
		t.Fatal(e)
	}
	var paymentsBefore, movementsBefore int
	if e = owner.QueryRowContext(ctx, `select (select count(*) from payments),(select count(*) from invoice_movements)`).Scan(&paymentsBefore, &movementsBefore); e != nil {
		t.Fatal(e)
	}
	scope := tenancy.Scope{TenantID: tenant}
	executor := &radius.Executor{DB: database}
	server, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	var mode atomic.Int32
	var sends atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		buffer := make([]byte, 4096)
		for {
			n, client, e := server.ReadFromUDP(buffer)
			if e != nil {
				return
			}
			packet := append([]byte{}, buffer[:n]...)
			sends.Add(1)
			switch mode.Load() {
			case 1: // The NAS applied the effect; its UDP response never arrived.
				var session, user string
				for i := 20; i+2 <= len(packet); {
					length := int(packet[i+1])
					if length < 2 || i+length > len(packet) {
						break
					}
					if packet[i] == 1 {
						user = string(packet[i+2 : i+length])
					}
					if packet[i] == 44 {
						session = string(packet[i+2 : i+length])
					}
					i += length
				}
				_, mockErr := owner.ExecContext(ctx, `update radius_acct set stopped_at=now(),updated_at=now(),terminate_cause='Synthetic-NAS-Stop' where tenant_id=$1 and session_id=$2 and username=$3 and nas_ip='127.0.0.1'`, tenant, session, user)
				if mockErr != nil {
					t.Error("synthetic NAS accounting effect", mockErr)
				}
			case 2:
				_, _ = server.WriteToUDP(testReply(packet, 42, []byte{101, 6, 0, 0, 1, 150}, true), client)
			case 3:
				_, _ = server.WriteToUDP(testReply(packet, 41, nil, true), client)
			}
		}
	}()
	defer func() { _ = server.Close(); <-done }()
	if e = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var err error
		agent, err = radius.EnsureAgent(ctx, tx, tenant)
		if err != nil {
			return err
		}
		existing, err := tx.Objects(ctx, `select d.id,d.name from devices d join radius_nas n on n.device_id=d.id where n.nas_ip='127.0.0.1'`)
		if err != nil {
			return err
		}
		if len(existing) > 0 {
			if !strings.HasPrefix(jsonx.String(existing[0].Get("name")), "Synthetic AAA ") {
				return errors.New("fixture NAS does not belong to this test")
			}
			device = jsonx.String(existing[0].Get("id"))
			return tx.Exec(ctx, `update radius_nas set coa_port=$2 where device_id=$1`, device, server.LocalAddr().(*net.UDPAddr).Port)
		}
		if err = tx.QueryRow(ctx, `insert into devices(tenant_id,name,driver,agent_id,vendor) values($1,$2,'radius',$3,'mikrotik') returning id`, tenant, "Synthetic AAA "+uuid.NewString(), agent).Scan(&device); err != nil {
			return err
		}
		return tx.Exec(ctx, `insert into radius_nas(device_id,tenant_id,nas_ip,secret,coa_port) values($1,$2,'127.0.0.1',$3,$4)`, device, tenant, syntheticRadiusSecret, server.LocalAddr().(*net.UDPAddr).Port)
	}); e != nil {
		t.Fatal(e)
	}
	type resource struct{ ID, User string }
	makeResource := func() resource {
		t.Helper()
		var contract, id string
		user := "synthetic-" + uuid.NewString()
		secret, err := cryptox.EncryptSecret("synthetic-PPP-secret")
		if err != nil {
			t.Fatal(err)
		}
		if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if e := tx.QueryRow(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day) select tenant_id,subscriber_id,plan_version_id,due_day from contracts where status='active' limit 1 returning id`).Scan(&contract); e != nil {
				return e
			}
			return tx.QueryRow(ctx, `insert into service_resources(tenant_id,contract_id,device_id,pppoe_username,secret_enc,desired_profile) values($1,$2,$3,$4,$5,'synthetic') returning id`, tenant, contract, device, user, secret).Scan(&id)
		}); err != nil {
			t.Fatal(err)
		}
		var op string
		if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			o, e := network.Request(ctx, tx, tenant, id, "subscriber.provision", network.Authz{Type: "system", ID: "synthetic-radius"}, uuid.NewString(), "")
			if e == nil {
				op = jsonx.String(o.Get("id"))
			}
			return e
		}); err != nil {
			t.Fatal(err)
		}
		if finished, err := executor.RunOperation(ctx, tenant, op); err != nil || !finished {
			t.Fatal("initial authorization", finished, err)
		}
		return resource{id, user}
	}
	disconnect := func(r resource, session string) string {
		t.Helper()
		if _, err := owner.ExecContext(ctx, `insert into radius_acct(tenant_id,unique_id,session_id,username,nas_ip,started_at,updated_at) values($1,$2,$3,$4,'127.0.0.1',now()-interval '1 hour',now()-interval '1 minute')`, tenant, uuid.NewString(), session, r.User); err != nil {
			t.Fatal(err)
		}
		var op string
		if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
			o, e := network.Request(ctx, tx, tenant, r.ID, "subscriber.disconnect", network.Authz{Type: "system", ID: "synthetic-radius"}, uuid.NewString(), "")
			if e == nil {
				op = jsonx.String(o.Get("id"))
			}
			return e
		}); err != nil {
			t.Fatal(err)
		}
		return op
	}
	state := func(op string) string {
		t.Helper()
		var value string
		if err := owner.QueryRowContext(ctx, `select status from operations where id=$1`, op).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	due := func(op string) {
		t.Helper()
		if _, err := owner.ExecContext(ctx, `update operations set next_attempt_at=now() where id=$1`, op); err != nil {
			t.Fatal(err)
		}
	}
	lost := makeResource()
	mode.Store(1)
	op := disconnect(lost, "synthetic-lost")
	if finished, err := executor.RunOperation(ctx, tenant, op); err != nil || finished || state(op) != "UNCERTAIN" {
		t.Fatal("unknown effect was discarded", finished, state(op), err)
	}
	before := sends.Load()
	due(op)
	// Recovery must remain read-only even after the original write validity ends.
	if _, err := owner.ExecContext(ctx, `update operations set valid_until=now()-interval '1 minute' where id=$1`, op); err != nil {
		t.Fatal(err)
	}
	if finished, err := executor.RunOperation(ctx, tenant, op); err != nil || !finished || state(op) != "SUCCEEDED" || sends.Load() != before {
		t.Fatal("lost response recovery repeated Disconnect", finished, state(op), sends.Load(), err)
	}
	unknown := makeResource()
	mode.Store(0)
	unknownOp := disconnect(unknown, "synthetic-unknown")
	if _, err := executor.RunOperation(ctx, tenant, unknownOp); err != nil {
		t.Fatal(err)
	}
	if state(unknownOp) != "UNCERTAIN" {
		t.Fatal("timeout did not preserve uncertainty")
	}
	before = sends.Load()
	due(unknownOp)
	if _, err := executor.RunOperation(ctx, tenant, unknownOp); err != nil || sends.Load() != before || state(unknownOp) != "UNCERTAIN" {
		t.Fatal("unknown session resent", sends.Load(), err)
	}
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		_, e := network.Request(ctx, tx, tenant, unknown.ID, "subscriber.resume", network.Authz{Type: "system", ID: "synthetic-radius"}, uuid.NewString(), "")
		return e
	})
	var conflict *apierr.Error
	if !errors.As(err, &conflict) || conflict.Status != 409 {
		t.Fatal("new intent bypassed unresolved resource", err)
	}
	// A different subscriber on this NAS still progresses; uncertainty must not
	// freeze every account sharing the same concentrator.
	rejection := makeResource()
	mode.Store(2)
	rejectionOp := disconnect(rejection, "synthetic-406")
	if _, err := executor.RunOperation(ctx, tenant, rejectionOp); err != nil {
		t.Fatal(err)
	}
	var closed bool
	if err := owner.QueryRowContext(ctx, `select stopped_at is not null from radius_acct where session_id='synthetic-406' and username=$1`, rejection.User).Scan(&closed); err != nil || closed {
		t.Fatal("406 unsupported extension became absent session", err)
	}
	accepted := makeResource()
	mode.Store(3)
	acceptedOp := disconnect(accepted, "synthetic-ack")
	if _, err := owner.ExecContext(ctx, `insert into radius_acct(tenant_id,unique_id,session_id,username,nas_ip,started_at,updated_at) values($1,$2,'synthetic-ack',$3,'127.0.0.2',now()-interval '1 hour',now())`, tenant, uuid.NewString(), accepted.User); err != nil {
		t.Fatal(err)
	}
	if finished, err := executor.RunOperation(ctx, tenant, acceptedOp); err != nil || !finished || state(acceptedOp) != "SUCCEEDED" {
		t.Fatal("ACK", finished, state(acceptedOp), err)
	}
	if err := owner.QueryRowContext(ctx, `select stopped_at is not null from radius_acct where session_id='synthetic-ack' and nas_ip='127.0.0.2' and username=$1`, accepted.User).Scan(&closed); err != nil || closed {
		t.Fatal("another NAS session was closed", err)
	}

	// Simulate a legacy divergence already present before the new request
	// guard. Recovery must not label an unknown effect SUPERSEDED/EXPIRED.
	before = sends.Load()
	if _, err := owner.ExecContext(ctx, `update service_resources set desired_version=desired_version+1 where id=$1`, unknown.ID); err != nil {
		t.Fatal(err)
	}
	due(unknownOp)
	if finished, err := executor.RunOperation(ctx, tenant, unknownOp); err != nil || finished || state(unknownOp) != "UNCERTAIN" || sends.Load() != before {
		t.Fatal("legacy version divergence discarded unknown effect", finished, state(unknownOp), err)
	}

	// Restarting the consumer must not count cumulative counters twice, and
	// another NAS's open row must not become the current resource observation.
	if _, err := owner.ExecContext(ctx, `update radius_acct set bytes_in=123456 where tenant_id=$1 and username=$2 and nas_ip='127.0.0.1'`, tenant, accepted.User); err != nil {
		t.Fatal(err)
	}
	if err := executor.Sync(ctx, tenant); err != nil {
		t.Fatal("accounting sync", err)
	}
	var usageBefore, usageAfter int64
	if err := owner.QueryRowContext(ctx, `select coalesce(sum(bytes_in),0) from usage_daily where tenant_id=$1`, tenant).Scan(&usageBefore); err != nil {
		t.Fatal(err)
	}
	restarted := &radius.Executor{DB: database}
	if err := restarted.Sync(ctx, tenant); err != nil {
		t.Fatal("restarted sync", err)
	}
	if err := owner.QueryRowContext(ctx, `select coalesce(sum(bytes_in),0) from usage_daily where tenant_id=$1`, tenant).Scan(&usageAfter); err != nil || usageBefore < 123456 || usageAfter != usageBefore {
		t.Fatal("restart double count", usageBefore, usageAfter, err)
	}
	// Eight executors must apply one counter delta. A replay with no further
	// accounting change leaves the tenant total in place.
	if _, err := owner.ExecContext(ctx, `update radius_acct set bytes_in=223456 where tenant_id=$1 and username=$2 and nas_ip='127.0.0.1'`, tenant, accepted.User); err != nil {
		t.Fatal(err)
	}
	var ready, finished sync.WaitGroup
	start := make(chan struct{})
	syncErrs := make([]error, 8)
	for i := range syncErrs {
		ready.Add(1)
		finished.Add(1)
		go func(i int) {
			defer finished.Done()
			ready.Done()
			<-start
			syncErrs[i] = (&radius.Executor{DB: database}).Sync(ctx, tenant)
		}(i)
	}
	ready.Wait()
	close(start)
	finished.Wait()
	for _, err := range syncErrs {
		if err != nil {
			t.Fatal("concurrent accounting sync", err)
		}
	}
	var usageConcurrent int64
	if err := owner.QueryRowContext(ctx, `select coalesce(sum(bytes_in),0) from usage_daily where tenant_id=$1`, tenant).Scan(&usageConcurrent); err != nil || usageConcurrent != usageAfter+100000 {
		t.Fatal("concurrent double count", usageAfter, usageConcurrent, err)
	}
	if err := (&radius.Executor{DB: database}).Sync(ctx, tenant); err != nil {
		t.Fatal("replay sync", err)
	}
	var usageReplay int64
	if err := owner.QueryRowContext(ctx, `select coalesce(sum(bytes_in),0) from usage_daily where tenant_id=$1`, tenant).Scan(&usageReplay); err != nil || usageReplay != usageConcurrent {
		t.Fatal("replay changed usage", usageConcurrent, usageReplay, err)
	}
	if err := owner.QueryRowContext(ctx, `select observed_session is null from service_resources where id=$1`, accepted.ID).Scan(&closed); err != nil || !closed {
		t.Fatal("foreign NAS became live observation", err)
	}
	// Retention cannot erase exact proof referenced by an unresolved operation.
	var protected, ordinary int64
	for _, target := range []*int64{&protected, &ordinary} {
		if err := owner.QueryRowContext(ctx, `insert into radius_acct(tenant_id,unique_id,session_id,username,nas_ip,started_at,updated_at,stopped_at) values($1,$2,'synthetic-retention',$3,'127.0.0.1',now()-interval '502 days',now()-interval '501 days',now()-interval '501 days') returning id`, tenant, uuid.NewString(), unknown.User).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.ExecContext(ctx, `update operation_attempts set steps=steps||jsonb_build_array(jsonb_build_object('radius_disconnect',(select jsonb_build_object('accounting_id',id::text,'session_id',session_id,'nas_ip',host(nas_ip),'started_at',started_at,'outcome','uncertain') from radius_acct where id=$2::bigint))) where id=(select id from operation_attempts where operation_id=$1 order by started_at desc limit 1)`, unknownOp, protected); err != nil {
		t.Fatal(err)
	}
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error { return radius.Purge(ctx, tx, tenant) }); err != nil {
		t.Fatal("bounded retention", err)
	}
	var kept, dropped bool
	if err := owner.QueryRowContext(ctx, `select exists(select 1 from radius_acct where id=$1),not exists(select 1 from radius_acct where id=$2)`, protected, ordinary).Scan(&kept, &dropped); err != nil || !kept || !dropped {
		t.Fatal("unresolved proof retention", kept, dropped, err)
	}

	var paymentsAfter, movementsAfter int
	if err := owner.QueryRowContext(ctx, `select (select count(*) from payments),(select count(*) from invoice_movements)`).Scan(&paymentsAfter, &movementsAfter); err != nil {
		t.Fatal(err)
	}
	if paymentsBefore != paymentsAfter || movementsBefore != movementsAfter {
		t.Fatal("Disconnect changed financial history")
	}

}

// Synthetic NAS responder for this cross-package integration test.
const syntheticRadiusSecret = "synthetic-radius-secret-32-bytes"

func testReply(request []byte, code byte, attrs []byte, withMAC bool) []byte {
	p := make([]byte, 20)
	p[0], p[1] = code, request[1]
	copy(p[4:20], request[4:20])
	p = append(p, attrs...)
	if withMAC {
		p = append(p, 80, 18)
		p = append(p, make([]byte, 16)...)
	}
	binary.BigEndian.PutUint16(p[2:4], uint16(len(p)))
	if withMAC {
		mac := hmac.New(md5.New, []byte(syntheticRadiusSecret))
		_, _ = mac.Write(p)
		copy(p[len(p)-16:], mac.Sum(nil))
	}
	sum := md5.Sum(append(bytes.Clone(p), []byte(syntheticRadiusSecret)...))
	copy(p[4:20], sum[:])
	return p
}
