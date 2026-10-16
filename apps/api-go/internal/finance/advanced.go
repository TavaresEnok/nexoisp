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
	"time"
)

func date(v any) time.Time {
	if t, ok := v.(jsonx.Time); ok {
		return t.Time
	}
	if t, ok := v.(time.Time); ok {
		return t
	}
	t, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(v))
	return t
}
func brDate(t time.Time) string {
	tz, _ := time.LoadLocation("America/Sao_Paulo")
	return t.In(tz).Format("02/01/2006")
}
func Trust(ctx context.Context, tx *db.Tx, tenant, id string) (map[string]any, error) {
	s, e := leitura.GetSettings(ctx, tx, tenant)
	if e != nil {
		return nil, e
	}
	k, e := first(ctx, tx, "trustState", 0, "contrato não encontrado", id)
	if e != nil {
		return nil, e
	}
	history, e := tx.Objects(ctx, query("trustState", 1), id)
	if e != nil {
		return nil, e
	}
	var active any
	var next time.Time
	for _, h := range history {
		if active == nil && h.Get("status") == "active" && date(h.Get("expires_at")).After(time.Now()) {
			active = map[string]any{"id": h.Get("id"), "granted_at": h.Get("granted_at"), "expires_at": h.Get("expires_at"), "source": h.Get("source"), "days": h.Get("days")}
		}
		if next.IsZero() && h.Get("status") != "canceled" {
			next = date(h.Get("granted_at")).Add(time.Duration(num(s.Get("trust_release_gap_days")) * float64(24*time.Hour)))
		}
	}
	var reason any
	switch {
	case s.Get("trust_release_enabled") != true:
		reason = "a liberação por confiança não está habilitada para este provedor"
	case k.Get("status") != "active":
		reason = "contrato encerrado"
	case active != nil:
		reason = "já existe uma liberação em curso"
	case !jsonx.Truthy(k.Get("desired_policy")):
		reason = "o contrato não tem acesso provisionado"
	case k.Get("desired_policy") != "suspended":
		reason = "o acesso não está suspenso"
	case next.After(time.Now()):
		reason = "nova liberação a partir de " + brDate(next)
	}
	var nextAllowed any
	if next.After(time.Now()) {
		nextAllowed = next.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return map[string]any{"enabled": s.Get("trust_release_enabled") == true, "eligible": reason == nil, "reason": reason, "max_days": s.Get("trust_release_days"), "active": active, "next_allowed_at": nextAllowed, "history": history}, nil
}
func Grant(ctx context.Context, tx *db.Tx, tenant, user, id string, b map[string]any) (map[string]any, error) {
	st, e := Trust(ctx, tx, tenant, id)
	if e != nil {
		return nil, e
	}
	if st["eligible"] != true {
		return nil, apierr.New(409, fmt.Sprint(st["reason"]))
	}
	days := st["max_days"]
	if b["days"] != nil {
		days = b["days"]
	}
	if num(days) < 1 || num(days) > num(st["max_days"]) {
		return nil, apierr.New(400, fmt.Sprintf("o prazo máximo da liberação é de %v dia(s)", st["max_days"]))
	}
	r, e := one(ctx, tx, "grantTrustRelease", 0, id)
	if e != nil {
		return nil, e
	}
	t, e := one(ctx, tx, "grantTrustRelease", 1, tenant, id, b["source"], user, b["reason"], days)
	if e != nil {
		return nil, e
	}
	reason := "liberação por confiança até " + brDate(date(t.Get("expires_at")))
	if b["source"] == "portal" {
		reason += " (pedida pelo assinante)"
	}
	op, e := network.Request(ctx, tx, tenant, r.Get("id").(string), "subscriber.resume", network.Authz{Type: "user", ID: user, Reason: reason}, "", "")
	if e != nil {
		return nil, e
	}
	return map[string]any{"id": t.Get("id"), "expires_at": t.Get("expires_at"), "days": days, "operation_id": op.Get("id")}, nil
}
func Agreement(ctx context.Context, tx *db.Tx, tenant, user, id string, b map[string]any) (map[string]any, error) {
	k, e := first(ctx, tx, "createAgreement", 0, "contrato não encontrado", id)
	if e != nil {
		return nil, e
	}
	if k.Get("status") != "active" {
		return nil, apierr.New(400, "contrato encerrado")
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, v := range b["invoice_ids"].([]any) {
		value := v.(string)
		if !seen[value] {
			ids = append(ids, value)
			seen[value] = true
		}
	}
	locked, e := tx.Objects(ctx, query("createAgreement", 1), ids, id)
	if e != nil {
		return nil, e
	}
	if len(locked) != len(ids) {
		return nil, apierr.New(400, "alguma fatura não pertence a este contrato")
	}
	for _, i := range locked {
		if i.Get("status") != "open" {
			return nil, apierr.New(400, "o acordo só reúne faturas em aberto")
		}
	}
	original := float64(0)
	fees := map[string]float64{}
	for _, invoice := range ids {
		d, e := leitura.DueBreakdown(ctx, tx, invoice)
		if e != nil {
			return nil, e
		}
		fee := num(d["fee_cents"])
		if b["apply_fees"] == true {
			fee = num(d["fee_if_applied_cents"])
		}
		remaining := max(0, num(d["amount_cents"])+fee-num(d["discount_cents"])-num(d["paid_cents"]))
		if remaining == 0 {
			return nil, apierr.New(400, "uma das faturas já está quitada")
		}
		original += remaining
		fees[invoice] = fee
	}
	discount := float64(0)
	if b["discount_cents"] != nil {
		discount = num(b["discount_cents"])
	}
	total := original - discount
	installments := num(b["installments"])
	if discount < 0 || total < installments {
		return nil, apierr.New(400, "desconto inválido para o valor do acordo")
	}
	a, e := one(ctx, tx, "createAgreement", 2, tenant, id, k.Get("subscriber_id"), total, original, discount, installments, b["reason"], user)
	if e != nil {
		return nil, e
	}
	for _, invoice := range ids {
		if e = exec(ctx, tx, "createAgreement", 3, invoice, fees[invoice], "renegociada no acordo "+a.Get("id").(string)[:8]); e != nil {
			return nil, e
		}
	}
	base := math.Floor(total / installments)
	out := []jsonx.Object{}
	for n := 1; n <= int(installments); n++ {
		amount := base
		if n == int(installments) {
			amount = total - base*(installments-1)
		}
		inv, e := one(ctx, tx, "createAgreement", 4, tenant, id, k.Get("subscriber_id"), b["first_due_date"], n, amount, a.Get("id"))
		if e != nil {
			return nil, e
		}
		if e = exec(ctx, tx, "createAgreement", 5, tenant, inv.Get("id"), fmt.Sprintf("Acordo de pagamento — parcela %d/%g", n, installments), amount); e != nil {
			return nil, e
		}
		out = append(out, inv)
	}
	if _, e = Charges(ctx, tx, tenant); e != nil {
		return nil, e
	}
	var opID any
	if b["release_service"] == true {
		r, e := one(ctx, tx, "createAgreement", 6, id)
		if e != nil {
			return nil, e
		}
		if r.Get("desired_policy") == "suspended" {
			op, e := network.Request(ctx, tx, tenant, r.Get("id").(string), "subscriber.resume", network.Authz{Type: "user", ID: user, Reason: "acordo de pagamento"}, "", "")
			if e != nil {
				return nil, e
			}
			opID = op.Get("id")
		}
	}
	return map[string]any{"id": a.Get("id"), "total_cents": total, "original_cents": original, "installments": out, "operation_id": opID}, nil
}
