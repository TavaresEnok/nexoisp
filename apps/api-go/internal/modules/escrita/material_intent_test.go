package escrita

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
)

func TestR03MaterialIntentRequired(t *testing.T) {
	ops := map[string]operation{}
	(Service{}).stockOperations(ops)
	schema := ops["POST /api/work-orders/:id/materials"].schema
	_, err := schema.Parse(map[string]any{"item_id": uuid.NewString(), "qty": float64(1)}, true)
	if err == nil || apierr.Map(err).Status != 400 {
		t.Fatalf("UUID ausente deve retornar 400: %v", err)
	}
}

func TestR03MaterialIntentPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com PG_REQUIRED=1")
		}
		t.Skip("PostgreSQL ausente; SKIP não comprova SQL, concorrência ou RLS")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var database, role, tenant, otherTenant, user, subscriber string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, "select current_database(), session_user::text").Scan(&database, &role); e != nil {
			return e
		}
		return tx.QueryRow(ctx, "select min(tenant_id::text), max(tenant_id::text) from nexo_go_directory()").Scan(&tenant, &otherTenant)
	})
	if err != nil {
		t.Fatal(err)
	}
	if database != "nexo_test" || role != "nexo_go" || tenant == otherTenant {
		t.Fatal("requer nexo_test com papel nexo_go restrito")
	}
	scope := tenancy.Scope{TenantID: tenant}
	var order, otherOrder, item string
	err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, "select id::text from users where tenant_id=app_tenant() limit 1").Scan(&user); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into subscribers(tenant_id,name) values(app_tenant(),$1) returning id::text", "R03 "+uuid.NewString()).Scan(&subscriber); e != nil {
			return e
		}
		var pop, plan string
		if e := tx.QueryRow(ctx, "insert into pops(tenant_id,name) values(app_tenant(),$1) returning id::text", "R03 "+uuid.NewString()).Scan(&pop); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "select id::text from plan_versions limit 1").Scan(&plan); e != nil {
			return e
		}
		if e := tx.Exec(ctx, "insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day,pop_id) values(app_tenant(),$1,$2,10,$3)", subscriber, plan, pop); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into work_orders(tenant_id,number,kind,subscriber_id,description) values(app_tenant(), (select coalesce(max(number),0)+100000 from work_orders), 'other',$1,'R03 teste') returning id::text", subscriber).Scan(&order); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into work_orders(tenant_id,number,kind,subscriber_id,description) values(app_tenant(), (select coalesce(max(number),0)+100000 from work_orders), 'other',$1,'R03 outra OS') returning id::text", subscriber).Scan(&otherOrder); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into stock_items(tenant_id,name,unit) values(app_tenant(),$1,'un') returning id::text", "R03 "+uuid.NewString()).Scan(&item); e != nil {
			return e
		}
		return tx.Exec(ctx, "insert into stock_movements(tenant_id,item_id,qty,kind) values(app_tenant(),$1,20,'in')", item)
	})
	if err != nil {
		t.Fatal(err)
	}
	actor := auth.With(ctx, &auth.Ctx{TenantID: tenant, UserID: user, Scope: scope})
	call := func(id string, qty float64, rollback bool) (any, error) {
		var result any
		e := d.WithScope(actor, scope, func(tx *db.Tx) error {
			var e error
			result, e = (Service{}).workMaterials(actor, tx, order, map[string]any{"intention_id": id, "item_id": item, "qty": qty})
			if e == nil && rollback {
				return errors.New("rollback de teste")
			}
			return e
		})
		return result, e
	}
	intent := uuid.NewString()
	var out [2]any
	var errs [2]error
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) { defer wg.Done(); out[i], errs[i] = call(intent, 2, false) }(i)
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("concorrência: %v %v", errs[0], errs[1])
	}
	a, _ := json.Marshal(out[0])
	b, _ := json.Marshal(out[1])
	if string(a) != string(b) {
		t.Fatalf("recibos diferentes: %s %s", a, b)
	}
	replay, e := call(intent, 2, false)
	if e != nil {
		t.Fatal(e)
	}
	b, _ = json.Marshal(replay)
	if string(a) != string(b) {
		t.Fatal("replay diferente")
	}
	if _, e = call(intent, 3, false); e == nil {
		t.Fatal("payload divergente aceito")
	}
	if apierr.Map(e).Status != 409 {
		t.Fatalf("payload divergente: %v", e)
	}
	err = d.WithScope(actor, scope, func(tx *db.Tx) error {
		_, e := (Service{}).workMaterials(actor, tx, otherOrder, map[string]any{"intention_id": intent, "item_id": item, "qty": float64(2)})
		return e
	})
	if err == nil || apierr.Map(err).Status != 409 {
		t.Fatalf("OS divergente: %v", err)
	}
	otherActor := auth.With(ctx, &auth.Ctx{TenantID: tenant, UserID: uuid.NewString(), Scope: scope})
	err = d.WithScope(otherActor, scope, func(tx *db.Tx) error {
		_, e := (Service{}).workMaterials(otherActor, tx, order, map[string]any{"intention_id": intent, "item_id": item, "qty": float64(2)})
		return e
	})
	if err == nil {
		t.Fatal("autor divergente aceito")
	}
	for _, denied := range []tenancy.Scope{{TenantID: otherTenant}, {TenantID: tenant, PopIDs: []string{uuid.NewString()}}} {
		deniedActor := auth.With(ctx, &auth.Ctx{TenantID: denied.TenantID, UserID: user, Scope: denied})
		err = d.WithScope(deniedActor, denied, func(tx *db.Tx) error {
			_, e := (Service{}).workMaterials(deniedActor, tx, order, map[string]any{"intention_id": intent, "item_id": item, "qty": float64(2)})
			return e
		})
		if err == nil || apierr.Map(err).Status != 404 {
			t.Fatalf("escopo não negado: %v", err)
		}
	}
	if _, e = call(uuid.NewString(), 2, false); e != nil {
		t.Fatal(e)
	}
	if _, e = call(uuid.NewString(), -5, false); e == nil {
		t.Fatal("devolução excessiva aceita")
	}
	if _, e = call(uuid.NewString(), -1, false); e != nil {
		t.Fatal(e)
	}
	rolled := uuid.NewString()
	if _, e = call(rolled, 1, true); e == nil {
		t.Fatal("rollback não ocorreu")
	}
	if _, e = call(rolled, 1, false); e != nil {
		t.Fatal(e)
	}
	err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var movements, events int
		if e := tx.QueryRow(ctx, "select count(*) from stock_movements where work_order_id=$1", order).Scan(&movements); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "select count(*) from work_order_events where work_order_id=$1 and event='material'", order).Scan(&events); e != nil {
			return e
		}
		if movements != 4 || events != 4 {
			t.Errorf("movimentos=%d eventos=%d", movements, events)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, "update work_orders set status='canceled', finished_at=now() where id=$1", order)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, e = call(intent, 2, false); e != nil {
		t.Fatalf("replay de OS encerrada: %v", e)
	}
	if _, e = call(uuid.NewString(), 1, false); e == nil {
		t.Fatal("movimento novo em OS encerrada")
	}
}
