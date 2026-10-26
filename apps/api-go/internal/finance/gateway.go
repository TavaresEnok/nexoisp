package finance

import (
	"context"
	"fmt"
	"math"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/tenancy"
	"strings"
)

func Payment(ctx context.Context, tx *db.Tx, id, gateway string, p jsonx.Object, source string) (bool, string, error) {
	inv, e := one(ctx, tx, "applyGatewayPayment", 0, id)
	if e != nil {
		return false, "", e
	}
	count, e := tx.Affected(ctx, query("applyGatewayPayment", 1), inv.Get("tenant_id"), id, p.Get("amount_cents"), p.Get("paid_at"), p.Get("method"), source, gateway, p.Get("id"))
	if e != nil {
		return false, "", e
	}
	if count == 0 {
		return true, fmt.Sprint(inv.Get("status")), nil
	}
	status, e := settle(ctx, tx, inv, false)
	return false, status, e
}
func chargePayments(ctx context.Context, tx *db.Tx, gateway, charge any) ([]jsonx.Object, bool, error) {
	if !Demo(gateway) {
		return nil, false, nil
	}
	rs, e := tx.Objects(ctx, "select payments from demo_gateway_charges where charge_id = $1", charge)
	if e != nil || len(rs) == 0 {
		return nil, false, e
	}
	out := []jsonx.Object{}
	if values, ok := rs[0].Get("payments").([]any); ok {
		for _, v := range values {
			if o, ok := v.(jsonx.Object); ok {
				out = append(out, o)
			}
		}
	}
	return out, true, nil
}
func Reconcile(ctx context.Context, tx *db.Tx, tenant string) (map[string]any, error) {
	invs, e := tx.Objects(ctx, query("reconcile", 0))
	if e != nil {
		return nil, e
	}
	out := map[string]any{"checked": 0, "recovered": 0, "divergent": 0, "unavailable": 0}
	inc := func(k string) { out[k] = out[k].(int) + 1 }
	for _, inv := range invs {
		payments, available, e := chargePayments(ctx, tx, inv.Get("gateway"), inv.Get("gateway_charge_id"))
		if e != nil {
			return nil, e
		}
		if !available {
			inc("unavailable")
			continue
		}
		inc("checked")
		for _, p := range payments {
			duplicate, status, e := Payment(ctx, tx, inv.Get("id").(string), inv.Get("gateway").(string), p, "reconciliation")
			if e != nil {
				return nil, e
			}
			if duplicate {
				continue
			}
			if status == "paid" {
				inc("recovered")
			} else {
				inc("divergent")
			}
			if e = SysAudit(ctx, tx, tenant, "finance.reconcile_payment", "invoice", inv.Get("id"), map[string]any{"payment_id": p.Get("id"), "status": status}, "ok"); e != nil {
				return nil, e
			}
		}
	}
	return out, nil
}
func Event(ctx context.Context, database *db.DB, gateway string, ev jsonx.Object) (map[string]any, error) {
	const key = "processGatewayEvent"
	var tenant any
	charge := ev.Get("charge_id")
	eventID := jsonx.String(ev.Get("id"))
	kind := jsonx.String(ev.Get("type"))
	payload, e := jsonx.Encode(ev)
	if e != nil {
		return nil, e
	}
	if jsonx.Truthy(charge) {
		matches, _, err := database.Lookup(ctx, query(key, 0), gateway, jsonx.String(charge))
		if err != nil {
			return nil, err
		}
		if len(matches) > 0 {
			tenant = matches[0].Get("t")
		}
	}
	if tenant == nil {
		e = database.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return exec(ctx, tx, key, 1, gateway, eventID, kind, charge, payload) })
	}
	if e != nil {
		return nil, e
	}
	if tenant == nil {
		return map[string]any{"status": "unmatched"}, nil
	}
	out := map[string]any{}
	e = database.WithScope(ctx, tenancy.Scope{TenantID: tenant.(string)}, func(tx *db.Tx) error {
		ins, e := one(ctx, tx, key, 2, tenant, gateway, eventID, kind, charge, payload)
		if e != nil {
			return e
		}
		if ins == nil {
			out["status"] = "duplicate"
			return nil
		}
		inv, e := one(ctx, tx, key, 3, gateway, charge)
		if e != nil {
			return e
		}
		status := "ignored"
		var note any = "tipo de evento sem tratamento: " + kind
		p, _ := ev.Get("payment").(jsonx.Object)
		if amount := num(p.Get("amount_cents")); kind == "payment.confirmed" && p != nil && amount > 0 && amount == math.Trunc(amount) {
			duplicate, settled, e := Payment(ctx, tx, inv.Get("id").(string), gateway, p, "gateway_event")
			if e != nil {
				return e
			}
			status, note = "processed", nil
			if settled == "reconciling" {
				status, note = "divergent", "fatura encaminhada à conciliação"
			}
			if duplicate {
				note = "pagamento já registrado anteriormente"
			}
		} else if kind == "payment.refunded" || kind == "payment.chargeback" {
			if e = exec(ctx, tx, key, 4, inv.Get("id"), "gateway informou "+kind+"; tratar manualmente"); e != nil {
				return e
			}
			status, note = "divergent", "estorno/contestação exige decisão manual"
		}
		if e = exec(ctx, tx, key, 5, ins.Get("id"), status, note); e != nil {
			return e
		}
		out["status"] = status
		return nil
	})
	return out, e
}
func AutoSuspend(ctx context.Context, tx *db.Tx, tenant string, contract any) (int, error) {
	s, e := leitura.GetSettings(ctx, tx, tenant)
	if e != nil {
		return 0, e
	}
	if s.Get("auto_suspend") != true || s.Get("suspend_after_days") == nil {
		return 0, nil
	}
	rs, e := tx.Objects(ctx, query("autoSuspend", 0), s.Get("suspend_after_days"), s.Get("timezone"), contract)
	if e != nil {
		return 0, e
	}
	count := 0
	for _, k := range rs {
		target := ""
		if num(k.Get("days_late")) > num(k.Get("block_days")) {
			target = "blocked"
		} else if k.Get("reduce_after_days") != nil && num(k.Get("days_late")) > num(k.Get("reduce_after_days")) {
			target = "reduced"
		}
		if target == "" || (target == "reduced" && k.Get("desired_policy") == "suspended") {
			continue
		}
		inv, e := one(ctx, tx, "autoSuspend", 1, k.Get("invoice_id"))
		if e != nil {
			return count, e
		}
		if inv == nil {
			continue
		}
		if Demo(inv.Get("gateway")) && inv.Get("gateway_charge_id") != nil {
			payments, _, e := chargePayments(ctx, tx, inv.Get("gateway"), inv.Get("gateway_charge_id"))
			if e != nil {
				return count, e
			}
			for _, p := range payments {
				if _, _, e = Payment(ctx, tx, inv.Get("id").(string), inv.Get("gateway").(string), p, "reconciliation"); e != nil {
					return count, e
				}
			}
			current, e := one(ctx, tx, "autoSuspend", 2, inv.Get("id"))
			if e != nil {
				return count, e
			}
			if current.Get("status") != "open" {
				continue
			}
		}
		when := strings.Split(fmt.Sprint(k.Get("due")), "-")
		if len(when) == 3 {
			when[0], when[2] = when[2], when[0]
		}
		actor, action, reason := "billing.auto_suspend", "service.auto_suspend", "inadimplência: fatura vencida em "+strings.Join(when, "/")
		days := k.Get("block_days")
		if target == "reduced" {
			actor, action, reason = "billing.auto_reduce", "service.auto_reduce", "inadimplência: velocidade reduzida (fatura vencida em "+strings.Join(when, "/")+")"
			days = k.Get("reduce_after_days")
		}
		// A savepoint lets a refused resource leave other contracts eligible in this batch.
		if e = tx.Exec(ctx, "savepoint billing_stage"); e != nil {
			return count, e
		}
		op, e := network.Request(ctx, tx, tenant, k.Get("resource_id").(string), "subscriber.suspend", network.Authz{Type: "system", ID: actor, Reason: reason}, "", target)
		if e != nil {
			if rollback := tx.Exec(ctx, "rollback to savepoint billing_stage"); rollback != nil {
				return count, rollback
			}
			if e = SysAudit(ctx, tx, tenant, "service.auto_stage_skipped", "service_resource", k.Get("resource_id"), map[string]any{"target": target, "error": e.Error()}, "error"); e != nil {
				return count, e
			}
		} else {
			if e = SysAudit(ctx, tx, tenant, action, "service_resource", k.Get("resource_id"), map[string]any{"invoice_id": k.Get("invoice_id"), "operation_id": op.Get("id"), "after_days": days, "days_late": k.Get("days_late")}, "ok"); e != nil {
				return count, e
			}
			count++
		}
		if e = tx.Exec(ctx, "release savepoint billing_stage"); e != nil {
			return count, e
		}
	}
	return count, nil
}
