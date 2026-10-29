package leitura

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"

	"github.com/prometheus/client_golang/prometheus"
)

func TestBalanceReadInlineOffKeepsLegacyBody(t *testing.T) {
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlists compiladas de shadow e cut deixaram de ser vazias")
	}
	registered, ok := balanceVariants[balanceReaderContractFinanceTotals]
	if !ok || registered != contractFinanceTotalsVariantSQL || !strings.Contains(registered, contractFinanceTotalsSQL) {
		t.Fatal("variante dos totais não está registrada com a sentença legada")
	}
	for _, mode := range []string{"off", "shadow", "cut", "", "SHADOW", " cut "} {
		t.Setenv("NEXO_BALANCE_READ", mode)
		got, err := Pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
		if err != nil {
			t.Fatalf("modo produção %q: %v", mode, err)
		}
		if got.Shadow || got.SQL != contractFinanceTotalsSQL || got.Reader != balanceReaderContractFinanceTotals {
			t.Fatalf("modo produção %q escolheu %#v", mode, got)
		}
	}
	t.Setenv("NEXO_BALANCE_READ", "shadow")
	got, err := Pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
	if err != nil || got.Shadow || got.SQL != contractFinanceTotalsSQL {
		t.Fatalf("ambiente shadow não pode habilitar o leitor: err=%v sel=%#v", err, got)
	}
	t.Setenv("NEXO_BALANCE_READ", "cut")
	got, err = Pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
	if err != nil || got.Shadow || got.SQL != contractFinanceTotalsSQL {
		t.Fatalf("ambiente cut não pode habilitar o leitor: err=%v sel=%#v", err, got)
	}

	row := contractFinanceTotalsLegacyRow()
	rows := []jsonx.Object{append(jsonx.Object{}, row...)}
	if err := Strip(got, rows); err != nil {
		t.Fatal(err)
	}
	if !sameObject(rows[0], row) {
		t.Fatalf("corpo off %#v", rows[0])
	}
	leaked := []jsonx.Object{append(append(jsonx.Object{}, row...), jsonx.Field{Name: "cmp_matches", Value: true})}
	if err := Strip(got, leaked); err != errBalanceCompareLeak {
		t.Fatalf("seleção off com cmp_: %v", err)
	}
	if leaked[0].Get("cmp_matches") != true || leaked[0].Get("open_cents") != int64(1500) {
		t.Fatalf("seleção off alterou a linha: %#v", leaked[0])
	}
}

func TestBalanceReadInlineLocalPolicyOneStatement(t *testing.T) {
	registered := balanceVariants[balanceReaderContractFinanceTotals]
	localVariants := map[string]string{balanceReaderContractFinanceTotals: registered}
	allowed := map[string]struct{}{balanceReaderContractFinanceTotals: {}}
	off, err := (balanceReadPolicy{Mode: "off", Shadow: allowed, Cut: allowed, Variants: localVariants}).pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
	if err != nil || off.Shadow || off.SQL != contractFinanceTotalsSQL {
		t.Fatalf("política local off: err=%v sel=%#v", err, off)
	}
	missing, err := (balanceReadPolicy{Mode: "shadow", Shadow: allowed, Cut: map[string]struct{}{}, Variants: map[string]string{}}).pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
	if err != errBalanceVariantMissing || missing.SQL != "" || missing.Shadow {
		t.Fatalf("shadow sem variante caiu no legado: err=%v sel=%#v", err, missing)
	}
	selected, err := (balanceReadPolicy{Mode: "shadow", Shadow: allowed, Cut: map[string]struct{}{}, Variants: localVariants}).pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
	if err != nil || !selected.Shadow || selected.SQL != registered || selected.Reader != balanceReaderContractFinanceTotals {
		t.Fatalf("política local shadow: err=%v sel=%#v", err, selected)
	}
	if strings.Contains(selected.SQL, ";") {
		t.Fatal("a variante precisa ser uma sentença")
	}
	if _, ok := productionShadowAllowlist()[balanceReaderContractFinanceTotals]; ok {
		t.Fatal("política local entrou na allowlist de produção")
	}
	if _, ok := productionCutAllowlist()[balanceReaderContractFinanceTotals]; ok {
		t.Fatal("totais entraram na allowlist de corte")
	}
	hook := mustRead(t, "contract_finance_totals.go")
	if strings.Count(hook, "balanceRowsInTx(") != 1 || strings.Contains(hook, "cmp_") || strings.Contains(hook, "tx.Objects(") {
		t.Fatal("o helper legado deixou de ser uma sentença no tx já aberto")
	}
	variantGo := mustRead(t, "variants_inline.go")
	if strings.Count(variantGo, "registerBalanceVariant(") != 1 || !strings.Contains(variantGo, `//go:embed shadow/contract_finance_totals.sql`) {
		t.Fatal("registro da variante inline")
	}
	for _, decl := range []string{"func Pick(", "func Strip(", "func DueHTTP(", "func dueBreakdownFromRow(", "func balanceRowsInTx(", "contractFinanceTotalsSQL +", "fmt.Sprintf"} {
		if strings.Contains(variantGo, decl) {
			t.Fatalf("variants_inline.go redeclarou ou concatenou SQL: %s", decl)
		}
	}
	sqlc := mustRead(t, "../../../sqlc.yaml")
	if !strings.Contains(sqlc, "internal/modules/leitura/queries") || strings.Contains(sqlc, "leitura/shadow") {
		t.Fatal("sqlc passou a ler shadow/")
	}
}

func TestBalanceReadInlineVariantFormula(t *testing.T) {
	variant := sqlWithoutLineComments(contractFinanceTotalsVariantSQL)
	legacy := sqlWithoutLineComments(contractFinanceTotalsSQL)
	if strings.Count(variant, legacy) != 1 {
		t.Fatal("a variante deve repetir a sentença legada uma vez")
	}
	compare, err := os.ReadFile("queries/balance_shadow_compare.sql")
	if err != nil {
		t.Fatal(err)
	}
	compareSQL := sqlWithoutLineComments(string(compare))
	for _, piece := range []string{
		"sum(mv.nominal_delta)::bigint as nominal_cents",
		"sum(mv.fee_delta)::bigint as fee_cents",
		"sum(mv.discount_delta)::bigint as discount_cents",
		"(array_agg(mv.status_after order by mv.id desc))[1] as last_status",
		"from invoice_movements mv",
		"where mv.tenant_id = i.tenant_id and mv.invoice_id = i.id",
		"sum(py.signed_cents)::bigint as signed_cents",
		"from payments py",
		"where py.invoice_id = i.id and py.tenant_id = i.tenant_id",
		"m.last_status as status, i.status as legacy_status",
		"coalesce(pay.signed_cents, 0)::bigint as received_cents",
		"i.amount_cents::bigint as legacy_nominal_cents",
		"i.fee_cents::bigint as legacy_fee_cents",
		"i.discount_cents::bigint as legacy_discount_cents",
		"coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents",
		"greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as residual_cents",
		"greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as excess_cents",
		"case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as collectible_cents",
		"(x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true as matches",
	} {
		if !strings.Contains(compareSQL, piece) {
			t.Fatalf("fórmula de referência sem %s", piece)
		}
		if !strings.Contains(variant, piece) {
			t.Fatalf("variante sem %s", piece)
		}
	}
	if strings.Contains(variant, "financial_balance_shadow") || strings.Contains(variant, "financial_payment_allocations") {
		t.Fatal("a variante lê a view do tenant ou a alocação agregada")
	}
	if strings.Contains(variant, "group by tenant_id") || strings.Contains(variant, "i.id = any(") {
		t.Fatal("a comparação varre o tenant ou troca o parâmetro do contrato")
	}
	if strings.Contains(variant, "::int") {
		t.Fatal("totais não podem promover cast ::int")
	}
	params := regexp.MustCompile(`\$[0-9]+`).FindAllString(contractFinanceTotalsVariantSQL, -1)
	for _, param := range params {
		if param != "$1" {
			t.Fatalf("parâmetro legado alterado: %s", param)
		}
	}
	if !strings.Contains(variant, "where i.contract_id=$1") {
		t.Fatal("filtro do contrato ausente")
	}
	movement := variant[strings.Index(variant, "from invoice_movements mv"):]
	if !strings.Contains(movement[:strings.Index(movement, ") m on true")], "where mv.tenant_id = i.tenant_id and mv.invoice_id = i.id") {
		t.Fatal("lateral de movimento soma antes de filtrar a fatura")
	}
	payment := variant[strings.Index(variant, "from payments py"):]
	if !strings.Contains(payment[:strings.Index(payment, ") pay on true")], "where py.invoice_id = i.id and py.tenant_id = i.tenant_id") {
		t.Fatal("lateral de pagamento soma antes de filtrar a fatura")
	}
	compareFrom := strings.LastIndex(variant, "from invoices i")
	if compareFrom < 0 || strings.Index(variant[compareFrom:], "where i.contract_id=$1") < 0 {
		t.Fatal("seleção do contrato ausente na comparação")
	}
	afterResidual := variant[strings.Index(variant, "sum(src.residual_cents)"):]
	if !strings.Contains(afterResidual, "where i.contract_id=$1") {
		t.Fatal("a soma de residual não lê o conjunto já filtrado por contrato")
	}
	for _, piece := range []string{
		"filter (where status='open')",
		"due_date < (now() at time zone coalesce((select timezone from tenant_settings where tenant_id=app_tenant()),'america/sao_paulo'))::date",
		"filter (where src.legacy_status = 'open')",
		"src.legacy_status = 'reconciling'",
		"is true as cmp_matches",
		"cmp.cmp_open_excess_cents",
		"cmp.cmp_open_collectible_cents",
		"cmp.cmp_overdue_collectible_cents",
		"cmp.cmp_reconciling_collectible_cents",
	} {
		if !strings.Contains(variant, piece) {
			t.Fatalf("variante sem %s", piece)
		}
	}
	matchStart := strings.Index(variant, "cmp.cmp_rows_match")
	matchEnd := strings.Index(variant, "is true as cmp_matches")
	if matchStart < 0 || matchEnd < matchStart {
		t.Fatal("cmp_matches ausente")
	}
	matchExpr := variant[matchStart:matchEnd]
	for _, piece := range []string{
		"leg.open = cmp.cmp_open_count",
		"leg.overdue = cmp.cmp_overdue_count",
		"leg.reconciling = cmp.cmp_reconciling_count",
		"leg.nominal_open_cents = cmp.cmp_nominal_open_cents",
		"leg.received_open_cents = cmp.cmp_received_open_cents",
		"leg.received_cents = cmp.cmp_received_cents",
		"leg.open_cents = cmp.cmp_open_residual_cents",
		"leg.overdue_cents = cmp.cmp_overdue_residual_cents",
		"leg.open_cents = cmp.cmp_open_collectible_cents",
		"leg.overdue_cents = cmp.cmp_overdue_collectible_cents",
	} {
		if !strings.Contains(matchExpr, piece) {
			t.Fatalf("cmp_matches sem %s", piece)
		}
	}
	if strings.Contains(matchExpr, "excess") || strings.Contains(matchExpr, "::int") || strings.Contains(matchExpr, "received_month") {
		t.Fatal("excesso, cast int ou caixa do mês entrou no cmp_matches dos totais")
	}
}

func TestBalanceReadInlineCompareEqualityAndDivergence(t *testing.T) {
	selected, err := (balanceReadPolicy{
		Mode:     "shadow",
		Shadow:   map[string]struct{}{balanceReaderContractFinanceTotals: {}},
		Cut:      map[string]struct{}{},
		Variants: map[string]string{balanceReaderContractFinanceTotals: contractFinanceTotalsVariantSQL},
	}).pick(balanceReaderContractFinanceTotals, contractFinanceTotalsSQL)
	if err != nil || !selected.Shadow {
		t.Fatalf("política local: err=%v sel=%#v", err, selected)
	}
	reg := prometheus.NewRegistry()
	if err := RegisterBalanceReadMetrics(reg); err != nil {
		t.Fatal(err)
	}
	legacy := contractFinanceTotalsLegacyRow()

	matchBefore := sample(reg, balanceReaderContractFinanceTotals, balanceReadMatch)
	equal := append(append(jsonx.Object{}, legacy...),
		jsonx.Field{Name: "cmp_matches", Value: true},
		jsonx.Field{Name: "cmp_open_residual_cents", Value: int64(1500)},
		jsonx.Field{Name: "cmp_open_excess_cents", Value: int64(0)},
		jsonx.Field{Name: "cmp_open_collectible_cents", Value: int64(1500)},
	)
	rows := []jsonx.Object{equal}
	if err := Strip(selected, rows); err != nil {
		t.Fatal(err)
	}
	if !sameObject(rows[0], legacy) {
		t.Fatalf("igualdade alterou o corpo: %#v", rows[0])
	}
	if sample(reg, balanceReaderContractFinanceTotals, balanceReadMatch)-matchBefore != 1 {
		t.Fatal("igualdade sem métrica match")
	}

	mismatchBefore := sample(reg, balanceReaderContractFinanceTotals, balanceReadMismatch)
	diverged := append(append(jsonx.Object{}, legacy...),
		jsonx.Field{Name: "cmp_matches", Value: false},
		jsonx.Field{Name: "cmp_open_residual_cents", Value: int64(1)},
		jsonx.Field{Name: "cmp_overdue_residual_cents", Value: int64(2)},
		jsonx.Field{Name: "cmp_open_excess_cents", Value: int64(9)},
		jsonx.Field{Name: "cmp_reconciling_collectible_cents", Value: int64(40)},
	)
	rows = []jsonx.Object{diverged}
	if err := Strip(selected, rows); err != nil {
		t.Fatal(err)
	}
	if !sameObject(rows[0], legacy) {
		t.Fatalf("divergência recompôs centavos: %#v", rows[0])
	}
	if sample(reg, balanceReaderContractFinanceTotals, balanceReadMismatch)-mismatchBefore != 1 {
		t.Fatal("divergência sem métrica mismatch")
	}
	assertMetricLabels(t, reg)
}

func TestBalanceReadInlineDatabaseGatePending(t *testing.T) {
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("gate de PostgreSQL e EXPLAIN dos totais não está aprovado")
	}
	if _, err := os.Stat("shadow/contract_finance_totals.sql"); err != nil {
		t.Fatal(err)
	}
}

func contractFinanceTotalsLegacyRow() jsonx.Object {
	return jsonx.Object{
		{Name: "open", Value: int64(2)},
		{Name: "overdue", Value: int64(1)},
		{Name: "reconciling", Value: int64(0)},
		{Name: "nominal_open_cents", Value: int64(2000)},
		{Name: "received_open_cents", Value: int64(500)},
		{Name: "received_cents", Value: int64(500)},
		{Name: "open_cents", Value: int64(1500)},
		{Name: "overdue_cents", Value: int64(800)},
	}
}

func sameObject(got, want jsonx.Object) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i].Name != want[i].Name || got[i].Value != want[i].Value {
			return false
		}
	}
	return true
}
