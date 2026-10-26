package finance

import (
	"context"
	"fmt"
	"math"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/tenancy"
	"strings"
)

func Payment(ctx context.Context, tx *db.Tx, id, gateway, connection string, p jsonx.Object, source string) (bool, string, error) {
	inv, e := one(ctx, tx, "applyGatewayPayment", 0, id)
	if e != nil {
		return false, "", e
	}
	if inv == nil || connection == "" || inv.Get("financial_connection_id") != connection || inv.Get("gateway") != gateway {
		return false, "", apierr.New(409, "pagamento sem vínculo com a conexão da fatura")
	}
	count, e := tx.Affected(ctx, query("applyGatewayPayment", 1), inv.Get("tenant_id"), id, p.Get("amount_cents"), p.Get("paid_at"), p.Get("method"), source, gateway, p.Get("id"), connection)
	if e != nil {
		return false, "", e
	}
	if count == 0 {
		var same bool
		if e = tx.QueryRow(ctx, `select invoice_id=$2::uuid and amount_cents=$3 from payments where financial_connection_id=$1 and gateway_payment_id=$4`, connection, id, p.Get("amount_cents"), p.Get("id")).Scan(&same); e != nil {
			return false, "", e
		}
		if !same {
			return false, "", apierr.New(409, "identificador de pagamento já usado com dados diferentes")
		}
		return true, fmt.Sprint(inv.Get("status")), nil
	}
	status, e := settle(ctx, tx, inv, false)
	return false, status, e
}
func chargePayments(ctx context.Context, tx *db.Tx, gateway, charge, connection any) ([]jsonx.Object, bool, error) {
	if !Demo(gateway) || connection == nil {
		return nil, false, nil
	}
	rs, e := tx.Objects(ctx, `select d.payments from demo_gateway_charges d join financial_connections c on c.id=d.financial_connection_id where d.charge_id=$1 and c.id=$2 and c.status='active' and c.provider='demo' and c.environment='sandbox'`, charge, connection)
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
		payments, available, e := chargePayments(ctx, tx, inv.Get("gateway"), inv.Get("gateway_charge_id"), inv.Get("financial_connection_id"))
		if e != nil {
			return nil, e
		}
		if !available {
			inc("unavailable")
			continue
		}
		inc("checked")
		for _, p := range payments {
			duplicate, status, e := Payment(ctx, tx, inv.Get("id").(string), inv.Get("gateway").(string), jsonx.String(inv.Get("financial_connection_id")), p, "reconciliation")
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

// Event accepts a connection authenticated by the transport, never tenant/account
// identifiers from an untrusted event body. Re-read status inside the transaction.
func Event(ctx context.Context, database *db.DB, connection jsonx.Object, ev jsonx.Object) (map[string]any, error) {
	tenant := jsonx.String(connection.Get("tenant_id"))
	cid := jsonx.String(connection.Get("id"))
	if tenant == "" || cid == "" {
		return nil, apierr.New(401, "conexão não autenticada")
	}
	payload, e := jsonx.Encode(ev)
	if e != nil {
		return nil, e
	}
	eventID := jsonx.String(ev.Get("id"))
	kind := jsonx.String(ev.Get("type"))
	charge := jsonx.String(ev.Get("charge_id"))
	if eventID == "" || kind == "" {
		return nil, apierr.New(400, "evento inválido")
	}
	out := map[string]any{}
	e = database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		cs, err := tx.Objects(ctx, `select provider,environment,status from financial_connections where id=$1`, cid)
		if err != nil {
			return err
		}
		if len(cs) != 1 || cs[0].Get("status") != "active" || cs[0].Get("environment") != "sandbox" || !Demo(cs[0].Get("provider")) {
			return apierr.New(409, "conexão indisponível")
		}
		gateway := jsonx.String(cs[0].Get("provider"))
		if err = tx.Exec(ctx, `insert into gateway_events(tenant_id,financial_connection_id,gateway,event_id,type,charge_id,payload) values($1,$2,$3,$4,$5,$6,$7) on conflict(financial_connection_id,event_id) where financial_connection_id is not null do nothing`, tenant, cid, gateway, eventID, kind, charge, payload); err != nil {
			return err
		}
		var eventRow int64
		var status string
		var same bool
		if err = tx.QueryRow(ctx, `select id,status,payload=$3::jsonb from gateway_events where financial_connection_id=$1 and event_id=$2 for update`, cid, eventID, payload).Scan(&eventRow, &status, &same); err != nil {
			return err
		}
		if !same {
			return apierr.New(409, "evento já recebido com conteúdo diferente")
		}
		if status != "received" && status != "unmatched" {
			out["status"] = "duplicate"
			return nil
		}
		rows, err := tx.Objects(ctx, `select id from invoices where financial_connection_id=$1 and gateway_charge_id=$2`, cid, charge)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			out["status"] = "unmatched"
			return tx.Exec(ctx, `update gateway_events set status='unmatched',note='cobrança não encontrada nesta conexão' where id=$1`, eventRow)
		}
		status = "ignored"
		var note any = "tipo de evento sem tratamento: " + kind
		p, _ := ev.Get("payment").(jsonx.Object)
		if kind == "payment.confirmed" {
			amount := num(p.Get("amount_cents"))
			if p == nil || jsonx.String(p.Get("id")) == "" || amount <= 0 || amount != math.Trunc(amount) || jsonx.String(p.Get("paid_at")) == "" {
				return apierr.New(400, "pagamento inválido")
			}
			duplicate, settled, err := Payment(ctx, tx, jsonx.String(rows[0].Get("id")), gateway, cid, p, "gateway_event")
			if err != nil {
				return err
			}
			status, note = "processed", nil
			if settled == "reconciling" {
				status, note = "divergent", "fatura encaminhada à conciliação"
			}
			if duplicate {
				note = "pagamento já registrado anteriormente"
			}
		} else if kind == "payment.refunded" || kind == "payment.chargeback" {
			if err = exec(ctx, tx, "processGatewayEvent", 4, rows[0].Get("id"), "gateway informou "+kind+"; tratar manualmente"); err != nil {
				return err
			}
			status, note = "divergent", "estorno/contestação exige decisão manual"
		}
		if err = tx.Exec(ctx, `update gateway_events set status=$2,note=$3,processed_at=now() where id=$1`, eventRow, status, note); err != nil {
			return err
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
			payments, _, e := chargePayments(ctx, tx, inv.Get("gateway"), inv.Get("gateway_charge_id"), inv.Get("financial_connection_id"))
			if e != nil {
				return count, e
			}
			for _, p := range payments {
				if _, _, e = Payment(ctx, tx, inv.Get("id").(string), inv.Get("gateway").(string), jsonx.String(inv.Get("financial_connection_id")), p, "reconciliation"); e != nil {
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
