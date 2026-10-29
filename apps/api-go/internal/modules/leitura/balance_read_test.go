package leitura

import (
	"maps"
	"os"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"

	"github.com/prometheus/client_golang/prometheus"
)

func TestBalanceReadProductionAllowlistsEmpty(t *testing.T) {
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlists compiladas de shadow e cut nascem vazias")
	}
	for _, reader := range []string{
		balanceReaderInvoiceDetail,
		balanceReaderContractFinanceList,
		balanceReaderContractFinanceTotals,
		balanceReaderReconciliationInvoices,
		balanceReaderFinanceSummary,
		balanceReaderInvoiceList,
		balanceReaderTodayOverdue,
		balanceReaderTerminationQuoteGet,
		balanceReaderInvoiceDue,
	} {
		if !closedBalanceReader(reader) {
			t.Fatalf("id fechado ausente: %s", reader)
		}
	}
	if len(closedBalanceReaders) != 9 {
		t.Fatalf("conjunto fechado tem %d ids", len(closedBalanceReaders))
	}
}

func TestBalanceReadPickLocalPolicy(t *testing.T) {
	legacy := "select legacy"
	variant := "select legacy, true as cmp_matches"
	reader := balanceReaderInvoiceDetail
	base := func(mode string, shadow, cut map[string]struct{}, variants map[string]string) balanceReadPolicy {
		return balanceReadPolicy{Mode: mode, Shadow: shadow, Cut: cut, Variants: variants}
	}
	allowed := map[string]struct{}{reader: {}}
	withVariant := map[string]string{reader: variant}

	cases := []struct {
		name    string
		policy  balanceReadPolicy
		wantSQL string
		wantErr error
		shadow  bool
	}{
		{name: "vazio", policy: base("", allowed, allowed, withVariant), wantSQL: legacy},
		{name: "desconhecido", policy: base("ligado", allowed, allowed, withVariant), wantSQL: legacy},
		{name: "maiusculo", policy: base("SHADOW", allowed, allowed, withVariant), wantSQL: legacy},
		{name: "espaco", policy: base(" shadow", allowed, allowed, withVariant), wantSQL: legacy},
		{name: "off", policy: base("off", allowed, allowed, withVariant), wantSQL: legacy},
		{name: "shadow fora da allowlist", policy: base("shadow", map[string]struct{}{}, map[string]struct{}{}, withVariant), wantSQL: legacy},
		{name: "cut allowlist vazia", policy: base("cut", allowed, map[string]struct{}{}, withVariant), wantSQL: legacy},
		{name: "shadow sem variante", policy: base("shadow", allowed, map[string]struct{}{}, map[string]string{}), wantErr: errBalanceVariantMissing},
		{name: "cut sem variante", policy: base("cut", map[string]struct{}{}, allowed, map[string]string{}), wantErr: errBalanceVariantMissing},
		{name: "shadow com variante", policy: base("shadow", allowed, map[string]struct{}{}, withVariant), wantSQL: variant, shadow: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.policy.pick(reader, legacy)
			if tc.wantErr != nil {
				if err == nil || got.SQL != "" {
					t.Fatalf("err=%v seleção=%#v; fallback silencioso", err, got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.SQL != tc.wantSQL || got.Shadow != tc.shadow || got.Reader != reader {
				t.Fatalf("%#v", got)
			}
		})
	}

	open, err := base("shadow", map[string]struct{}{"outro": {}}, nil, map[string]string{"outro": variant}).pick("outro", legacy)
	if err != errBalanceReaderClosed || open.SQL != "" {
		t.Fatalf("leitor fora do conjunto: err=%v sel=%#v", err, open)
	}
}

func TestBalanceReadEnvironmentStaysOnAllowlist(t *testing.T) {
	t.Setenv("NEXO_BALANCE_READ", "shadow")
	if os.Getenv("NEXO_BALANCE_READ") != "shadow" {
		t.Fatal("ambiente de teste")
	}
	got, err := Pick(balanceReaderFinanceSummary, "select legacy")
	if err != nil {
		t.Fatal(err)
	}
	if got.Shadow || got.SQL != "select legacy" {
		t.Fatalf("ambiente não habilita leitor fora da allowlist: %#v", got)
	}
	t.Setenv("NEXO_BALANCE_READ", "cut")
	got, err = Pick(balanceReaderInvoiceList, "select legacy")
	if err != nil || got.Shadow || got.SQL != "select legacy" {
		t.Fatalf("cut com allowlist vazia: err=%v sel=%#v", err, got)
	}
}

func TestBalanceReadRegisterVariant(t *testing.T) {
	before := maps.Clone(balanceVariants)
	if err := addBalanceVariant(map[string]string{}, "livre", "select 1"); err != errBalanceReaderClosed {
		t.Fatal(err)
	}
	if !maps.Equal(balanceVariants, before) {
		t.Fatal("leitor fechado alterou o registro de produto")
	}
	dst := map[string]string{}
	if err := addBalanceVariant(dst, balanceReaderInvoiceList, "  "); err != errBalanceVariantInvalid {
		t.Fatal(err)
	}
	if err := addBalanceVariant(dst, balanceReaderInvoiceList, "select 1"); err != nil {
		t.Fatal(err)
	}
	if dst[balanceReaderInvoiceList] != "select 1" {
		t.Fatal("registro local não guardou a sentença")
	}
	if err := addBalanceVariant(dst, balanceReaderInvoiceList, "select 2"); err != errBalanceVariantInvalid {
		t.Fatal(err)
	}
	if dst[balanceReaderInvoiceList] != "select 1" {
		t.Fatal("rejeição local substituiu a sentença")
	}
	if !maps.Equal(balanceVariants, before) {
		t.Fatal("registro de teste mutou o mapa global")
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("registerBalanceVariant deveria recusar leitor desconhecido")
			}
		}()
		registerBalanceVariant("livre", "select 1")
	}()
	if !maps.Equal(balanceVariants, before) {
		t.Fatal("panic de registro gravou variante global")
	}
}

func TestBalanceReadStrip(t *testing.T) {
	legacy := jsonx.Object{
		{Name: "paid_cents", Value: int32(10)},
		{Name: "amount_cents", Value: int32(100)},
		{Name: "status", Value: "open"},
	}
	clone := func(extra ...jsonx.Field) []jsonx.Object {
		row := append(jsonx.Object{}, legacy...)
		row = append(row, extra...)
		return []jsonx.Object{row}
	}
	reg := prometheus.NewRegistry()
	if err := RegisterBalanceReadMetrics(reg); err != nil {
		t.Fatal(err)
	}
	if err := RegisterBalanceReadMetrics(reg); err == nil {
		t.Fatal("registro duplicado")
	}

	off := clone(jsonx.Field{Name: "cmp_matches", Value: true})
	if err := Strip(BalanceReadSelection{SQL: "legacy", Reader: balanceReaderInvoiceDetail, Shadow: false}, off); err != errBalanceCompareLeak {
		t.Fatal(err)
	}
	if off[0].Get("paid_cents") != int32(10) || off[0].Get("cmp_matches") != true {
		t.Fatalf("off alterou a linha: %#v", off[0])
	}

	broken := clone(jsonx.Field{Name: "cmp_matches", Value: "false"}, jsonx.Field{Name: "cmp_received_cents", Value: int32(99)})
	beforePaid := broken[0].Get("paid_cents")
	if err := Strip(BalanceReadSelection{SQL: "variant", Reader: balanceReaderInvoiceDetail, Shadow: true}, broken); err != errBalanceCompareProjection {
		t.Fatal(err)
	}
	if broken[0].Get("paid_cents") != beforePaid || broken[0].Get("cmp_received_cents") != int32(99) {
		t.Fatalf("erro de projeção alterou o corpo: %#v", broken[0])
	}

	missing := clone()
	if err := Strip(BalanceReadSelection{SQL: "variant", Reader: balanceReaderInvoiceDetail, Shadow: true}, missing); err != errBalanceCompareProjection {
		t.Fatal(err)
	}
	if missing[0].Get("amount_cents") != int32(100) {
		t.Fatal("projeção ausente removeu campo legado")
	}

	mismatchBefore := sample(reg, balanceReaderContractFinanceList, balanceReadMismatch)
	diverged := clone(jsonx.Field{Name: "cmp_matches", Value: false}, jsonx.Field{Name: "cmp_received_cents", Value: int32(99)})
	if err := Strip(BalanceReadSelection{SQL: "variant", Reader: balanceReaderContractFinanceList, Shadow: true}, diverged); err != nil {
		t.Fatal(err)
	}
	if diverged[0].Get("paid_cents") != int32(10) || diverged[0].Get("amount_cents") != int32(100) || diverged[0].Get("status") != "open" {
		t.Fatalf("mismatch recompôs centavos: %#v", diverged[0])
	}
	if diverged[0].Get("cmp_matches") != nil || diverged[0].Get("cmp_received_cents") != nil {
		t.Fatalf("cmp_ permaneceu: %#v", diverged[0])
	}
	if sample(reg, balanceReaderContractFinanceList, balanceReadMismatch)-mismatchBefore != 1 {
		t.Fatal("mismatch sem métrica")
	}

	matchBefore := sample(reg, balanceReaderTodayOverdue, balanceReadMatch)
	same := clone(jsonx.Field{Name: "cmp_matches", Value: true}, jsonx.Field{Name: "cmp_nominal_cents", Value: int32(1)})
	if err := Strip(BalanceReadSelection{SQL: "variant", Reader: balanceReaderTodayOverdue, Shadow: true}, same); err != nil {
		t.Fatal(err)
	}
	if same[0].Get("cmp_nominal_cents") != nil || same[0].Get("paid_cents") != int32(10) {
		t.Fatalf("match: %#v", same[0])
	}
	if sample(reg, balanceReaderTodayOverdue, balanceReadMatch)-matchBefore != 1 {
		t.Fatal("match sem métrica")
	}

	if err := Strip(BalanceReadSelection{SQL: "variant", Reader: balanceReaderInvoiceDue, Shadow: true}, nil); err != nil {
		t.Fatal(err)
	}
	assertMetricLabels(t, reg)
}

func TestBalanceReadDueShadowUsesLegacyPreview(t *testing.T) {
	row := jsonx.Object{
		{Name: "status", Value: "open"},
		{Name: "due_date", Value: "2026-01-02"},
		{Name: "amount_cents", Value: int32(10000)},
		{Name: "fee_cents", Value: int32(50)},
		{Name: "discount_cents", Value: int32(25)},
		{Name: "paid_cents", Value: int32(1000)},
		{Name: "days_late", Value: int32(15)},
		{Name: "fine_pct", Value: float64(2)},
		{Name: "int_pct", Value: float64(1)},
		{Name: "cmp_matches", Value: false},
		{Name: "cmp_amount_cents", Value: int32(1)},
	}
	rows := []jsonx.Object{row}
	if err := stripDueCompare(true, rows, func(result string) {
		if result != "mismatch" {
			t.Fatalf("comparação da prévia: %s", result)
		}
	}); err != nil {
		t.Fatal(err)
	}
	got := dueBreakdownFromRow(rows[0])
	if got["amount_cents"] != float64(10000) || got["paid_cents"] != float64(1000) || got["fine_cents"] != float64(200) || got["interest_cents"] != float64(50) {
		t.Fatalf("prévia: %#v", got)
	}
	if got["remaining_cents"] != float64(9025) || got["fee_if_applied_cents"] != float64(250) {
		t.Fatalf("residual da prévia: %#v", got)
	}
	if rows[0].Get("cmp_amount_cents") != nil {
		t.Fatal("cmp_ saiu no corpo")
	}
	plain := dueBreakdownFromRow(jsonx.Object{
		{Name: "status", Value: "paid"},
		{Name: "due_date", Value: "2026-02-02"},
		{Name: "amount_cents", Value: int32(80)},
		{Name: "fee_cents", Value: int32(5)},
		{Name: "discount_cents", Value: int32(0)},
		{Name: "paid_cents", Value: int32(80)},
		{Name: "days_late", Value: int32(0)},
		{Name: "fine_pct", Value: float64(2)},
		{Name: "int_pct", Value: float64(1)},
	})
	if plain["fine_cents"] != float64(0) || plain["interest_cents"] != float64(0) || plain["remaining_cents"] != float64(5) || plain["fee_if_applied_cents"] != float64(5) {
		t.Fatalf("sem atraso: %#v", plain)
	}
}

func TestBalanceReadDueHTTPOffDoesNotSelectVariant(t *testing.T) {
	policy := balanceReadPolicy{
		Mode:     "shadow",
		Shadow:   productionShadowAllowlist(),
		Cut:      productionCutAllowlist(),
		Variants: map[string]string{balanceReaderInvoiceDue: "select variant"},
	}
	selection, err := policy.pick(balanceReaderInvoiceDue, "select legacy")
	if err != nil || selection.Shadow || selection.SQL != "select legacy" {
		t.Fatalf("off de produção: err=%v sel=%#v", err, selection)
	}
	body, err := os.ReadFile("balance_read.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(body)
	for _, decl := range []string{"func DueHTTP(", "func dueHTTPWith(", "func dueMapFromShadowRows(", "func dueBreakdownFromRow("} {
		if strings.Contains(source, decl) {
			t.Fatalf("núcleo reabriu %s", decl)
		}
	}
	dueHTTP, err := os.ReadFile("due_http.go")
	if err != nil {
		t.Fatal(err)
	}
	dueSrc := string(dueHTTP)
	start := strings.Index(dueSrc, "func DueHTTP(")
	if start < 0 || strings.Count(dueSrc, "func DueHTTP(") != 1 {
		t.Fatal("DueHTTP canônico ausente ou duplicado")
	}
	fn := dueSrc[start:]
	if strings.Count(fn, "tx.Objects(") != 1 || strings.Count(fn, "DueBreakdown(") != 1 {
		t.Fatalf("due HTTP precisa de um ramo legado e uma sentença: %s", fn)
	}
	calc, err := os.ReadFile("due_calculation.go")
	if err != nil {
		t.Fatal(err)
	}
	calcSrc := string(calc)
	if strings.Count(calcSrc, "func dueBreakdownFromRow(") != 1 || !strings.Contains(calcSrc, "math.Floor(amount*num(r.Get(\"fine_pct\"))/100 + 0.5)") || !strings.Contains(calcSrc, "math.Floor(amount*num(r.Get(\"int_pct\"))/100*days/30 + 0.5)") {
		t.Fatal("a prévia pura do GET shadow não replica o cálculo de DueBreakdown")
	}
	aux, err := os.ReadFile("auxiliares.go")
	if err != nil {
		t.Fatal(err)
	}
	auxSource := string(aux)
	if !strings.Contains(auxSource, "func DueBreakdown(") || !strings.Contains(auxSource, "tx.Objects(ctx, gen.Due, id)") || !strings.Contains(auxSource, "return dueBreakdownFromQuery(rows, err)") {
		t.Fatal("DueBreakdown deixou de executar gen.Due ou a prévia canônica")
	}
	if !strings.Contains(auxSource, "result, err = DueHTTP(ctx, tx, id)") || strings.Contains(auxSource, "result, err = DueBreakdown(ctx, tx, id)") {
		t.Fatal("o GET due deixou de chamar DueHTTP")
	}
	if strings.Contains(auxSource, "math.Floor(amount*num(r.Get(\"fine_pct\"))/100 + 0.5)") {
		t.Fatal("a expressão de multa voltou para auxiliares.go")
	}
	for _, path := range []string{"../../finance/core.go", "../../finance/advanced.go"} {
		writer, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		text := string(writer)
		if !strings.Contains(text, "leitura.DueBreakdown(") || strings.Contains(text, "DueHTTP") {
			t.Fatalf("%s deixou de chamar DueBreakdown", path)
		}
	}
}

func TestBalanceReadWiringSymbols(t *testing.T) {
	_ = balanceRowsInTx
	_ = Service.balanceRows
	_ = DueHTTP
	_ = RegisterBalanceReadMetrics
	main, err := os.ReadFile("../../../cmd/api/main.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(main), "leitura.RegisterBalanceReadMetrics(reg)") {
		t.Fatal("métrica fora do registry da API")
	}
}

func sample(reg *prometheus.Registry, reader, result string) float64 {
	families, err := reg.Gather()
	if err != nil {
		return 0
	}
	for _, family := range families {
		if family.GetName() != "balance_read_compare_total" {
			continue
		}
		for _, metric := range family.GetMetric() {
			var gotReader, gotResult string
			for _, label := range metric.GetLabel() {
				switch label.GetName() {
				case "reader":
					gotReader = label.GetValue()
				case "result":
					gotResult = label.GetValue()
				}
			}
			if gotReader == reader && gotResult == result {
				return metric.GetCounter().GetValue()
			}
		}
	}
	return 0
}

func assertMetricLabels(t *testing.T, reg *prometheus.Registry) {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var seen bool
	for _, family := range families {
		if family.GetName() != "balance_read_compare_total" {
			continue
		}
		seen = true
		for _, metric := range family.GetMetric() {
			names := map[string]bool{}
			for _, label := range metric.GetLabel() {
				names[label.GetName()] = true
				switch label.GetName() {
				case "reader":
					if !closedBalanceReader(label.GetValue()) {
						t.Fatalf("reader fora do conjunto: %s", label.GetValue())
					}
				case "result":
					if label.GetValue() != balanceReadMatch && label.GetValue() != balanceReadMismatch {
						t.Fatalf("result %s", label.GetValue())
					}
				default:
					t.Fatalf("label %s", label.GetName())
				}
			}
			for _, forbidden := range []string{"tenant", "tenant_id", "invoice", "invoice_id", "cents", "centavos", "amount_cents", "company", "subscriber"} {
				if names[forbidden] {
					t.Fatalf("label sensível %s", forbidden)
				}
			}
			if len(names) != 2 {
				t.Fatalf("labels %#v", names)
			}
		}
	}
	if !seen {
		t.Fatal("métrica ausente")
	}
}
