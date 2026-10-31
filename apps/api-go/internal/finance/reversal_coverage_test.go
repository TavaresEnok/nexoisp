package finance

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
	"github.com/google/uuid"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
)

func r02Database(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	if os.Getenv("NEXO_GO_TEST_DATABASE_URL") == "" && os.Getenv("PG_REQUIRED") == "1" {
		t.Fatal("PG_REQUIRED=1 exige NEXO_GO_TEST_DATABASE_URL")
	}
	return openPlanPaidDatabase(t)
}

// The committed, UUID-namespaced fixture lives only in the disposable nexo_test
// database. Its financial history is intentionally retained until disposal.
func TestR02ConcurrentReversal(t *testing.T) {
	d, scope := r02Database(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	mark := uuid.NewString()
	var pop, subscriber, plan, version, contract, user, invoice, original, second string
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		statements := []struct { sql string; args []any; dest *string }{
			{`insert into pops(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"r02-"+mark}, &pop},
			{`insert into subscribers(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"r02-"+mark}, &subscriber},
			{`insert into plans(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"r02-"+mark}, &plan},
		}
		for _, s := range statements { if err := tx.QueryRow(ctx, s.sql, s.args...).Scan(s.dest); err != nil { return err } }
		if err := tx.QueryRow(ctx, `insert into plan_versions(tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values(app_tenant(),$1,1,10000,1000,1000,'r02') returning id::text`, plan).Scan(&version); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day,pop_id) values(app_tenant(),$1,$2,15,$3) returning id::text`, subscriber, version, pop).Scan(&contract); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into users(tenant_id,email,name,password_hash,role) values(app_tenant(),$1,'r02','fixture','finance') returning id::text`, mark+"@example.invalid").Scan(&user); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,status) values(app_tenant(),$1,$2,'manual',current_date-60,10000,'reconciling') returning id::text`, contract, subscriber).Scan(&invoice); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,12000,now()-interval '2 days','manual') returning id::text`, invoice).Scan(&original); err != nil { return err }
		return tx.QueryRow(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,10000,now()-interval '1 day','manual') returning id::text`, invoice).Scan(&second)
	})
	if err != nil { t.Fatalf("fixture commitada: %v", err) }
	scope.PopIDs = []string{pop}
	ready := make(chan int32, 2)
	start := make(chan struct{})
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
				var pid int32
				if err := tx.QueryRow(ctx, `select pg_backend_pid()`).Scan(&pid); err != nil { return err }
				ready <- pid
				select { case <-start: case <-ctx.Done(): return ctx.Err() }
				result, err := Reverse(ctx, tx, invoice, original, user, "concorrência R02")
				if err == nil && result.(map[string]any)["status"] != "paid" { return fmt.Errorf("estado inesperado: %v", result) }
				return err
			})
			results <- err
		}()
	}
	var pids [2]int32
	for i := range pids {
		select { case pids[i] = <-ready: case err := <-results: t.Fatalf("transação antes da barreira: %v", err); case <-ctx.Done(): t.Fatal(ctx.Err()) }
	}
	if pids[0] == pids[1] { t.Fatal("transações não usaram conexões distintas") }
	close(start)
	success, conflicts := 0, 0
	for i := 0; i < 2; i++ {
		err := <-results
		var api *apierr.Error
		if err == nil { success++ } else if errors.As(err, &api) && api.Status == 409 { conflicts++ } else { t.Errorf("estorno concorrente: %v", err) }
	}
	if success != 1 || conflicts != 1 { t.Fatalf("resultados: %d sucessos, %d conflitos", success, conflicts) }
	err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var status string
		var paid bool
		var total int64
		var entries, originals, reversals, effects, settlement, operations int
		returnErr := tx.QueryRow(ctx, `select i.status,i.paid_at is not null,i.settlement_version,
		 (select count(*) from payments where invoice_id=i.id),
		 (select count(*) from payments where invoice_id=i.id and id in ($2,$3) and kind='payment'),
		 (select count(*) from payments where invoice_id=i.id and reversal_of=$2 and kind='reversal'),
		 (select coalesce(sum(signed_cents),0) from payments where invoice_id=i.id),
		 (select count(*) from payment_effects where invoice_id=i.id),
		 (select count(*) from operations o join service_resources r on r.id=o.resource_id where r.contract_id=i.contract_id)
		 from invoices i where i.id=$1`, invoice, original, second).Scan(&status, &paid, &settlement, &entries, &originals, &reversals, &total, &effects, &operations)
		if returnErr != nil { return returnErr }
		if status != "paid" || !paid || settlement != 0 || entries != 3 || originals != 2 || reversals != 1 || total != 10000 || effects != 0 || operations != 0 {
			return fmt.Errorf("histórico: status=%s paid=%v version=%d entries=%d originals=%d reversals=%d total=%d effects=%d operations=%d", status, paid, settlement, entries, originals, reversals, total, effects, operations)
		}
		return nil
	})
	if err != nil { t.Fatal(err) }
}

// Rollback preserves the append-only product rules without privileged cleanup.
func TestR02ReversalCoverageAndEffects(t *testing.T) {
	d, scope := r02Database(t)
	ctx := context.Background()
	rollback := errors.New("rollback R02 fixture")
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var contract, subscriber, user, pop, plan, version, device, resource, agent string
		mark := uuid.NewString()
		if err := tx.QueryRow(ctx, `insert into pops(tenant_id,name) values(app_tenant(),$1) returning id::text`, "r02-"+mark).Scan(&pop); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into subscribers(tenant_id,name) values(app_tenant(),$1) returning id::text`, "r02-"+mark).Scan(&subscriber); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into plans(tenant_id,name) values(app_tenant(),$1) returning id::text`, "r02-"+mark).Scan(&plan); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into plan_versions(tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values(app_tenant(),$1,1,10000,1000,1000,'r02') returning id::text`, plan).Scan(&version); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day,pop_id) values(app_tenant(),$1,$2,15,$3) returning id::text`, subscriber, version, pop).Scan(&contract); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into users(tenant_id,email,name,password_hash,role) values(app_tenant(),$1,'r02','fixture','finance') returning id::text`, mark+"@example.invalid").Scan(&user); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into agents(tenant_id,name,token_hash,version) values(app_tenant(),$1,$2,'0.6.0') returning id::text`, "r02-"+mark, mark).Scan(&agent); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into devices(tenant_id,name,driver,agent_id) values(app_tenant(),$1,'demo',$2) returning id::text`, "r02-"+mark,agent).Scan(&device); err != nil { return err }
		if err := tx.QueryRow(ctx, `insert into service_resources(tenant_id,contract_id,device_id,pppoe_username,desired_policy,desired_profile,desired_version) values(app_tenant(),$1,$2,$3,'active','r02',1) returning id::text`, contract,device,"r02-"+mark).Scan(&resource); err != nil { return err }
		if err := tx.Exec(ctx, `select set_config('app.pop_ids',$1,true)`, pop); err != nil { return err }
		for _, tc := range []struct { remaining, fee, discount, obligation int; want string }{
			{9000,500,500,10000,"open"},{10000,500,500,10000,"paid"},{11000,500,500,10000,"reconciling"},
			{10499,700,200,10500,"open"},{10500,700,200,10500,"paid"},{10501,700,200,10500,"reconciling"},
		} {
			var invoice, original string
			if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,fee_cents,discount_cents) values(app_tenant(),$1,$2,'manual',current_date-60,10000,$3,$4) returning id::text`, contract, subscriber, tc.fee, tc.discount).Scan(&invoice); err != nil { return err }
			if err := tx.QueryRow(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,12000,now()-interval '2 days','manual') returning id::text`, invoice).Scan(&original); err != nil { return err }
			if err := tx.Exec(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,$2,now()-interval '1 day','manual')`, invoice, tc.remaining); err != nil { return err }
			if err := tx.Exec(ctx, `update invoices set status='reconciling' where id=$1`, invoice); err != nil { return err }
			result, err := Reverse(ctx, tx, invoice, original, user, "teste")
			if err != nil { return err }
			if result.(map[string]any)["status"] != tc.want { t.Fatalf("status retornado: %#v, esperado %s", result, tc.want) }
			var status string
			var paid bool
			var version, effects, entries int
			if err := tx.QueryRow(ctx, `select status, paid_at is not null, settlement_version, (select count(*) from payment_effects where invoice_id=i.id), (select count(*) from payments where invoice_id=i.id) from invoices i where id=$1`, invoice).Scan(&status,&paid,&version,&effects,&entries); err != nil { return err }
			if status != tc.want || paid != (tc.want == "paid") || version != 0 || effects != 0 || entries != 3 { t.Fatalf("estado %s paid=%v version=%d effects=%d entries=%d",status,paid,version,effects,entries) }
			// Historical open records are still required to have a positive balance.
			if err := tx.Exec(ctx, `update invoices set status='open' where id=$1`, invoice); err != nil { return err }
			for _, index := range []int{1,2} {
				args := []any{invoice}
				if index == 2 { args = append(args, 0, "America/Sao_Paulo", resource) }
				row, err := one(ctx,tx,"autoSuspend",index,args...)
				if err != nil { return err }
				if (row != nil) != (tc.remaining < tc.obligation) { t.Fatalf("releitura %d saldo %d: %#v",index,tc.remaining,row) }
			}
			rows, err := tx.Objects(ctx,query("ensureCharges",0))
			if err != nil { return err }
			found := false
			for _, row := range rows { if row.Get("id") == invoice { found = true } }
			if found != (tc.remaining < tc.obligation) { t.Fatalf("cobrança saldo %d: selecionada=%v",tc.remaining,found) }
			if err := tx.Exec(ctx, `savepoint replay`); err != nil { return err }
			if _, err := Reverse(ctx,tx,invoice,original,user,"replay"); err == nil { t.Fatal("replay aceito") }
			if err := tx.Exec(ctx, `rollback to savepoint replay`); err != nil { return err }
			// A subsequent ordinary settlement in the same transaction must still fire.
			if err := tx.Exec(ctx, `update invoices set status='open' where id=$1`, invoice); err != nil { return err }
			if err := tx.Exec(ctx, `update invoices set status='paid' where id=$1`, invoice); err != nil { return err }
			if err := tx.QueryRow(ctx, `select settlement_version,(select count(*) from payment_effects where invoice_id=i.id) from invoices i where id=$1`,invoice).Scan(&version,&effects); err != nil { return err }
			if version != 1 || effects != 1 { t.Fatalf("baixa normal: version=%d effects=%d",version,effects) }
			// Keep each case independent for the aggregated oldest-invoice selection.
			if err := tx.Exec(ctx, `update invoices set status='canceled' where id=$1`, invoice); err != nil { return err }
		}
		// An earlier settlement and its effect must survive an excess reversal.
		var priorInvoice, excess, effectID, effectStatus string
		var priorVersion int
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,fee_cents,discount_cents) values(app_tenant(),$1,$2,'manual',current_date-60,10000,700,200) returning id::text`, contract, subscriber).Scan(&priorInvoice); err != nil { return err }
		if err := tx.Exec(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,10500,now()-interval '2 days','manual')`, priorInvoice); err != nil { return err }
		if err := tx.Exec(ctx, `update invoices set status='paid',paid_at=now()-interval '2 days' where id=$1`, priorInvoice); err != nil { return err }
		if err := tx.QueryRow(ctx, `select i.settlement_version,e.id::text,e.status from invoices i join payment_effects e on e.invoice_id=i.id where i.id=$1`, priorInvoice).Scan(&priorVersion,&effectID,&effectStatus); err != nil { return err }
		if priorVersion != 1 || effectStatus != "pending" { t.Fatalf("liquidação anterior: version=%d effect=%s",priorVersion,effectStatus) }
		if err := tx.QueryRow(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,12000,now()-interval '1 day','manual') returning id::text`, priorInvoice).Scan(&excess); err != nil { return err }
		if err := tx.Exec(ctx, `update invoices set status='reconciling',paid_at=null where id=$1`, priorInvoice); err != nil { return err }
		result, err := Reverse(ctx,tx,priorInvoice,excess,user,"conciliação anterior")
		if err != nil { return err }
		if result.(map[string]any)["status"] != "paid" { t.Fatalf("reclassificação anterior: %#v",result) }
		var status, afterEffectID, afterEffectStatus string
		var paid bool
		var afterVersion, effects, entries, priorOperations int
		if err := tx.QueryRow(ctx, `select i.status,i.paid_at is not null,i.settlement_version,e.id::text,e.status,
		 (select count(*) from payment_effects where invoice_id=i.id),
		 (select count(*) from payments where invoice_id=i.id),
		 (select count(*) from operations where resource_id=$2)
		 from invoices i join payment_effects e on e.invoice_id=i.id where i.id=$1 and e.id=$3`, priorInvoice,resource,effectID).Scan(&status,&paid,&afterVersion,&afterEffectID,&afterEffectStatus,&effects,&entries,&priorOperations); err != nil { return err }
		if status != "paid" || !paid || afterVersion != priorVersion || afterEffectID != effectID || afterEffectStatus != effectStatus || effects != 1 || entries != 3 || priorOperations != 0 {
			t.Fatalf("histórico anterior: status=%s paid=%v version=%d effect=%s/%s effects=%d entries=%d operations=%d",status,paid,afterVersion,afterEffectID,afterEffectStatus,effects,entries,priorOperations)
		}
		if err := tx.Exec(ctx, `update invoices set status='canceled' where id=$1`, priorInvoice); err != nil { return err }
		if err := tx.Exec(ctx, `insert into tenant_settings(tenant_id,auto_suspend,suspend_after_days,suspension_mode) values(app_tenant(),true,0,'reject') on conflict(tenant_id) do update set auto_suspend=true,suspend_after_days=0,suspension_mode='reject'`); err != nil { return err }
		var covered string
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) values(app_tenant(),$1,$2,'manual',current_date-60,10000) returning id::text`,contract,subscriber).Scan(&covered); err != nil { return err }
		if err := tx.Exec(ctx, `insert into payments(tenant_id,invoice_id,amount_cents,paid_at,source) values(app_tenant(),$1,10000,now(),'manual')`,covered); err != nil { return err }
		count, err := AutoSuspend(ctx,tx,scope.TenantID,contract)
		if err != nil { return err }; if count != 0 { t.Fatalf("fatura coberta gerou %d suspensões",count) }
		var operations int
		if err := tx.QueryRow(ctx, `select count(*) from operations where resource_id=$1`,resource).Scan(&operations); err != nil { return err }
		if operations != 0 { t.Fatalf("fatura coberta gerou %d operações",operations) }
		if err := tx.Exec(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) values(app_tenant(),$1,$2,'manual',current_date-30,10000)`,contract,subscriber); err != nil { return err }
		count, err = AutoSuspend(ctx,tx,scope.TenantID,contract)
		if err != nil { return err }; if count != 1 { t.Fatalf("inadimplente gerou %d suspensões",count) }
		if err := tx.QueryRow(ctx, `select count(*) from operations where resource_id=$1 and action='subscriber.suspend'`,resource).Scan(&operations); err != nil { return err }
		if operations != 1 { t.Fatalf("inadimplente gerou %d operações",operations) }
		return rollback
	})
	if !errors.Is(err, rollback) { t.Fatalf("fixture R02: %v", err) }
}
