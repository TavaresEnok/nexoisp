package escrita

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/validate"

	"github.com/go-chi/chi/v5"
)

func (s Service) financeOperations(ops map[string]operation) {
	f, o, str, n, b, e := validate.F, validate.Object, validate.String, validate.Number, validate.Boolean, validate.Enum
	uuid := str().UUID()
	date := str().Refine(func(v any) bool { return customDate(v.(string)) }, "data inválida")
	ops["POST /api/demo-gateway/pay"] = operation{s.demoPay, obj(o(f("invoice_id", uuid), f("mode", e("webhook", "lost", "duplicate", "divergent"))))}
	ops["POST /api/portal/trust-release"] = operation{s.portalTrust, obj(o(f("contract_id", uuid)))}
	ops["POST /api/finance/generate"] = operation{s.generateInvoices, obj(o(f("competence", str().Pattern(`^\d{4}-(0[1-9]|1[0-2])$`, "Invalid").Opt())))}
	ops["POST /api/invoices"] = operation{s.invoiceCreate, obj(o(f("contract_id", uuid), f("description", text(200).Min(2)), f("amount_cents", n().Int().Positive().Max(100000000)), f("due_date", date)))}
	ops["POST /api/invoices/:id/cancel"] = operation{s.invoiceCancel, obj(o(f("reason", str().Trimmed().Min(3, "informe o motivo"))))}
	ops["POST /api/invoices/:id/manual-payment"] = operation{s.invoicePayment, obj(o(f("intent_id", uuid), f("amount_cents", n().Int().Positive()), f("paid_at", date), f("method", text(40).Nullish()), f("note", str().Trimmed().Min(3, "informe uma observação")), f("apply_fees", b().Opt()), f("partial", b().Opt()), f("discount_cents", n().Int().Positive().Opt()), f("discount_reason", text(200).Min(3).Opt())))}
	ops["POST /api/invoices/:id/payments/:paymentId/reverse"] = operation{s.invoiceReverse, obj(o(f("reason", text(200).Min(5, "descreva o motivo do estorno"))))}
	ops["POST /api/contracts/:id/agreement"] = operation{s.contractAgreement, obj(o(f("invoice_ids", validate.Array(uuid).Min(1).Max(24)), f("installments", n().Int().Min(1).Max(24)), f("first_due_date", date), f("discount_cents", n().Int().Min(0).Opt()), f("reason", text(200).Min(5, "descreva o acordo")), f("apply_fees", b().Opt()), f("release_service", b().Opt())))}
	ops["POST /api/contracts/:id/trust-release"] = operation{s.trustGrant, obj(o(f("days", n().Int().Min(1).Max(30).Opt()), f("reason", text(200).Min(3, "informe o motivo"))))}
	ops["POST /api/invoices/:id/resolve"] = operation{s.invoiceResolve, obj(o(f("decision", e("paid", "open")), f("note", str().Trimmed().Min(5, "descreva a decisão"))))}
	ops["POST /api/finance/reconcile"] = operation{s.financeReconcile, nil}
	ops["POST /api/finance/run-auto-suspend"] = operation{s.financeSuspend, obj(o(f("contract_id", uuid.Opt())))}
}
func (s Service) generateInvoices(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	settings, err := leitura.GetSettings(ctx, tx, c.TenantID)
	if err != nil {
		return nil, err
	}
	var competence any
	if b["competence"] != nil {
		competence = b["competence"].(string) + "-01"
	} else {
		competence, err = finance.Competence(ctx, tx, settings.Get("timezone"))
		if err != nil {
			return nil, err
		}
	}
	created, err := finance.Generate(ctx, tx, c.TenantID, competence.(string))
	if err != nil {
		return nil, err
	}
	charged, err := finance.Charges(ctx, tx, c.TenantID)
	if err != nil {
		return nil, err
	}
	total, err := one(ctx, tx, "POST /api/finance/generate", 0, competence)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "finance.generate_monthly", "invoice", nil, map[string]any{"competence": competence, "created": created}); err != nil {
		return nil, err
	}
	return map[string]any{"competence": competence, "created": created, "already_existing": num(total.Get("n")) - num(created), "charges_emitted": charged, "gateway": settings.Get("gateway")}, nil
}
func (s Service) invoiceCreate(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/invoices"
	k, err := one(ctx, tx, key, 0, b["contract_id"])
	if err != nil {
		return nil, err
	}
	if k == nil {
		return nil, apierr.New(400, "contrato não encontrado")
	}
	c := auth.From(ctx)
	i, err := one(ctx, tx, key, 1, c.TenantID, b["contract_id"], k.Get("subscriber_id"), b["due_date"], b["amount_cents"])
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 2), c.TenantID, i.Get("id"), b["description"], b["amount_cents"]); err != nil {
		return nil, err
	}
	if _, err = finance.Charges(ctx, tx, c.TenantID); err != nil {
		return nil, err
	}
	return i, record(ctx, tx, "invoice.create", "invoice", i.Get("id"), map[string]any{"amount_cents": b["amount_cents"]})
}
func (s Service) invoiceCancel(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	r, err := one(ctx, tx, "POST /api/invoices/:id/cancel", 0, id, b["reason"])
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, apierr.New(400, "somente faturas em aberto podem ser canceladas")
	}
	return map[string]any{"ok": true}, record(ctx, tx, "invoice.cancel", "invoice", id, b)
}
func (s Service) invoicePayment(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	// Lock a visible invoice even on replay: authorization/RLS must still apply.
	var visible string
	if err := tx.QueryRow(ctx, "select id from invoices where id=$1 for update", id).Scan(&visible); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apierr.New(404, "fatura não encontrada")
		}
		return nil, err
	}
	actor := auth.From(ctx)
	payload, err := json.Marshal(b)
	if err != nil {
		return nil, err
	}
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	if err = tx.Exec(ctx, `insert into manual_payment_intents(tenant_id,intent_id,invoice_id,created_by,request_hash)
 values($1,$2,$3,$4,$5) on conflict (tenant_id,intent_id) do nothing`, actor.TenantID, b["intent_id"], id, actor.UserID, hash); err != nil {
		return nil, err
	}
	var invoice, user, previousHash string
	var previousStatus *string
	err = tx.QueryRow(ctx, `select invoice_id,created_by,request_hash,result_status from manual_payment_intents
 where tenant_id=$1 and intent_id=$2 for update`, actor.TenantID, b["intent_id"]).Scan(&invoice, &user, &previousHash, &previousStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apierr.New(409, "intenção já utilizada em outro escopo")
	}
	if err != nil {
		return nil, err
	}
	if invoice != id || user != actor.UserID || previousHash != hash {
		return nil, apierr.New(409, "intenção já utilizada com dados diferentes")
	}
	if previousStatus != nil {
		return map[string]any{"status": *previousStatus}, nil
	}
	b["paid_at"] = fmt.Sprint(b["paid_at"]) + "T12:00:00Z"
	status, err := finance.Manual(ctx, tx, id, auth.From(ctx).UserID, b)
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, "update manual_payment_intents set result_status=$3 where tenant_id=$1 and intent_id=$2", actor.TenantID, b["intent_id"], status); err != nil {
		return nil, err
	}
	discount := b["discount_cents"]
	if discount == nil {
		discount = 0
	}
	return map[string]any{"status": status}, record(ctx, tx, "invoice.manual_payment", "invoice", id, map[string]any{"amount_cents": b["amount_cents"], "status": status, "apply_fees": b["apply_fees"] == true, "partial": b["partial"] == true, "discount_cents": discount})
}
func (s Service) invoiceReverse(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	payment := chi.URLParam(httpx.Request(ctx), "paymentId")
	r, err := finance.Reverse(ctx, tx, id, payment, auth.From(ctx).UserID, b["reason"].(string))
	if err != nil {
		return nil, err
	}
	return r, record(ctx, tx, "invoice.payment_reverse", "invoice", id, map[string]any{"payment_id": payment, "reason": b["reason"]})
}
func (s Service) contractAgreement(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	r, err := finance.Agreement(ctx, tx, c.TenantID, c.UserID, id, b)
	if err != nil {
		return nil, err
	}
	return r, record(ctx, tx, "contract.agreement", "contract", id, map[string]any{"agreement_id": r["id"], "total_cents": r["total_cents"], "installments": b["installments"], "invoices": len(b["invoice_ids"].([]any))})
}
func (s Service) trustGrant(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	b["source"] = "operator"
	r, err := finance.Grant(ctx, tx, c.TenantID, c.UserID, id, b)
	if err != nil {
		return nil, err
	}
	return r, record(ctx, tx, "contract.trust_release", "contract", id, map[string]any{"days": r["days"], "reason": b["reason"], "operation_id": r["operation_id"]})
}
func (s Service) invoiceResolve(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/invoices/:id/resolve"
	inv, err := one(ctx, tx, key, 0, id)
	if err != nil {
		return nil, err
	}
	if inv == nil {
		return nil, apierr.New(400, "fatura não está em conciliação")
	}
	if err = tx.Exec(ctx, query(key, 1), id, b["decision"], "conciliação manual: "+b["note"].(string)); err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "invoice.resolve", "invoice", id, b); err != nil {
		return nil, err
	}
	if b["decision"] == "paid" {
		err = finance.Paid(ctx, tx, inv)
	}
	return map[string]any{"status": b["decision"]}, err
}
func (s Service) financeReconcile(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	r, err := finance.Reconcile(ctx, tx, auth.From(ctx).TenantID)
	if err != nil {
		return nil, err
	}
	return r, record(ctx, tx, "finance.reconcile", "", nil, r)
}
func (s Service) financeSuspend(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	n, err := finance.AutoSuspend(ctx, tx, auth.From(ctx).TenantID, b["contract_id"])
	if err != nil {
		return nil, err
	}
	return map[string]any{"requested": n}, record(ctx, tx, "finance.run_auto_suspend", "", nil, map[string]any{"requested": n, "contract_id": b["contract_id"]})
}
