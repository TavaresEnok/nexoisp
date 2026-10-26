package db

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"nexoisp/api-go/internal/tenancy"
)

// Non-vacuous migration-64 policy test, using the application role. All fixture
// writes roll back, including the temporary POP assignment of a seeded contract.
func TestManualPaymentIntentRLS(t *testing.T) {
	d := integrationDB(t)
	ctx := context.Background()
	var tenants []string
	for tenant := range tenantEntries(t, d) {
		tenants = append(tenants, tenant)
	}
	if len(tenants) < 2 {
		t.Fatal("two synthetic tenants required")
	}
	rollback := errors.New("rollback synthetic intent fixture")
	err := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *Tx) error {
		var invoice, contract, subscriber, user, pop, otherPop, intent string
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents) select tenant_id,id,subscriber_id,'manual',current_date,100 from contracts order by id limit 1 returning id,contract_id,subscriber_id`).Scan(&invoice, &contract, &subscriber); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, "select id from users where tenant_id=$1 order by id limit 1", tenants[0]).Scan(&user); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into pops(tenant_id,name) values($1,'Intent RLS allowed '||gen_random_uuid()) returning id`, tenants[0]).Scan(&pop); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into pops(tenant_id,name) values($1,'Intent RLS denied '||gen_random_uuid()) returning id`, tenants[0]).Scan(&otherPop); err != nil {
			return err
		}
		if err := tx.Exec(ctx, "update contracts set pop_id=$2 where id=$1", contract, pop); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `insert into manual_payment_intents(tenant_id,intent_id,invoice_id,created_by,request_hash,result_status) values($1,gen_random_uuid(),$2,$3,'synthetic','open') returning intent_id`, tenants[0], invoice, user).Scan(&intent); err != nil {
			return err
		}
		cases := []struct {
			name, tenant, sub, pop string
			want                   int
		}{
			{"same tenant", tenants[0], "", "", 1},
			{"authorized POP", tenants[0], "", pop, 1},
			{"other POP", tenants[0], "", otherPop, 0},
			{"subscriber portal", tenants[0], subscriber, "", 0},
			{"other tenant", tenants[1], "", "", 0},
		}
		for _, c := range cases {
			if err := tx.Exec(ctx, `select set_config('app.tenant_id',$1,true),set_config('app.subscriber_id',$2,true),set_config('app.pop_ids',$3,true)`, c.tenant, c.sub, c.pop); err != nil {
				return err
			}
			var n int
			if err := tx.QueryRow(ctx, "select count(*) from manual_payment_intents where intent_id=$1", intent).Scan(&n); err != nil {
				return err
			}
			if n != c.want {
				return fmt.Errorf("%s: visible intents=%d want=%d", c.name, n, c.want)
			}
			if c.want == 0 {
				if err := tx.Exec(ctx, "savepoint denied_insert"); err != nil {
					return err
				}
				insertErr := tx.Exec(ctx, `insert into manual_payment_intents(tenant_id,intent_id,invoice_id,created_by,request_hash) values($1,gen_random_uuid(),$2,$3,'synthetic')`, tenants[0], invoice, user)
				if err := tx.Exec(ctx, "rollback to savepoint denied_insert"); err != nil {
					return err
				}
				if insertErr == nil {
					return fmt.Errorf("%s: unauthorized insert accepted", c.name)
				}
			}
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
}
