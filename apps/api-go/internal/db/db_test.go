package db

import (
	"context"
	"errors"
	"fmt"
	"nexoisp/api-go/internal/tenancy"
	"os"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func integrationDB(t *testing.T) *DB {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL não definido")
	}
	d, e := Open(context.Background(), url, "force_custom_plan", 1, prometheus.NewRegistry())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(d.Close)
	return d
}
func TestScopeIsolationAndRollback(t *testing.T) {
	d := integrationDB(t)
	ctx := context.Background()
	var tenants []string
	for tenant := range tenantEntries(t, d) {
		tenants = append(tenants, tenant)
		if len(tenants) == 2 {
			break
		}
	}
	if len(tenants) != 2 {
		t.Fatal("base multi-provedor ausente")
	}
	for _, tenant := range tenants {
		e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *Tx) error {
			var n int
			if e := tx.QueryRow(ctx, "select count(*) from subscribers where tenant_id <> $1", tenant).Scan(&n); e != nil {
				return e
			}
			if n != 0 {
				return errors.New("vazamento entre provedores")
			}
			return nil
		})
		if e != nil {
			t.Fatal(e)
		}
	}
	_ = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *Tx) error { return tx.Exec(ctx, "select 1/0") })
	for _, name := range []string{"app.tenant_id", "app.is_operator", "app.subscriber_id", "app.pop_ids"} {
		var value *string
		if e := d.pool.QueryRow(ctx, "select current_setting($1,true)", name).Scan(&value); e != nil {
			t.Fatal(e)
		}
		if value != nil && *value != "" {
			t.Fatalf("escopo vazou no pool: %s=%s", name, *value)
		}
	}
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1], Cell: "c2"}, func(*Tx) error { return nil }); e == nil {
		t.Fatal("célula divergente aceita")
	}
}
func TestPortalRLS(t *testing.T) {
	d := integrationDB(t)
	ctx := context.Background()
	tenant := ""
	for k := range tenantEntries(t, d) {
		tenant = k
		break
	}
	var sub string
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *Tx) error {
		return tx.QueryRow(ctx, "select id from subscribers order by id limit 1").Scan(&sub)
	}); e != nil {
		t.Fatal(e)
	}
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant, SubscriberID: sub}, func(tx *Tx) error {
		var n int
		if e := tx.QueryRow(ctx, "select count(*) from subscribers where id<>$1", sub).Scan(&n); e != nil {
			return e
		}
		if n != 0 {
			return errors.New("portal viu outro assinante")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}

func tenantEntries(t *testing.T, d *DB) map[string]string {
	t.Helper()
	entries := map[string]string{}
	if e := d.WithScope(context.Background(), tenancy.Scope{}, func(tx *Tx) error {
		rows, e := tx.Objects(context.Background(), "select * from nexo_go_directory()")
		if e != nil {
			return e
		}
		for _, row := range rows {
			entries[row.Get("tenant_id").(string)] = row.Get("cell_id").(string)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	return entries
}

func TestPopRLS(t *testing.T) {
	d := integrationDB(t)
	ctx := context.Background()
	tenant := ""
	for k := range tenantEntries(t, d) {
		tenant = k
		break
	}
	rollback := errors.New("rollback POP RLS fixture")
	err := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *Tx) error {
		var allowed, denied, contract string
		if err := tx.QueryRow(ctx, `insert into pops(tenant_id,name) values($1,'RLS allowed '||gen_random_uuid()) returning id`, tenant).Scan(&allowed); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into pops(tenant_id,name) values($1,'RLS denied '||gen_random_uuid()) returning id`, tenant).Scan(&denied); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `select id from contracts order by id limit 1`).Scan(&contract); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `update contracts set pop_id=$2 where id=$1`, contract, allowed); err != nil {
			return err
		}
		for _, test := range []struct {
			pop  string
			want int
		}{{allowed, 1}, {denied, 0}} {
			if err := tx.Exec(ctx, `select set_config('app.pop_ids',$1,true)`, test.pop); err != nil {
				return err
			}
			var n int
			if err := tx.QueryRow(ctx, `select count(*) from contracts where id=$1`, contract).Scan(&n); err != nil {
				return err
			}
			if n != test.want {
				return fmt.Errorf("POP visibility=%d want=%d", n, test.want)
			}
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
}
