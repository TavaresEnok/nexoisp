package leitura

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"

	"github.com/prometheus/client_golang/prometheus"
)

// balanceReadDatabaseGate is pending until a non-privileged PostgreSQL run
// attaches EXPLAIN ANALYZE. A skipped test is not acceptance.
const balanceReadDatabaseGate = "pending"

const (
	balanceReaderInvoiceDetail          = "invoice-detail"
	balanceReaderContractFinanceList    = "contract-finance-list"
	balanceReaderContractFinanceTotals  = "contract-finance-totals"
	balanceReaderReconciliationInvoices = "reconciliation-invoices"
	balanceReaderFinanceSummary         = "finance-summary"
	balanceReaderInvoiceList            = "invoice-list"
	balanceReaderTodayOverdue           = "today-overdue"
	balanceReaderTerminationQuoteGet    = "termination-quote-get"
	balanceReaderInvoiceDue             = "invoice-due"

	balanceReadMatch    = "match"
	balanceReadMismatch = "mismatch"
)

var errBalanceVariantMissing = errors.New("leitura de saldo: leitor permitido sem variante")
var errBalanceReaderClosed = errors.New("leitura de saldo: leitor fora do conjunto fechado")
var errBalanceVariantInvalid = errors.New("leitura de saldo: variante vazia ou repetida")
var errBalanceCompareLeak = errors.New("leitura de saldo: coluna cmp_ com a seleção desligada")
var errBalanceCompareProjection = errors.New("leitura de saldo: projeção cmp_ inválida")

var balanceReadCompare = prometheus.NewCounterVec(prometheus.CounterOpts{
	Name: "balance_read_compare_total",
	Help: "Comparações de leitura de saldo, por leitor fechado e resultado match ou mismatch.",
}, []string{"reader", "result"})

// balanceVariants is filled only by registerBalanceVariant from variants_*.go init.
var balanceVariants = map[string]string{}

var closedBalanceReaders = map[string]struct{}{
	balanceReaderInvoiceDetail:          {},
	balanceReaderContractFinanceList:    {},
	balanceReaderContractFinanceTotals:  {},
	balanceReaderReconciliationInvoices: {},
	balanceReaderFinanceSummary:         {},
	balanceReaderInvoiceList:            {},
	balanceReaderTodayOverdue:           {},
	balanceReaderTerminationQuoteGet:    {},
	balanceReaderInvoiceDue:             {},
}

// BalanceReadSelection is the single statement Pick chose for one reader.
type BalanceReadSelection struct {
	SQL    string
	Reader string
	Shadow bool
}

type balanceReadPolicy struct {
	Mode     string
	Shadow   map[string]struct{}
	Cut      map[string]struct{}
	Variants map[string]string
}

func productionShadowAllowlist() map[string]struct{} { return map[string]struct{}{} }

func productionCutAllowlist() map[string]struct{} { return map[string]struct{}{} }

func productionBalancePolicy() balanceReadPolicy {
	return balanceReadPolicy{
		Mode:     os.Getenv("NEXO_BALANCE_READ"),
		Shadow:   productionShadowAllowlist(),
		Cut:      productionCutAllowlist(),
		Variants: balanceVariants,
	}
}

func canonicalBalanceMode(mode string) string {
	switch mode {
	case "shadow", "cut":
		return mode
	default:
		return "off"
	}
}

func closedBalanceReader(reader string) bool {
	_, ok := closedBalanceReaders[reader]
	return ok
}

// registerBalanceVariant is called from init of variants_*.go only.
func registerBalanceVariant(reader, sql string) {
	if err := addBalanceVariant(balanceVariants, reader, sql); err != nil {
		panic(err)
	}
}

func addBalanceVariant(dst map[string]string, reader, sql string) error {
	if !closedBalanceReader(reader) {
		return errBalanceReaderClosed
	}
	if strings.TrimSpace(sql) == "" {
		return errBalanceVariantInvalid
	}
	if _, exists := dst[reader]; exists {
		return errBalanceVariantInvalid
	}
	dst[reader] = sql
	return nil
}

func (p balanceReadPolicy) pick(reader, legacy string) (BalanceReadSelection, error) {
	selected := BalanceReadSelection{SQL: legacy, Reader: reader, Shadow: false}
	mode := canonicalBalanceMode(p.Mode)
	if mode == "off" {
		return selected, nil
	}
	allow := p.Shadow
	if mode == "cut" {
		allow = p.Cut
	}
	if _, ok := allow[reader]; !ok {
		return selected, nil
	}
	if !closedBalanceReader(reader) {
		return BalanceReadSelection{}, errBalanceReaderClosed
	}
	variant, ok := p.Variants[reader]
	if !ok || strings.TrimSpace(variant) == "" {
		return BalanceReadSelection{}, errBalanceVariantMissing
	}
	return BalanceReadSelection{SQL: variant, Reader: reader, Shadow: true}, nil
}

// Pick chooses the legacy statement unless the process mode and the compiled
// allowlist both name this reader and a variant is registered.
func Pick(reader, legacy string) (BalanceReadSelection, error) {
	return productionBalancePolicy().pick(reader, legacy)
}

// Strip drops cmp_ columns after a shadow or cut variant. A disabled selection
// that still carries cmp_ fails and leaves the rows unchanged.
func Strip(selection BalanceReadSelection, rows []jsonx.Object) error {
	if !selection.Shadow {
		for _, row := range rows {
			for _, field := range row {
				if strings.HasPrefix(field.Name, "cmp_") {
					return errBalanceCompareLeak
				}
			}
		}
		return nil
	}
	if !closedBalanceReader(selection.Reader) {
		return errBalanceReaderClosed
	}
	matched := make([]bool, len(rows))
	for i, row := range rows {
		if len(row) == 0 {
			continue
		}
		raw, ok := cmpMatches(row)
		if !ok {
			return errBalanceCompareProjection
		}
		matched[i] = raw
	}
	for i, row := range rows {
		if len(row) == 0 {
			continue
		}
		result := balanceReadMismatch
		if matched[i] {
			result = balanceReadMatch
		}
		if err := observeBalanceRead(selection.Reader, result); err != nil {
			return err
		}
		rows[i] = withoutCompareColumns(row)
	}
	return nil
}

func cmpMatches(row jsonx.Object) (bool, bool) {
	for _, field := range row {
		if field.Name != "cmp_matches" {
			continue
		}
		value, ok := field.Value.(bool)
		return value, ok
	}
	return false, false
}

func withoutCompareColumns(row jsonx.Object) jsonx.Object {
	out := make(jsonx.Object, 0, len(row))
	for _, field := range row {
		if strings.HasPrefix(field.Name, "cmp_") {
			continue
		}
		out = append(out, field)
	}
	return out
}

func observeBalanceRead(reader, result string) error {
	if !closedBalanceReader(reader) {
		return errBalanceReaderClosed
	}
	if result != balanceReadMatch && result != balanceReadMismatch {
		return errBalanceCompareProjection
	}
	balanceReadCompare.WithLabelValues(reader, result).Inc()
	return nil
}

// RegisterBalanceReadMetrics registers balance_read_compare_total on the API registry.
func RegisterBalanceReadMetrics(reg prometheus.Registerer) error {
	if reg == nil {
		return errors.New("leitura de saldo: registry ausente")
	}
	return reg.Register(balanceReadCompare)
}

func balanceRowsInTx(ctx context.Context, tx *db.Tx, reader, legacy string, args ...any) ([]jsonx.Object, error) {
	selection, err := Pick(reader, legacy)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Objects(ctx, selection.SQL, args...)
	if err != nil {
		return nil, err
	}
	if err := Strip(selection, rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func (s Service) balanceRows(ctx context.Context, reader, legacy string, args ...any) ([]jsonx.Object, error) {
	var rows []jsonx.Object
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		var err error
		rows, err = balanceRowsInTx(ctx, tx, reader, legacy, args...)
		return err
	})
	return rows, err
}

// DueHTTP is the GET-only entry. Off delegates to DueBreakdown. Shadow runs one
// statement, strips cmp_ and reuses the pure preview.
func DueHTTP(ctx context.Context, tx *db.Tx, id string) (map[string]any, error) {
	return dueHTTPWith(ctx, tx, id, productionBalancePolicy())
}

func dueHTTPWith(ctx context.Context, tx *db.Tx, id string, policy balanceReadPolicy) (map[string]any, error) {
	selection, err := policy.pick(balanceReaderInvoiceDue, gen.Due)
	if err != nil {
		return nil, err
	}
	if !selection.Shadow {
		return DueBreakdown(ctx, tx, id)
	}
	rows, err := tx.Objects(ctx, selection.SQL, id)
	if err != nil {
		return nil, err
	}
	return dueMapFromShadowRows(selection, rows)
}

func dueMapFromShadowRows(selection BalanceReadSelection, rows []jsonx.Object) (map[string]any, error) {
	if err := Strip(selection, rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "fatura não encontrada")
	}
	return dueBreakdownFromRow(rows[0]), nil
}

func dueBreakdownFromRow(r jsonx.Object) map[string]any {
	amount, fee, discount, paid, days := num(r.Get("amount_cents")), num(r.Get("fee_cents")), num(r.Get("discount_cents")), num(r.Get("paid_cents")), num(r.Get("days_late"))
	fine, interest := float64(0), float64(0)
	if days > 0 {
		fine = math.Floor(amount*num(r.Get("fine_pct"))/100 + 0.5)
		interest = math.Floor(amount*num(r.Get("int_pct"))/100*days/30 + 0.5)
	}
	return map[string]any{"status": r.Get("status"), "due_date": r.Get("due_date"), "amount_cents": amount, "fee_cents": fee, "discount_cents": discount, "paid_cents": paid, "remaining_cents": math.Max(0, amount+fee-discount-paid), "days_late": days, "fine_cents": fine, "interest_cents": interest, "fee_if_applied_cents": math.Max(fee, fine+interest)}
}
