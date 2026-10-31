package leitura

import (
	"context"
	"math"
	"os"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
)

// Os números abaixo são o oráculo independente da sentença. A função só
// reproduz a expressão da view; o valor esperado é literal do caso.
type balanceGateMoney struct {
	name                                     string
	nominal, fee, discount, received         int64
	status                                   string
	legacyNominal, legacyFee, legacyDiscount int64
	legacyReceived                           int64
	legacyStatus                             string
	residual, excess, collectible            int64
	matches                                  bool
	servedPaid                               int32
}

func TestBalanceReadGateRegistryStaysLive(t *testing.T) {
	before := cloneVariants(balanceVariants)
	readers := balanceGateReaders(t)
	if len(readers) != 9 {
		t.Fatalf("ids fechados: %d", len(readers))
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlist compilada deixou de ser vazia")
	}
	for _, reader := range readers {
		registered, ok := balanceVariants[reader.id]
		if !ok || strings.TrimSpace(registered) == "" || registered != reader.variant {
			t.Fatalf("registro vivo de %s", reader.id)
		}
		lower := strings.ToLower(registered)
		if strings.Contains(lower, "from financial_balance_shadow") || strings.Contains(lower, "join financial_balance_shadow") {
			t.Fatalf("%s lê a view no caminho quente", reader.id)
		}
	}
	if !sameVariants(before, balanceVariants) {
		t.Fatal("o gate alterou o registro global")
	}
}

func TestBalanceReadGateClosedModesStayLegacy(t *testing.T) {
	before := cloneVariants(balanceVariants)
	readers := balanceGateReaders(t)
	modes := []string{"", "off", "shadow", "cut", "SHADOW", "CUT", " shadow", "ligado"}
	for _, reader := range readers {
		for _, mode := range modes {
			t.Setenv("NEXO_BALANCE_READ", mode)
			got, err := Pick(reader.id, reader.legacy)
			if err != nil || got.Shadow || got.SQL != reader.legacy || got.Reader != reader.id {
				t.Fatalf("%s modo %q: err=%v sel=%#v", reader.id, mode, err, got)
			}
			if strings.Contains(got.SQL, "cmp_") {
				t.Fatalf("%s enviaria cmp_ com allowlist vazia", reader.id)
			}
		}
		localEmpty := balanceReadPolicy{
			Mode: "shadow", Shadow: map[string]struct{}{}, Cut: map[string]struct{}{},
			Variants: map[string]string{reader.id: reader.variant},
		}
		got, err := localEmpty.pick(reader.id, reader.legacy)
		if err != nil || got.Shadow || got.SQL != reader.legacy {
			t.Fatalf("política local com allowlist vazia: err=%v sel=%#v", err, got)
		}
		cutEmpty := balanceReadPolicy{
			Mode: "cut", Shadow: map[string]struct{}{reader.id: {}}, Cut: map[string]struct{}{},
			Variants: map[string]string{reader.id: reader.variant},
		}
		got, err = cutEmpty.pick(reader.id, reader.legacy)
		if err != nil || got.Shadow || got.SQL != reader.legacy {
			t.Fatalf("cut local sem allowlist: err=%v sel=%#v", err, got)
		}
	}
	if !sameVariants(before, balanceVariants) {
		t.Fatal("modos fechados gravaram variante")
	}
}

func TestBalanceReadGateLocalShadowOneStatement(t *testing.T) {
	before := cloneVariants(balanceVariants)
	for _, reader := range balanceGateReaders(t) {
		t.Run(reader.id, func(t *testing.T) {
			selected, err := (balanceReadPolicy{
				Mode: "shadow", Shadow: map[string]struct{}{reader.id: {}}, Cut: map[string]struct{}{},
				Variants: map[string]string{reader.id: reader.variant},
			}).pick(reader.id, reader.legacy)
			if err != nil || !selected.Shadow || selected.SQL != reader.variant || selected.Reader != reader.id {
				t.Fatalf("seleção local: err=%v sel=%#v", err, selected)
			}
			if selected.SQL == reader.legacy {
				t.Fatal("shadow local devolveu a sentença legada")
			}
			body := strings.TrimSpace(selected.SQL)
			semicolons := strings.Count(body, ";")
			if semicolons > 1 || (semicolons == 1 && !strings.HasSuffix(body, ";")) {
				t.Fatal("a variante não é uma sentença")
			}
			missing, err := (balanceReadPolicy{
				Mode: "shadow", Shadow: map[string]struct{}{reader.id: {}}, Cut: map[string]struct{}{},
				Variants: map[string]string{},
			}).pick(reader.id, reader.legacy)
			if err != errBalanceVariantMissing || missing.SQL != "" || missing.Shadow {
				t.Fatalf("shadow sem variante: err=%v sel=%#v", err, missing)
			}
			for _, piece := range balanceShadowFormulaPieces() {
				if !strings.Contains(reader.variant, piece) {
					t.Fatalf("oráculo ausente em %s: %s", reader.id, piece)
				}
			}
			if !strings.Contains(reader.variant, "cmp_matches") {
				t.Fatal("cmp_matches obrigatório")
			}
			if reader.casts && strings.Count(reader.variant, "::int") < strings.Count(reader.legacy, "::int") {
				t.Fatal("a variante removeu o cast ::int da sentença legada")
			}
			if !reader.casts && strings.Contains(reader.variant, "::int") {
				t.Fatal("totais em bigint ganharam cast ::int")
			}
		})
	}
	if !sameVariants(before, balanceVariants) {
		t.Fatal("política local mutou o registro")
	}
}

func TestBalanceReadGateMoneyFixtures(t *testing.T) {
	cases := []balanceGateMoney{
		{name: "open", nominal: 10000, status: "open", legacyNominal: 10000, legacyStatus: "open", residual: 10000, collectible: 10000, matches: true, servedPaid: 0},
		{name: "paid", nominal: 10000, received: 10000, status: "paid", legacyNominal: 10000, legacyReceived: 10000, legacyStatus: "paid", matches: true, servedPaid: 10000},
		{name: "reconciling", nominal: 10000, received: 10000, status: "reconciling", legacyNominal: 10000, legacyReceived: 10000, legacyStatus: "reconciling", matches: true, servedPaid: 10000},
		{name: "canceled", nominal: 10000, status: "canceled", legacyNominal: 10000, legacyStatus: "canceled", residual: 10000, matches: true, servedPaid: 0},
		{name: "partial", nominal: 10000, fee: 500, discount: 1000, received: 4000, status: "open", legacyNominal: 10000, legacyFee: 500, legacyDiscount: 1000, legacyReceived: 4000, legacyStatus: "open", residual: 5500, collectible: 5500, matches: true, servedPaid: 4000},
		{name: "excess", nominal: 10000, fee: 500, discount: 1000, received: 12000, status: "open", legacyNominal: 10000, legacyFee: 500, legacyDiscount: 1000, legacyReceived: 12000, legacyStatus: "open", excess: 2500, matches: true, servedPaid: 12000},
		{name: "reversal", nominal: 10000, fee: 500, discount: 1000, received: 0, status: "open", legacyNominal: 10000, legacyFee: 500, legacyDiscount: 1000, legacyStatus: "open", residual: 9500, collectible: 9500, matches: true, servedPaid: 0},
		{name: "refund-psp", nominal: 10000, received: 10000, status: "reconciling", legacyNominal: 10000, legacyReceived: 10000, legacyStatus: "reconciling", matches: true, servedPaid: 10000},
		{name: "import-compensation", nominal: 10000, status: "canceled", legacyNominal: 10000, legacyStatus: "canceled", residual: 10000, matches: true, servedPaid: 0},
		{name: "drift", nominal: 11000, status: "open", legacyNominal: 10000, legacyStatus: "open", residual: 11000, collectible: 11000, matches: false, servedPaid: 0},
	}
	if len(cases) < 10 {
		t.Fatal("conjunto de estados vazio")
	}
	emptyBefore := counterValue(balanceReaderInvoiceDetail, balanceReadMatch)
	if err := Strip(BalanceReadSelection{SQL: "variant", Reader: balanceReaderInvoiceDetail, Shadow: true}, []jsonx.Object{}); err != nil {
		t.Fatal(err)
	}
	if counterValue(balanceReaderInvoiceDetail, balanceReadMatch) != emptyBefore {
		t.Fatal("conjunto vazio contou comparação")
	}
	seen := map[string]bool{}
	for _, tc := range cases {
		seen[tc.name] = true
		residual, excess, collectible, matches := balanceGateReconstruct(tc)
		if residual != tc.residual || excess != tc.excess || collectible != tc.collectible || matches != tc.matches {
			t.Fatalf("%s oráculo=%d/%d/%d matches=%v", tc.name, residual, excess, collectible, matches)
		}
		for _, reader := range balanceGateReaders(t) {
			row := balanceGateRow(tc, false)
			selection, err := (balanceReadPolicy{
				Mode: "shadow", Shadow: map[string]struct{}{reader.id: {}}, Cut: map[string]struct{}{},
				Variants: map[string]string{reader.id: reader.variant},
			}).pick(reader.id, reader.legacy)
			if err != nil || selection.SQL != reader.variant {
				t.Fatal(err)
			}
			before := counterValue(reader.id, balanceReadMatch)
			mismatchBefore := counterValue(reader.id, balanceReadMismatch)
			rows := []jsonx.Object{row}
			if err := Strip(selection, rows); err != nil {
				t.Fatalf("%s %s: %v", reader.id, tc.name, err)
			}
			if rows[0].Get("paid_cents") != tc.servedPaid || rows[0].Get("amount_cents") != int32(10000) || rows[0].Get("status") != tc.legacyStatus {
				t.Fatalf("%s %s recompôs o corpo: %#v", reader.id, tc.name, rows[0])
			}
			for _, field := range rows[0] {
				if strings.HasPrefix(field.Name, "cmp_") {
					t.Fatalf("%s %s vazou %s", reader.id, tc.name, field.Name)
				}
			}
			if tc.matches && counterValue(reader.id, balanceReadMatch)-before != 1 {
				t.Fatalf("%s %s sem match", reader.id, tc.name)
			}
			if !tc.matches && counterValue(reader.id, balanceReadMismatch)-mismatchBefore != 1 {
				t.Fatalf("%s %s sem mismatch", reader.id, tc.name)
			}
			leaked := balanceGateRow(tc, false)
			if err := Strip(BalanceReadSelection{SQL: reader.legacy, Reader: reader.id, Shadow: false}, []jsonx.Object{leaked}); err != errBalanceCompareLeak {
				t.Fatalf("off com cmp_: %v", err)
			}
			if leaked.Get("paid_cents") != tc.servedPaid || leaked.Get("cmp_matches") != tc.matches {
				t.Fatal("seleção desligada alterou a linha")
			}
		}
	}
	for _, name := range []string{"open", "paid", "reconciling", "canceled", "partial", "excess", "reversal", "refund-psp", "import-compensation", "drift"} {
		if !seen[name] {
			t.Fatalf("estado ausente: %s", name)
		}
	}
	proved, unproven := gateAgreement(6000, 1000, 5000, 6000, 5000, false), gateAgreement(5500, 500, 5000, 0, 0, true)
	if !proved.matches || proved.unproven || proved.source != 6000 {
		t.Fatalf("acordo com fonte: %+v", proved)
	}
	if unproven.matches || !unproven.unproven {
		t.Fatalf("source_unproven: %+v", unproven)
	}
	if intCastOverflow(math.MaxInt32) || !intCastOverflow(math.MaxInt32+1) || !intCastOverflow(math.MinInt32-1) {
		t.Fatal("limite do cast ::int mudou")
	}
}

func TestBalanceReadGateDuePreviewOneQuery(t *testing.T) {
	before := cloneVariants(balanceVariants)
	variant := balanceVariants[balanceReaderInvoiceDue]
	if strings.TrimSpace(variant) == "" || strings.Contains(variant, "fine_cents") {
		t.Fatal("a variante due absorveu a prévia de multa")
	}
	legacyCalls := 0
	queryCalls := 0
	var seenSQL string
	row := jsonx.Object{
		{Name: "status", Value: "open"},
		{Name: "due_date", Value: "2026-01-15"},
		{Name: "amount_cents", Value: int32(10000)},
		{Name: "fee_cents", Value: int32(50)},
		{Name: "discount_cents", Value: int32(25)},
		{Name: "paid_cents", Value: int32(1000)},
		{Name: "days_late", Value: int32(15)},
		{Name: "fine_pct", Value: float64(2)},
		{Name: "int_pct", Value: float64(1)},
		{Name: "cmp_matches", Value: true},
		{Name: "cmp_fee_cents", Value: int32(999)},
	}
	policy := balanceReadPolicy{
		Mode: "shadow", Shadow: map[string]struct{}{balanceReaderInvoiceDue: {}}, Cut: map[string]struct{}{},
		Variants: map[string]string{balanceReaderInvoiceDue: variant},
	}
	body, err := dueHTTPWith(context.Background(), "invoice", policy, func(_ context.Context, sql string, args ...any) ([]jsonx.Object, error) {
		queryCalls++
		seenSQL = sql
		if len(args) != 1 || args[0] != "invoice" {
			t.Fatalf("argumentos: %#v", args)
		}
		return []jsonx.Object{append(jsonx.Object{}, row...)}, nil
	}, func(context.Context, string) (map[string]any, error) {
		legacyCalls++
		return map[string]any{"status": "legacy"}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if queryCalls != 1 || legacyCalls != 0 || seenSQL != variant {
		t.Fatalf("shadow de teste: queries=%d legacy=%d sql=%s", queryCalls, legacyCalls, seenSQL)
	}
	want := dueBreakdownFromRow(jsonx.Object{
		{Name: "status", Value: "open"}, {Name: "due_date", Value: "2026-01-15"},
		{Name: "amount_cents", Value: int32(10000)}, {Name: "fee_cents", Value: int32(50)},
		{Name: "discount_cents", Value: int32(25)}, {Name: "paid_cents", Value: int32(1000)},
		{Name: "days_late", Value: int32(15)}, {Name: "fine_pct", Value: float64(2)}, {Name: "int_pct", Value: float64(1)},
	})
	if body["fine_cents"] != want["fine_cents"] || body["interest_cents"] != want["interest_cents"] || body["remaining_cents"] != want["remaining_cents"] || body["fee_cents"] != float64(50) {
		t.Fatalf("prévia divergiu do cálculo puro: %#v", body)
	}
	if _, ok := body["cmp_matches"]; ok {
		t.Fatal("HTTP de teste devolveu cmp_")
	}
	broken := append(jsonx.Object{}, row...)
	broken[len(broken)-2] = jsonx.Field{Name: "cmp_matches", Value: "false"}
	fallback := 0
	if _, err := dueHTTPWith(context.Background(), "invoice", policy, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		return []jsonx.Object{broken}, nil
	}, func(context.Context, string) (map[string]any, error) {
		fallback++
		return map[string]any{"status": "legacy"}, nil
	}); err == nil || fallback != 0 {
		t.Fatalf("projeção inválida caiu no legado: err=%v fallback=%d", err, fallback)
	}
	t.Setenv("NEXO_BALANCE_READ", "shadow")
	legacyCalls = 0
	queryCalls = 0
	served, err := dueHTTPWith(context.Background(), "invoice", productionBalancePolicy(), func(context.Context, string, ...any) ([]jsonx.Object, error) {
		queryCalls++
		return nil, nil
	}, func(context.Context, string) (map[string]any, error) {
		legacyCalls++
		return map[string]any{"status": "open", "remaining_cents": float64(1)}, nil
	})
	if err != nil || legacyCalls != 1 || queryCalls != 0 || served["status"] != "open" {
		t.Fatalf("produção com allowlist vazia: err=%v legacy=%d query=%d body=%#v", err, legacyCalls, queryCalls, served)
	}
	if !sameVariants(before, balanceVariants) {
		t.Fatal("due de teste alterou o registro")
	}
}

func TestBalanceReadGateExistingEvidence(t *testing.T) {
	root := "../../../../../tests/contrato/"
	needles := map[string][]string{
		"financial_movements.py":           {"signed reversal restores residual", "tenant portal and POP restrictions", "shadow detects synthetic drift", "source_unproven"},
		"financial_movements_migration.py": {"source_unproven and not matches", "shadow_detects_drift"},
		"import_compensate_contract.py":    {"import_batch_compensations", "canceled_invoices"},
		"provider_operations_migration.py": {"provider_refund_id", "kind,reversal_of", "reconciling"},
		"provider_contract.py":             {"payment.refunded", "status']=='reconciling'"},
	}
	for file, parts := range needles {
		body, err := os.ReadFile(root + file)
		if err != nil {
			t.Fatal(err)
		}
		text := string(body)
		if strings.TrimSpace(text) == "" {
			t.Fatalf("%s vazio", file)
		}
		for _, part := range parts {
			if !strings.Contains(text, part) {
				t.Fatalf("%s perdeu %s", file, part)
			}
		}
	}
}

func TestBalanceReadGateDatabasePending(t *testing.T) {
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("PostgreSQL e EXPLAIN ANALYZE foram marcados como aceitos nesta entrega")
	}
	for _, reader := range balanceGateReaders(t) {
		if strings.TrimSpace(reader.variant) == "" {
			t.Fatal("variante vazia não segura o gate pendente")
		}
	}
}

type balanceGateReader struct {
	id, legacy, variant string
	casts               bool
}

func balanceGateReaders(t *testing.T) []balanceGateReader {
	t.Helper()
	listSQL := dynamicSQL("/api/invoices", 1, map[string]string{"limit": "24", "offset": "0"})
	readers := []balanceGateReader{
		{id: balanceReaderInvoiceDetail, legacy: gen.Group91a4cc440, casts: true},
		{id: balanceReaderContractFinanceList, legacy: gen.Groupc47037ac0, casts: true},
		{id: balanceReaderContractFinanceTotals, legacy: contractFinanceTotalsSQL, casts: false},
		{id: balanceReaderReconciliationInvoices, legacy: gen.Group152f5ccd0, casts: true},
		{id: balanceReaderFinanceSummary, legacy: gen.Readf038858e, casts: false},
		{id: balanceReaderInvoiceList, legacy: listSQL, casts: true},
		{id: balanceReaderTodayOverdue, legacy: dynamicSQL("/api/today", 3, nil), casts: true},
		{id: balanceReaderTerminationQuoteGet, legacy: dynamicSQL("helper:terminationQuote", 0, nil), casts: true},
		{id: balanceReaderInvoiceDue, legacy: gen.Due, casts: true},
	}
	for i := range readers {
		variant, ok := balanceVariants[readers[i].id]
		if !ok {
			t.Fatalf("variante de %s não registrada", readers[i].id)
		}
		readers[i].variant = variant
		if strings.Count(readers[i].legacy, "::int") == 0 && readers[i].casts {
			t.Fatalf("legado de %s não tem o cast que o corte recusa", readers[i].id)
		}
	}
	return readers
}

func balanceGateReconstruct(tc balanceGateMoney) (residual, excess, collectible int64, matches bool) {
	base := tc.nominal + tc.fee - tc.discount
	residual = base - tc.received
	if residual < 0 {
		residual = 0
	}
	excess = tc.received - base
	if excess < 0 {
		excess = 0
	}
	collectible = residual
	if tc.status == "canceled" {
		collectible = 0
	}
	matches = tc.nominal == tc.legacyNominal && tc.fee == tc.legacyFee && tc.discount == tc.legacyDiscount && tc.received == tc.legacyReceived && tc.status == tc.legacyStatus
	return residual, excess, collectible, matches
}

func balanceGateRow(tc balanceGateMoney, stripCompare bool) jsonx.Object {
	row := jsonx.Object{
		{Name: "paid_cents", Value: tc.servedPaid},
		{Name: "amount_cents", Value: int32(10000)},
		{Name: "fee_cents", Value: int32(tc.legacyFee)},
		{Name: "discount_cents", Value: int32(tc.legacyDiscount)},
		{Name: "status", Value: tc.legacyStatus},
		{Name: "open_cents", Value: int64(tc.residual)},
		{Name: "overdue_cents", Value: int64(0)},
	}
	if stripCompare {
		return row
	}
	return append(row,
		jsonx.Field{Name: "cmp_matches", Value: tc.matches},
		jsonx.Field{Name: "cmp_received_cents", Value: tc.received},
		jsonx.Field{Name: "cmp_residual_cents", Value: tc.residual},
		jsonx.Field{Name: "cmp_excess_cents", Value: tc.excess},
		jsonx.Field{Name: "cmp_collectible_cents", Value: tc.collectible},
		jsonx.Field{Name: "cmp_status", Value: tc.status},
	)
}

type balanceGateAgreement struct {
	matches, unproven bool
	source            int64
}

func gateAgreement(original, discount, total, source, installments int64, unproven bool) balanceGateAgreement {
	if unproven {
		return balanceGateAgreement{matches: false, unproven: true, source: 0}
	}
	matches := source == original && installments == total && total == original-discount
	return balanceGateAgreement{matches: matches, unproven: false, source: source}
}

func intCastOverflow(cents int64) bool {
	return cents > math.MaxInt32 || cents < math.MinInt32
}
