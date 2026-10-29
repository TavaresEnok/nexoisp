package leitura

import (
	"math"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
)

// dueBreakdownFromRow is the arithmetic that used to live inline in DueBreakdown.
// It does not query. Shadow preview and writers share this formula and rounding.
func dueBreakdownFromRow(r jsonx.Object) map[string]any {
	amount, fee, discount, paid, days := num(r.Get("amount_cents")), num(r.Get("fee_cents")), num(r.Get("discount_cents")), num(r.Get("paid_cents")), num(r.Get("days_late"))
	fine, interest := float64(0), float64(0)
	if days > 0 {
		fine = math.Floor(amount*num(r.Get("fine_pct"))/100 + 0.5)
		interest = math.Floor(amount*num(r.Get("int_pct"))/100*days/30 + 0.5)
	}
	return map[string]any{"status": r.Get("status"), "due_date": r.Get("due_date"), "amount_cents": amount, "fee_cents": fee, "discount_cents": discount, "paid_cents": paid, "remaining_cents": math.Max(0, amount+fee-discount-paid), "days_late": days, "fine_cents": fine, "interest_cents": interest, "fee_if_applied_cents": math.Max(fee, fine+interest)}
}

func dueBreakdownFromQuery(rows []jsonx.Object, err error) (map[string]any, error) {
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "fatura não encontrada")
	}
	return dueBreakdownFromRow(rows[0]), nil
}
