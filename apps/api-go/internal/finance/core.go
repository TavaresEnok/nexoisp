// Package finance implements transactional billing and payment settlement.
package finance

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/validate"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

//go:embed financeiro.json sql/*.sql
var files embed.FS
var queries = func() map[string][]string {
	data, err := files.ReadFile("financeiro.json")
	if err != nil {
		panic(err)
	}
	var list []struct {
		Path    string
		Queries []string
	}
	if err = json.Unmarshal(data, &list); err != nil {
		panic(err)
	}
	out := map[string][]string{}
	for _, entry := range list {
		out[strings.TrimPrefix(entry.Path, "helper:")] = entry.Queries
	}
	return out
}()

func query(name string, index int) string {
	data, err := files.ReadFile("sql/" + queries[name][index])
	if err != nil {
		panic(err)
	}
	if strings.Contains(string(data), "{{") {
		panic("SQL financeiro não resolvido")
	}
	return string(data)
}
func one(ctx context.Context, tx *db.Tx, name string, index int, args ...any) (jsonx.Object, error) {
	rows, err := tx.Objects(ctx, query(name, index), args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func num(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int32:
		return float64(n)
	case int64:
		return float64(n)
	}
	return validate.JSNumber(fmt.Sprint(v))
}
func exec(ctx context.Context, tx *db.Tx, name string, index int, args ...any) error {
	return tx.Exec(ctx, query(name, index), args...)
}
func first(ctx context.Context, tx *db.Tx, name string, index int, message string, args ...any) (jsonx.Object, error) {
	r, e := one(ctx, tx, name, index, args...)
	if e == nil && r == nil {
		e = apierr.New(404, message)
	}
	return r, e
}
func SysAudit(ctx context.Context, tx *db.Tx, tenant, action, entity string, id any, detail any, result string) error {
	b, e := jsonx.Encode(detail)
	if e != nil {
		return e
	}
	return exec(ctx, tx, "sysAudit", 0, tenant, action, entity, id, result, b)
}
func Generate(ctx context.Context, tx *db.Tx, tenant, competence string) (any, error) {
	s, e := leitura.GetSettings(ctx, tx, tenant)
	if e != nil {
		return nil, e
	}
	r, e := one(ctx, tx, "generateMonthly", 0, tenant, competence, s.Get("prorate_first_month") == true)
	return r.Get("n"), e
}
func Competence(ctx context.Context, tx *db.Tx, tz any) (any, error) {
	r, e := one(ctx, tx, "currentCompetence", 0, tz)
	return r.Get("d"), e
}
func Charges(ctx context.Context, tx *db.Tx, tenant string) (int, error) {
	// POP-scoped operators can register visible invoices, but cannot consume
	// tenant-wide account credentials. Full-scope billing issues them later.
	var restricted bool
	if err := tx.QueryRow(ctx, "select app_pops() is not null").Scan(&restricted); err != nil {
		return 0, err
	}
	if restricted {
		return 0, nil
	}
	s, e := leitura.GetSettings(ctx, tx, tenant)
	if e != nil {
		return 0, e
	}
	if !Demo(s.Get("gateway")) {
		return 0, nil
	}
	rs, e := tx.Objects(ctx, query("ensureCharges", 0))
	if e != nil {
		return 0, e
	}
	for _, i := range rs {
		connection, err := DemoConnection(ctx, tx, tenant, i.Get("company_id"))
		if err != nil {
			return 0, err
		}
		charge := "demo_ch_" + i.Get("id").(string)
		if e = tx.Exec(ctx, `insert into demo_gateway_charges (charge_id,tenant_id,amount_cents,financial_connection_id) values ($1,$2,$3,$4) on conflict (financial_connection_id,charge_id) where financial_connection_id is not null do nothing`, charge, i.Get("tenant_id"), i.Get("amount_cents"), connection); e != nil {
			return 0, e
		}
		methods, e := jsonx.Encode(map[string]any{"pix_copia_e_cola": "DEMONSTRACAO-NAO-PAGAVEL-PIX-" + i.Get("id").(string)[:8], "boleto_linha_digitavel": "00000.00000 00000.000000 00000.000000 0 DEMONSTRACAO", "aviso": "Meios de pagamento fictícios do gateway de demonstração."})
		if e != nil {
			return 0, e
		}
		if e = exec(ctx, tx, "ensureCharges", 1, i.Get("id"), "demo", charge, methods, connection); e != nil {
			return 0, e
		}
	}
	return len(rs), nil
}
func Demo(g any) bool { return g == "demo" && os.Getenv("NEXO_DEMO_MODE") == "1" }
func settle(ctx context.Context, tx *db.Tx, inv jsonx.Object, partial bool) (string, error) {
	c, e := one(ctx, tx, "settle", 0, inv.Get("id"))
	if e != nil {
		return "", e
	}
	due := num(c.Get("amount_cents")) + num(c.Get("fee_cents")) - num(c.Get("discount_cents"))
	r, e := one(ctx, tx, "settle", 1, inv.Get("id"))
	if e != nil {
		return "", e
	}
	total := num(r.Get("t"))
	status := "reconciling"
	var note any
	switch {
	case inv.Get("status") == "canceled":
		note = "pagamento recebido para fatura cancelada"
	case inv.Get("status") == "paid":
		note = "pagamento adicional recebido para fatura já paga"
	case total == due:
		status = "paid"
	case partial && total > 0 && total < due:
		status = "open"
		note = fmt.Sprintf("pago parcialmente: %g de %g centavos", total, due)
	default:
		note = fmt.Sprintf("valor recebido (%g centavos) difere do valor da fatura (%g centavos)", total, due)
	}
	if e = exec(ctx, tx, "settle", 2, inv.Get("id"), status, note); e != nil {
		return "", e
	}
	if status == "paid" {
		e = Paid(ctx, tx, inv)
	}
	return status, e
}
func Paid(ctx context.Context, tx *db.Tx, inv jsonx.Object) error {
	tenant := inv.Get("tenant_id").(string)
	s, e := leitura.GetSettings(ctx, tx, tenant)
	if e != nil {
		return e
	}
	p, e := one(ctx, tx, "onInvoicePaid", 0, inv.Get("id"))
	if e != nil {
		return e
	}
	if e = domain.Emit(ctx, tx, tenant, "invoice.paid", map[string]any{"invoice_id": inv.Get("id"), "contract_id": inv.Get("contract_id"), "subscriber_id": p.Get("subscriber_id"), "amount_cents": p.Get("amount_cents"), "paid_at": p.Get("paid_at")}); e != nil {
		return e
	}
	left, e := one(ctx, tx, "onInvoicePaid", 1, inv.Get("contract_id"), inv.Get("id"), s.Get("suspend_after_days"), s.Get("timezone"))
	if e != nil {
		return e
	}
	if left == nil {
		if e = exec(ctx, tx, "onInvoicePaid", 2, inv.Get("contract_id")); e != nil {
			return e
		}
	}
	// The settlement trigger persists technical effects. A network planning
	// failure must never roll back this confirmed receipt.
	return nil
}

func Manual(ctx context.Context, tx *db.Tx, id, user string, b map[string]any) (string, error) {
	inv, e := first(ctx, tx, "manualPayment", 0, "fatura não encontrada", id)
	if e != nil {
		return "", e
	}
	if inv.Get("status") != "open" && inv.Get("status") != "reconciling" {
		return "", apierr.New(400, "fatura não está em aberto")
	}
	d, e := leitura.DueBreakdown(ctx, tx, id)
	if e != nil {
		return "", e
	}
	if b["apply_fees"] == true && num(d["fee_if_applied_cents"]) > num(inv.Get("fee_cents")) {
		s, e := leitura.GetSettings(ctx, tx, inv.Get("tenant_id").(string))
		if e != nil {
			return "", e
		}
		if e = exec(ctx, tx, "manualPayment", 1, id, d["fee_if_applied_cents"]); e != nil {
			return "", e
		}
		if e = exec(ctx, tx, "manualPayment", 2, inv.Get("tenant_id"), id, fmt.Sprintf("Multa e juros por atraso (%v dia(s); multa %g%% + juros %g%% a.m.)", d["days_late"], num(s.Get("late_fee_percent")), num(s.Get("interest_monthly_percent"))), num(d["fee_if_applied_cents"])-num(inv.Get("fee_cents"))); e != nil {
			return "", e
		}
	}
	if jsonx.Truthy(b["discount_cents"]) {
		if !jsonx.Truthy(b["discount_reason"]) {
			return "", apierr.New(400, "informe o motivo do desconto")
		}
		fee := float64(0)
		if b["apply_fees"] == true {
			fee = num(d["fee_if_applied_cents"])
		}
		cap := num(inv.Get("amount_cents")) + max(num(inv.Get("fee_cents")), fee) - num(inv.Get("discount_cents"))
		if num(b["discount_cents"]) > cap {
			return "", apierr.New(400, "o desconto não pode ser maior que o valor da fatura")
		}
		if e = exec(ctx, tx, "manualPayment", 3, id, b["discount_cents"]); e != nil {
			return "", e
		}
		if e = exec(ctx, tx, "manualPayment", 4, inv.Get("tenant_id"), id, "Desconto: "+fmt.Sprint(b["discount_reason"]), -num(b["discount_cents"])); e != nil {
			return "", e
		}
	}
	if e = exec(ctx, tx, "manualPayment", 5, inv.Get("tenant_id"), id, b["amount_cents"], b["paid_at"], b["method"], b["note"], user); e != nil {
		return "", e
	}
	inv.Set("status", "open")
	return settle(ctx, tx, inv, b["partial"] == true)
}
func Reverse(ctx context.Context, tx *db.Tx, id, payment, user, reason string) (any, error) {
	inv, e := first(ctx, tx, "reversePayment", 0, "fatura não encontrada", id)
	if e != nil {
		return nil, e
	}
	p, e := first(ctx, tx, "reversePayment", 1, "pagamento não encontrado nesta fatura", payment, id)
	if e != nil {
		return nil, e
	}
	if p.Get("kind") != "payment" {
		return nil, apierr.New(400, "este lançamento já é um estorno")
	}
	if p.Get("source") != "manual" {
		return nil, apierr.New(400, "somente baixas manuais são estornadas aqui; pagamentos do gateway voltam pelo gateway")
	}
	if inv.Get("status") == "canceled" {
		return nil, apierr.New(400, "fatura cancelada")
	}
	if e = exec(ctx, tx, "reversePayment", 2, inv.Get("tenant_id"), id, p.Get("amount_cents"), p.Get("method"), "estorno: "+reason, user, payment); e != nil {
		var pe *pgconn.PgError
		if errors.As(e, &pe) && pe.Code == "23505" {
			return nil, apierr.New(409, "esta baixa já foi estornada")
		}
		return nil, e
	}
	r, e := one(ctx, tx, "reversePayment", 3, id)
	if e != nil {
		return nil, e
	}
	total := num(r.Get("t"))
	note := "baixa estornada: " + reason
	if total > 0 {
		note = fmt.Sprintf("baixa estornada (%s); restam %g centavos pagos", reason, total)
	}
	if e = exec(ctx, tx, "reversePayment", 4, id, note); e != nil {
		return nil, e
	}
	return map[string]any{"status": "open", "paid_cents": total}, nil
}
