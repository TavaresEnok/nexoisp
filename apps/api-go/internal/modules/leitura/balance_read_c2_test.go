package leitura

import (
	"os"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"

	"github.com/prometheus/client_golang/prometheus"
)

// balanceReadC2DatabaseGate stays pending until a non-privileged PostgreSQL
// run executes each variant once, inside one transaction, on a non-empty
// invoice set under RLS, and attaches EXPLAIN. Skipping the test is not acceptance.
const balanceReadC2DatabaseGate = "pending"

func TestBalanceReadC2DatabaseGatePending(t *testing.T) {
	if balanceReadC2DatabaseGate != "pending" {
		t.Fatal("gate de PostgreSQL, conjunto não vazio, RLS e EXPLAIN da C2 não está aprovado")
	}
	for _, name := range []string{"shadow/8d9dae54_3.sql", "shadow/4facfb98_0.sql"} {
		if _, err := os.Stat(name); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBalanceReadC2RegistersOwnVariants(t *testing.T) {
	source, err := os.ReadFile("variants_c2.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	if !strings.Contains(text, "//go:embed shadow/8d9dae54_3.sql shadow/4facfb98_0.sql") {
		t.Fatal("embed da C2 precisa nomear só os dois arquivos desta frente")
	}
	if strings.Contains(text, "shadow/*") || strings.Contains(text, "fmt.Sprintf") || strings.Contains(text, "+") {
		t.Fatal("registro não pode concatenar SQL nem embutir o diretório inteiro")
	}
	for _, id := range []string{"balanceReaderTodayOverdue", "balanceReaderTerminationQuoteGet"} {
		if !strings.Contains(text, "registerBalanceVariant("+id) {
			t.Fatalf("init não registra %s", id)
		}
	}
	for _, reader := range []string{balanceReaderTodayOverdue, balanceReaderTerminationQuoteGet} {
		got, live := balanceVariants[reader]
		if !live || strings.TrimSpace(got) == "" {
			t.Fatalf("init não registrou %s", reader)
		}
		if got != mustBalanceC2SQL(c2ShadowFile(reader)) {
			t.Fatalf("SQL registrado de %s difere do embed", reader)
		}
	}
	if _, ok := productionShadowAllowlist()[balanceReaderTodayOverdue]; ok {
		t.Fatal("allowlist de shadow de produção não permanece vazia")
	}
	if _, ok := productionShadowAllowlist()[balanceReaderTerminationQuoteGet]; ok {
		t.Fatal("allowlist de shadow de produção não permanece vazia")
	}
	if _, ok := productionCutAllowlist()[balanceReaderTodayOverdue]; ok || len(productionCutAllowlist()) != 0 {
		t.Fatal("today-overdue não pode entrar na allowlist de corte")
	}
	if _, ok := productionCutAllowlist()[balanceReaderTerminationQuoteGet]; ok || len(productionCutAllowlist()) != 0 {
		t.Fatal("termination-quote-get não pode entrar na allowlist de corte")
	}
}

func TestBalanceReadC2ProductionStaysLegacy(t *testing.T) {
	cases := []struct {
		reader string
		legacy string
	}{
		{balanceReaderTodayOverdue, mustReadTestFile(t, "dinamicas/8d9dae54_3.sql")},
		{balanceReaderTerminationQuoteGet, mustReadTestFile(t, "dinamicas/4facfb98_0.sql")},
	}
	for _, mode := range []string{"", "off", "shadow", "cut", "SHADOW", " ligado"} {
		t.Setenv("NEXO_BALANCE_READ", mode)
		for _, tc := range cases {
			got, err := Pick(tc.reader, tc.legacy)
			if err != nil {
				t.Fatal(err)
			}
			if got.Shadow || got.SQL != tc.legacy || got.Reader != tc.reader {
				t.Fatalf("modo %q leitor %s: %#v", mode, tc.reader, got)
			}
		}
	}
}

func TestBalanceReadC2LocalPolicyOneStatement(t *testing.T) {
	cases := []struct {
		reader string
		legacy string
		money  string
		count  string
	}{
		{balanceReaderTodayOverdue, mustReadTestFile(t, "dinamicas/8d9dae54_3.sql"), "leg.overdue_cents", "leg.overdue"},
		{balanceReaderTerminationQuoteGet, mustReadTestFile(t, "dinamicas/4facfb98_0.sql"), "leg.open_cents", "leg.open_count"},
	}
	for _, tc := range cases {
		variant := mustBalanceC2SQL(c2ShadowFile(tc.reader))
		local := balanceReadPolicy{
			Mode:     "shadow",
			Shadow:   map[string]struct{}{tc.reader: {}},
			Cut:      map[string]struct{}{},
			Variants: map[string]string{tc.reader: variant},
		}
		got, err := local.pick(tc.reader, tc.legacy)
		if err != nil {
			t.Fatal(err)
		}
		if !got.Shadow || got.SQL != variant || got.Reader != tc.reader {
			t.Fatalf("política local não escolheu a variante única: %#v", got)
		}
		if strings.Contains(got.SQL, ";") {
			t.Fatal("variante tem mais de uma sentença")
		}
		if !strings.Contains(got.SQL, strings.TrimSpace(tc.legacy)) {
			t.Fatal("corpo SQL legado não está intacto na variante")
		}
		off := balanceReadPolicy{Mode: "shadow", Shadow: map[string]struct{}{tc.reader: {}}, Cut: map[string]struct{}{}, Variants: map[string]string{}}
		missing, err := off.pick(tc.reader, tc.legacy)
		if err != errBalanceVariantMissing || missing.SQL != "" {
			t.Fatalf("shadow sem variante caiu no legado: err=%v sel=%#v", err, missing)
		}
		emptyAllow := balanceReadPolicy{Mode: "shadow", Shadow: map[string]struct{}{}, Cut: map[string]struct{}{}, Variants: map[string]string{tc.reader: variant}}
		legacyPick, err := emptyAllow.pick(tc.reader, tc.legacy)
		if err != nil || legacyPick.Shadow || legacyPick.SQL != tc.legacy {
			t.Fatalf("allowlist vazia: err=%v sel=%#v", err, legacyPick)
		}
		cut := balanceReadPolicy{Mode: "cut", Shadow: map[string]struct{}{tc.reader: {}}, Cut: map[string]struct{}{}, Variants: map[string]string{tc.reader: variant}}
		cutPick, err := cut.pick(tc.reader, tc.legacy)
		if err != nil || cutPick.Shadow || cutPick.SQL != tc.legacy {
			t.Fatalf("cut sem allowlist: err=%v sel=%#v", err, cutPick)
		}
		wantMatch := "(cmp.rows_match and cmp.residual_cents = " + tc.money + " and cmp.collectible_cents = " + tc.money + " and cmp.invoice_count = " + tc.count + ") is true as cmp_matches"
		if !strings.Contains(variant, wantMatch) {
			t.Fatalf("cmp_matches de %s não compara residual e cobrável ao leitor", tc.reader)
		}
	}
}

func TestBalanceReadC2FormulaMatchesDedicatedQuery(t *testing.T) {
	source, err := os.ReadFile("queries/balance_shadow_compare.sql")
	if err != nil {
		t.Fatal(err)
	}
	formula := sqlWithoutLineComments(string(source))
	pieces := []string{
		"greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) as residual_cents",
		"greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents)) as excess_cents",
		"case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end as collectible_cents",
		"(x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true as matches",
		"sum(mv.nominal_delta)::bigint as nominal_cents",
		"sum(mv.fee_delta)::bigint as fee_cents",
		"sum(mv.discount_delta)::bigint as discount_cents",
		"(array_agg(mv.status_after order by mv.id desc))[1] as last_status",
		"where mv.tenant_id = i.tenant_id and mv.invoice_id = i.id",
		"sum(py.signed_cents)::bigint as signed_cents",
		"where py.invoice_id = i.id and py.tenant_id = i.tenant_id",
		"coalesce(pay.signed_cents, 0)::bigint as received_cents",
		"coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents",
		"i.amount_cents::bigint as legacy_nominal_cents",
		"i.fee_cents::bigint as legacy_fee_cents",
		"i.discount_cents::bigint as legacy_discount_cents",
	}
	for _, piece := range pieces {
		if !strings.Contains(formula, piece) {
			t.Fatalf("fórmula dedicada sem %s", piece)
		}
	}
	today := sqlWithoutLineComments(mustBalanceC2SQL("shadow/8d9dae54_3.sql"))
	quote := sqlWithoutLineComments(mustBalanceC2SQL("shadow/4facfb98_0.sql"))
	for _, piece := range pieces {
		if !strings.Contains(today, piece) || !strings.Contains(quote, piece) {
			t.Fatalf("variante sem a expressão %s", piece)
		}
	}
	for _, sqlText := range []string{today, quote} {
		if strings.Contains(sqlText, "financial_balance_shadow") || strings.Contains(sqlText, "i.id = any(") {
			t.Fatal("variante lê a view ou troca a seleção por uma lista de ids")
		}
		if strings.Contains(sqlText, "coalesce(m.nominal_cents") || strings.Contains(sqlText, "coalesce(nominal_cents, 0)") {
			t.Fatal("nominal ausente não pode virar zero")
		}
		if strings.Contains(sqlText, "fine_pct") || strings.Contains(sqlText, "int_pct") || strings.Contains(sqlText, "fee_if_applied") {
			t.Fatal("prévia de multa não entra na sombra")
		}
		if strings.Count(sqlText, "left join lateral") != 2 {
			t.Fatal("cada leitura precisa das duas laterais da fórmula")
		}
		movement := strings.Index(sqlText, "sum(mv.nominal_delta)")
		selection := strings.LastIndex(sqlText[:movement], "where ")
		if selection < 0 || strings.Index(sqlText, "from invoice_movements mv") < selection {
			t.Fatal("a lateral soma antes de filtrar a seleção")
		}
	}
	if strings.Contains(today, "$1") || strings.Contains(today, "penalty_cents") {
		t.Fatal("today não ganha parâmetro nem multa de fidelidade")
	}
	if !strings.Contains(today, "inv.status = 'open'") || !strings.Contains(today, "inv.due_date < (now() at time zone coalesce(ts.timezone, 'america/sao_paulo'))::date") {
		t.Fatal("seleção de vencidas não replica o filtro legado")
	}
	if !strings.Contains(today, "::int as overdue_cents") || strings.Contains(today, "::bigint as overdue_cents") {
		t.Fatal("overdue_cents precisa continuar ::int")
	}
	if !strings.Contains(quote, "k.penalty_cents") || !strings.Contains(quote, "extract(year from age(k.loyalty_until, $2::date))") {
		t.Fatal("cálculo da multa de fidelidade foi alterado")
	}
	start := strings.Index(quote, "(cmp.rows_match")
	end := strings.Index(quote, "is true as cmp_matches")
	if start < 0 || end < start {
		t.Fatal("cmp_matches ausente na cotação")
	}
	if strings.Contains(quote[start:end], "penalty") || strings.Contains(quote, "penalty_cents +") || strings.Contains(quote, "$3") {
		t.Fatal("multa de fidelidade entrou no residual ou ganhou parâmetro")
	}
	if !strings.Contains(quote, "where inv.contract_id = $1") || !strings.Contains(quote, "and inv.status = 'open'") {
		t.Fatal("seleção da cotação não fica nas faturas open do contrato")
	}
	if !strings.Contains(quote, "::int from invoices i where i.contract_id = k.id and i.status = 'open'") {
		t.Fatal("open_cents precisa continuar ::int e no filtro open")
	}
	if strings.Contains(quote, "reconciling") {
		t.Fatal("cotação não soma fatura em conciliação")
	}
}

func TestBalanceReadC2StripEqualityAndDivergence(t *testing.T) {
	reg := prometheus.NewRegistry()
	if err := RegisterBalanceReadMetrics(reg); err != nil && !strings.Contains(err.Error(), "duplicate") {
		t.Fatal(err)
	}
	todayLegacy := jsonx.Object{
		{Name: "overdue", Value: int32(2)},
		{Name: "overdue_cents", Value: int32(1500)},
		{Name: "reconciling", Value: int32(1)},
	}
	quoteLegacy := jsonx.Object{
		{Name: "status", Value: "active"},
		{Name: "loyalty_until", Value: "2027-01-01"},
		{Name: "penalty_model", Value: "monthly"},
		{Name: "penalty_cents", Value: int32(3000)},
		{Name: "remaining_months", Value: int32(4)},
		{Name: "within_loyalty", Value: true},
		{Name: "open_cents", Value: int32(1500)},
		{Name: "open_count", Value: int32(2)},
	}
	cases := []struct {
		reader string
		legacy jsonx.Object
		money  string
	}{
		{balanceReaderTodayOverdue, todayLegacy, "overdue_cents"},
		{balanceReaderTerminationQuoteGet, quoteLegacy, "open_cents"},
	}
	for _, tc := range cases {
		equal := append(jsonx.Object{}, tc.legacy...)
		equal = append(equal,
			jsonx.Field{Name: "cmp_matches", Value: true},
			jsonx.Field{Name: "cmp_residual_cents", Value: int64(1500)},
			jsonx.Field{Name: "cmp_excess_cents", Value: int64(0)},
			jsonx.Field{Name: "cmp_collectible_cents", Value: int64(1500)},
			jsonx.Field{Name: "cmp_rows_match", Value: true},
		)
		rows := []jsonx.Object{equal}
		matchBefore := c2Sample(t, reg, tc.reader, balanceReadMatch)
		if err := Strip(BalanceReadSelection{SQL: "variant", Reader: tc.reader, Shadow: true}, rows); err != nil {
			t.Fatal(err)
		}
		assertC2LegacyBody(t, rows[0], tc.legacy)
		if c2Sample(t, reg, tc.reader, balanceReadMatch)-matchBefore != 1 {
			t.Fatal("igualdade sem métrica match")
		}

		diverged := append(jsonx.Object{}, tc.legacy...)
		diverged = append(diverged,
			jsonx.Field{Name: "cmp_matches", Value: false},
			jsonx.Field{Name: "cmp_residual_cents", Value: int64(1)},
			jsonx.Field{Name: "cmp_excess_cents", Value: int64(40)},
			jsonx.Field{Name: "cmp_collectible_cents", Value: int64(1)},
			jsonx.Field{Name: "cmp_rows_match", Value: false},
		)
		rows = []jsonx.Object{diverged}
		mismatchBefore := c2Sample(t, reg, tc.reader, balanceReadMismatch)
		if err := Strip(BalanceReadSelection{SQL: "variant", Reader: tc.reader, Shadow: true}, rows); err != nil {
			t.Fatal(err)
		}
		assertC2LegacyBody(t, rows[0], tc.legacy)
		if rows[0].Get(tc.money) != int32(1500) || rows[0].Get("penalty_cents") == int64(1) {
			t.Fatalf("divergência recompôs centavos: %#v", rows[0])
		}
		if c2Sample(t, reg, tc.reader, balanceReadMismatch)-mismatchBefore != 1 {
			t.Fatal("divergência sem métrica mismatch")
		}

		leaked := append(jsonx.Object{}, tc.legacy...)
		leaked = append(leaked, jsonx.Field{Name: "cmp_matches", Value: true})
		rows = []jsonx.Object{leaked}
		if err := Strip(BalanceReadSelection{SQL: "legacy", Reader: tc.reader, Shadow: false}, rows); err != errBalanceCompareLeak {
			t.Fatal(err)
		}
		if rows[0].Get("cmp_matches") != true || rows[0].Get(tc.money) != int32(1500) {
			t.Fatalf("off alterou o corpo: %#v", rows[0])
		}
	}
}

func c2ShadowFile(reader string) string {
	switch reader {
	case balanceReaderTodayOverdue:
		return "shadow/8d9dae54_3.sql"
	case balanceReaderTerminationQuoteGet:
		return "shadow/4facfb98_0.sql"
	default:
		panic(reader)
	}
}

func mustReadTestFile(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertC2LegacyBody(t *testing.T, got, legacy jsonx.Object) {
	t.Helper()
	if len(got) != len(legacy) {
		t.Fatalf("corpo %#v", got)
	}
	for i, field := range legacy {
		if got[i].Name != field.Name || got[i].Value != field.Value || strings.HasPrefix(got[i].Name, "cmp_") {
			t.Fatalf("corpo legado: %#v", got)
		}
	}
}

func c2Sample(t *testing.T, reg *prometheus.Registry, reader, result string) float64 {
	t.Helper()
	families, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != "balance_read_compare_total" {
			continue
		}
		for _, metric := range family.GetMetric() {
			labels := map[string]string{}
			for _, label := range metric.GetLabel() {
				labels[label.GetName()] = label.GetValue()
			}
			if labels["reader"] == reader && labels["result"] == result {
				return metric.GetCounter().GetValue()
			}
		}
	}
	return 0
}
