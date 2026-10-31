package leitura

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
)

// legacyContractFinanceTotalsSHA256 is the sentence that lived inline in grupos.go.
const legacyContractFinanceTotalsSHA256 = "2dc178a68d6d3a8c242fc37ebfc259eff0474e03e7ed8c5679391522d8befcac"

func TestBalanceReadHooksChooseLegacySQL(t *testing.T) {
	sum := sha256.Sum256([]byte(contractFinanceTotalsSQL))
	if hex.EncodeToString(sum[:]) != legacyContractFinanceTotalsSHA256 {
		t.Fatal("contractFinanceTotalsSQL divergiu da sentença legada")
	}
	invoiceList := dynamicSQL("/api/invoices", 1, map[string]string{"limit": "500", "offset": "0"})
	legacy := map[string]string{
		balanceReaderInvoiceDetail:          gen.Group91a4cc440,
		balanceReaderContractFinanceList:    gen.Groupc47037ac0,
		balanceReaderContractFinanceTotals:  contractFinanceTotalsSQL,
		balanceReaderReconciliationInvoices: gen.Group152f5ccd0,
		balanceReaderFinanceSummary:         gen.Readf038858e,
		balanceReaderInvoiceList:            invoiceList,
		balanceReaderTodayOverdue:           dynamicSQL("/api/today", 3, nil),
		balanceReaderTerminationQuoteGet:    dynamicSQL("helper:terminationQuote", 0, nil),
	}
	if dynamicSQL("/api/invoices", 0, nil) == invoiceList || dynamicSQL("/api/invoices", 2, nil) == invoiceList {
		t.Fatal("o gancho da lista não pode usar o índice 0 ou 2")
	}
	if dynamicSQL("/api/today", 0, nil) == legacy[balanceReaderTodayOverdue] || dynamicSQL("/api/today", 4, nil) == legacy[balanceReaderTodayOverdue] {
		t.Fatal("o gancho de hoje não pode usar outro índice")
	}
	variant := "select invoice_movements, true as cmp_matches from financial_balance_shadow"
	for reader, sqlText := range legacy {
		if strings.Contains(strings.ToLower(sqlText), "invoice_movements") || strings.Contains(sqlText, "cmp_") || strings.Contains(sqlText, "financial_balance_shadow") {
			t.Fatalf("%s legado consulta movimento ou variante", reader)
		}
		for _, mode := range []string{"off", "shadow", "cut", "", "SHADOW", " cut "} {
			policy := balanceReadPolicy{
				Mode:     mode,
				Shadow:   map[string]struct{}{},
				Cut:      map[string]struct{}{},
				Variants: map[string]string{reader: variant},
			}
			got, err := policy.pick(reader, sqlText)
			if err != nil {
				t.Fatalf("%s modo %q: %v", reader, mode, err)
			}
			if got.Shadow || got.SQL != sqlText || got.Reader != reader {
				t.Fatalf("%s modo %q escolheu %#v", reader, mode, got)
			}
		}
		selected, err := Pick(reader, sqlText)
		if err != nil {
			t.Fatal(err)
		}
		row := jsonx.Object{{Name: "paid_cents", Value: int64(10)}}
		rows := []jsonx.Object{row}
		if err := Strip(selected, rows); err != nil {
			t.Fatalf("%s strip off: %v", reader, err)
		}
		if len(rows) != 1 || len(rows[0]) != 1 || rows[0][0].Name != "paid_cents" || rows[0][0].Value != int64(10) {
			t.Fatalf("%s corpo off %#v", reader, rows)
		}
	}
	t.Setenv("NEXO_BALANCE_READ", "shadow")
	for reader, sqlText := range legacy {
		got, err := Pick(reader, sqlText)
		if err != nil || got.Shadow || got.SQL != sqlText {
			t.Fatalf("shadow ambiente %s: err=%v sel=%#v", reader, err, got)
		}
	}
	t.Setenv("NEXO_BALANCE_READ", "cut")
	for reader, sqlText := range legacy {
		got, err := Pick(reader, sqlText)
		if err != nil || got.Shadow || got.SQL != sqlText {
			t.Fatalf("cut ambiente %s: err=%v sel=%#v", reader, err, got)
		}
	}
}

func TestBalanceReadHooksScope(t *testing.T) {
	grupos := mustRead(t, "grupos.go")
	consultas := mustRead(t, "consultas.go")
	dinamicas := mustRead(t, "dinamicas.go")
	today := mustRead(t, "today.go")
	totals := mustRead(t, "contract_finance_totals.go")
	service := mustRead(t, "service.go")
	finance := mustRead(t, "finance_readers.go")
	generated := mustRead(t, "grupos_generated.go") + mustRead(t, "consultas_generated.go")

	if strings.Count(grupos, "balanceRowsInTx(") != 3 || strings.Contains(grupos, ".balanceRows(") || strings.Contains(grupos, "nominal_open_cents") {
		t.Fatal("grupos.go deve ganchar só o índice 0 dos três paths e tirar a string de totais")
	}
	for _, reader := range []string{"balanceReaderInvoiceDetail", "balanceReaderContractFinanceList", "balanceReaderReconciliationInvoices"} {
		if strings.Count(grupos, reader) != 1 {
			t.Fatalf("grupos.go leitor %s", reader)
		}
	}
	if !strings.Contains(grupos, "if i != 0 {") || !strings.Contains(grupos, `case "/api/invoices/{id}":`) || !strings.Contains(grupos, `case "/api/contracts/{id}/finance":`) || !strings.Contains(grupos, `case "/api/finance/reconciliation":`) {
		t.Fatal("fechamento query fora dos três paths de índice 0")
	}
	if strings.Contains(grupos, "balanceReaderFinanceSummary") || strings.Contains(grupos, "balanceReaderInvoiceList") || strings.Contains(grupos, "balanceReaderTodayOverdue") || strings.Contains(grupos, "balanceReaderTerminationQuoteGet") || strings.Contains(grupos, "balanceReaderInvoiceDue") || strings.Contains(grupos, "balanceReaderContractFinanceTotals") {
		t.Fatal("grupos.go recebeu leitor de outra frente")
	}
	if !strings.Contains(grupos, "contractFinanceTotals(ctx, tx, id)") {
		t.Fatal("totais do contrato não passam pelo helper")
	}
	if strings.Count(grupos, "tx.Objects(") < 2 {
		t.Fatal("os outros caminhos de grupo deixaram de consultar direto")
	}

	if strings.Count(consultas, "s.financeSummaryRows(") != 1 || strings.Count(consultas, "s.rows(") != 1 || strings.Contains(consultas, "s.balanceRows(") || strings.Contains(consultas, "balanceRowsInTx(") || strings.Contains(consultas, "WithScope") {
		t.Fatal("consultas.go deve usar s.financeSummaryRows só no resumo, sem escopo aninhado")
	}
	if !strings.Contains(consultas, "if spec.Path == \"/api/finance/summary\" {\n\t\t\t\trows, err = s.financeSummaryRows(ctx, spec.SQL, args...)\n\t\t\t} else {\n\t\t\t\trows, err = s.rows(ctx, spec.SQL, args...)") || strings.Contains(consultas, "balanceReaderFinanceSummary") {
		t.Fatal("resumo financeiro sem o leitor fechado")
	}
	// The adapter owns exactly one authenticated scope. Passing the whole Scope
	// retains tenant, actor and POP instead of reconstructing a partial scope.
	financeFn := finance[strings.Index(finance, "func (s Service) financeSummaryRows("):]
	if strings.Count(finance, "balanceReaderFinanceSummary") != 1 || strings.Count(finance, "WithScope(") != 1 || strings.Count(financeFn, "Pick(") != 1 || strings.Count(financeFn, "Strip(") != 1 ||
		!strings.Contains(financeFn, "selection, err := Pick(balanceReaderFinanceSummary, legacy)") ||
		!strings.Contains(financeFn, "s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {") ||
		!strings.Contains(financeFn, "rows, err = financeReadRows(ctx, tx, selection.SQL, args...)") ||
		!strings.Contains(financeFn, "if err != nil {\n\t\t\treturn err\n\t\t}\n\t\treturn Strip(selection, rows)") ||
		strings.Contains(financeFn, "balanceRows") || strings.Contains(financeFn, "tx.Objects(") {
		t.Fatal("adaptador financeiro deve preservar Pick/Strip, SQL selecionado e escopo autenticado integral, sem escopo aninhado")
	}

	quoteFn := dinamicas[strings.Index(dinamicas, "func (s Service) terminationQuote("):strings.Index(dinamicas, "func (s Service) invoices(")]
	invoicesFn := dinamicas[strings.Index(dinamicas, "func (s Service) invoices("):strings.Index(dinamicas, "func (s Service) crmReport(")]
	if strings.Count(dinamicas, "balanceRowsInTx(") != 2 || strings.Contains(quoteFn, ".balanceRows(") || strings.Contains(invoicesFn, ".balanceRows(") || strings.Contains(quoteFn, "WithScope") || strings.Contains(invoicesFn, "WithScope") {
		t.Fatal("dinamicas.go deve ter dois ganchos no tx já aberto")
	}
	if !strings.Contains(dinamicas, `balanceRowsInTx(ctx, tx, balanceReaderInvoiceList, query, args...)`) || !strings.Contains(dinamicas, `dynamicSQL("/api/invoices", 1,`) {
		t.Fatal("lista de faturas não usa só o índice 1")
	}
	if !strings.Contains(dinamicas, `balanceRowsInTx(ctx, tx, balanceReaderTerminationQuoteGet, dynamicSQL("helper:terminationQuote", 0, nil)`) {
		t.Fatal("cotação não usa só o índice 0")
	}
	if strings.Contains(dinamicas, `complexRows(ctx, tx, "helper:terminationQuote"`) || !strings.Contains(dinamicas, `complexRows(ctx, tx, "helper:localToday", 0, 0)`) {
		t.Fatal("a data local ou a cotação trocou de caminho")
	}
	if !strings.Contains(dinamicas, `complexRows(ctx, tx, "/api/invoices", 0,`) || !strings.Contains(dinamicas, `dynamicSQL("/api/invoices", 2, nil)`) {
		t.Fatal("índices 0 e 2 da lista de faturas mudaram")
	}

	if strings.Count(today, "balanceRowsInTx(") != 1 || strings.Contains(today, ".balanceRows(") || strings.Contains(today, "WithScope") || strings.Contains(today, "one(3)") {
		t.Fatal("today.go deve ganchar só o índice 3")
	}
	if !strings.Contains(today, `balanceRowsInTx(ctx, tx, balanceReaderTodayOverdue, dynamicSQL(path, 3, nil))`) {
		t.Fatal("vencidos de hoje sem o leitor fechado")
	}
	for _, call := range []string{"one(0)", "one(1, c.UserID)", "one(2, c.UserID)", "one(4)"} {
		if !strings.Contains(today, call) {
			t.Fatalf("today perdeu %s", call)
		}
	}

	if strings.Count(totals, "balanceRowsInTx(") != 1 || strings.Contains(totals, "WithScope") || strings.Contains(totals, ".balanceRows(") || strings.Contains(totals, "cmp_") {
		t.Fatal("helper de totais deve ser uma sentença no tx, sem coluna cmp_")
	}
	if !strings.Contains(totals, "func contractFinanceTotals(ctx context.Context, tx *db.Tx, id string) ([]jsonx.Object, error)") || !strings.Contains(totals, "balanceReaderContractFinanceTotals, contractFinanceTotalsSQL, id") {
		t.Fatal("assinatura do helper de totais")
	}

	rowsFn := service[strings.Index(service, "func (s Service) rows("):strings.Index(service, "func (s Service) simple(")]
	if strings.Contains(rowsFn, "balanceRows") || !strings.Contains(rowsFn, "tx.Objects(ctx, query, args...)") {
		t.Fatal("Service.rows genérico mudou")
	}
	if strings.Contains(generated, "balanceRows") || strings.Contains(generated, "cmp_") {
		t.Fatal("metadado gerado mudou")
	}
	for _, src := range []string{grupos, consultas, dinamicas, today, totals, finance} {
		if strings.Contains(src, "func Pick(") || strings.Contains(src, "func Strip(") || strings.Contains(src, "func DueHTTP(") || strings.Contains(src, "func dueBreakdownFromRow(") || strings.Contains(src, "registerBalanceVariant(") {
			t.Fatal("gancho redeclarou superfície canônica")
		}
	}
}

func mustRead(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
