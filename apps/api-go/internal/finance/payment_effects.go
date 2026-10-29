package finance

import (
	"context"
	"log/slog"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/tenancy"
	"strings"
	"time"
)

// ProcessPaidEffects uses the existing tenant River dispatcher. The durable
// business inbox survives disabled workers, retry exhaustion and job pruning.
// Each effect commits independently: a broken device cannot poison its peers.
func ProcessPaidEffects(ctx context.Context, database *db.DB, tenant string) error {
	var pending []jsonx.Object
	scope := tenancy.Scope{TenantID: tenant}
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var err error
		pending, err = tx.Objects(ctx, `select id,invoice_id from payment_effects where status='pending' and next_attempt_at<=now() order by next_attempt_at,id limit 100`)
		return err
	})
	if err != nil {
		return err
	}
	for _, item := range pending {
		effectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err = database.WithScope(effectCtx, scope, func(tx *db.Tx) error { return planPaidEffect(effectCtx, tx, tenant, item) })
		cancel()
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.Error("payment effect planning failed", "tenant", tenant, "effect", item.Get("id"), "error", err)
		// This transaction is separate from both the financial commit and the failed
		// planning transaction. A crash before it leaves the pending event retryable.
		if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update payment_effects set attempts=attempts+1,
    next_attempt_at=now()+make_interval(secs=>least(3600,60*(attempts+1))),
    last_error='technical planning failed; inspect worker log'
    where id=$1 and status='pending'`, item.Get("id"))
		}); err != nil {
			return err
		}
	}
	return nil
}

func planPaidEffect(ctx context.Context, tx *db.Tx, tenant string, item jsonx.Object) error {
	// Advisory 7411005 and the invoice row come before payment_effects and
	// service_resources. Skip locked stays after the invoice, so a writer that
	// already holds the invoice is not overtaken. Settlement, replay and the
	// separate receipt transaction are unchanged: a technical error rolls back
	// only this planning transaction.
	if err := LockInvoices(ctx, tx, tenant, jsonx.String(item.Get("invoice_id"))); err != nil {
		return err
	}
	inv, err := tx.Objects(ctx, `select id,contract_id,status,settlement_version from invoices where id=$1 for update`, item.Get("invoice_id"))
	if err != nil {
		return err
	}
	if len(inv) == 0 {
		return nil
	}
	effects, err := tx.Objects(ctx, `select id,settlement_version from payment_effects where id=$1 and status='pending' and next_attempt_at<=now() for update skip locked`, item.Get("id"))
	if err != nil {
		return err
	}
	if len(effects) == 0 {
		return nil
	}
	finish := func(status, reason string, op any) error {
		return tx.Exec(ctx, `update payment_effects set status=$2,outcome=$3,operation_id=$4,processed_at=now(),attempts=attempts+1,last_error=null where id=$1`, item.Get("id"), status, reason, op)
	}
	invoice := inv[0]
	if invoice.Get("status") != "paid" || invoice.Get("settlement_version") != effects[0].Get("settlement_version") {
		return finish("ignored", "settlement superseded or invoice no longer paid", nil)
	}
	settings, err := leitura.GetSettings(ctx, tx, tenant)
	if err != nil {
		return err
	}
	if settings.Get("auto_resume_on_payment") != true {
		return finish("ignored", "automatic resume disabled", nil)
	}
	resource, err := one(ctx, tx, "onInvoicePaid", 3, invoice.Get("contract_id"))
	if err != nil {
		return err
	}
	if resource == nil || resource.Get("desired_policy") != "suspended" || !strings.HasPrefix(jsonx.String(resource.Get("desired_reason")), "inadimplência") || resource.Get("status") != "active" {
		return finish("ignored", "no eligible delinquency suspension", nil)
	}
	still, err := one(ctx, tx, "onInvoicePaid", 4, invoice.Get("contract_id"), invoice.Get("id"), settings.Get("suspend_after_days"), settings.Get("timezone"))
	if err != nil {
		return err
	}
	if still != nil {
		return finish("ignored", "other overdue invoice", nil)
	}
	op, err := network.Request(ctx, tx, tenant, resource.Get("id").(string), "subscriber.resume", network.Authz{Type: "system", ID: "billing.payment", Reason: "pagamento confirmado"}, "finance-paid:"+jsonx.String(item.Get("id")), "")
	if err != nil {
		return err
	}
	if err = SysAudit(ctx, tx, tenant, "service.auto_resume", "service_resource", resource.Get("id"), map[string]any{"invoice_id": invoice.Get("id"), "payment_effect_id": item.Get("id"), "operation_id": op.Get("id")}, "ok"); err != nil {
		return err
	}
	return finish("planned", "network intention committed; physical result belongs to operation", op.Get("id"))
}
