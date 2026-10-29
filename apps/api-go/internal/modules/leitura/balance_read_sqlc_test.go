package leitura

import (
	"os"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"

	dto "github.com/prometheus/client_model/go"
)

func TestBalanceReadSqlcRegistrationAndLegacySelection(t *testing.T) {
	readers := []sqlcReaderCase{
		{id: balanceReaderInvoiceDetail, legacy: gen.Group91a4cc440, file: "shadow/group91a4cc44_0.sql", query: "queries/group91a4cc44_0.sql", whole: true},
		{id: balanceReaderContractFinanceList, legacy: gen.Groupc47037ac0, file: "shadow/groupc47037ac_0.sql", query: "queries/groupc47037ac_0.sql", whole: true},
		{id: balanceReaderReconciliationInvoices, legacy: gen.Group152f5ccd0, file: "shadow/group152f5ccd_0.sql", query: "queries/group152f5ccd_0.sql", whole: true},
		{id: balanceReaderFinanceSummary, legacy: gen.Readf038858e, file: "shadow/readf038858e.sql", query: "queries/readf038858e.sql", whole: false},
	}
	source, err := os.ReadFile("variants_sqlc.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(source)
	if strings.Contains(src, "os.Getenv") || strings.Contains(src, "fmt.Sprintf") || strings.Contains(src, "http.") {
		t.Fatal("registro com ambiente, HTTP ou concatenação")
	}
	if strings.Count(src, "registerBalanceVariant(") != len(readers) {
		t.Fatalf("variants_sqlc registra %d leitores", strings.Count(src, "registerBalanceVariant("))
	}
	for _, other := range []string{
		"balanceReaderContractFinanceTotals",
		"balanceReaderInvoiceList",
		"balanceReaderTodayOverdue",
		"balanceReaderTerminationQuoteGet",
		"balanceReaderInvoiceDue",
	} {
		if strings.Contains(src, "registerBalanceVariant("+other) {
			t.Fatalf("variants_sqlc registrou %s", other)
		}
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlist de produção")
	}
	for _, reader := range readers {
		t.Run(reader.id, func(t *testing.T) {
			file, err := os.ReadFile(reader.file)
			if err != nil {
				t.Fatal(err)
			}
			registered, ok := balanceVariants[reader.id]
			if !ok || registered != string(file) || strings.TrimSpace(registered) == "" {
				t.Fatal("init não registrou o arquivo da variante")
			}
			assertSqlcVariantShape(t, reader, registered)
			assertSqlcPolicy(t, reader, registered)
			assertSqlcStrip(t, reader.id, registered)
		})
	}
}

func TestBalanceReadSqlcDatabaseGatePending(t *testing.T) {
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("gate de PostgreSQL e EXPLAIN ANALYZE não está aprovado")
	}
	for _, file := range []string{
		"shadow/group91a4cc44_0.sql",
		"shadow/groupc47037ac_0.sql",
		"shadow/group152f5ccd_0.sql",
		"shadow/readf038858e.sql",
	} {
		if _, err := os.Stat(file); err != nil {
			t.Fatal(err)
		}
	}
}

type sqlcReaderCase struct {
	id, legacy, file, query string
	whole                   bool
}

func assertSqlcVariantShape(t *testing.T, reader sqlcReaderCase, variant string) {
	t.Helper()
	if strings.Count(variant, ";") != 1 || strings.Contains(variant, "financial_balance_shadow") || strings.Contains(variant, "financial_payment_allocations") {
		t.Fatal("sentença única sem a view")
	}
	lower := strings.ToLower(variant)
	if strings.Contains(lower, "group by") {
		t.Fatal("agregado sem filtrar a seleção")
	}
	if strings.Count(lower, "left join lateral") < 2 || strings.Contains(lower, "union") {
		t.Fatal("laterais da seleção")
	}
	for _, piece := range balanceShadowFormulaPieces() {
		if !strings.Contains(variant, piece) {
			t.Fatalf("fórmula sem %s", piece)
		}
	}
	if strings.Contains(variant, "coalesce(m.nominal_cents") || strings.Contains(variant, "coalesce(x.nominal_cents") || strings.Contains(variant, "coalesce(nominal_cents, 0)") {
		t.Fatal("nominal ausente não pode virar zero")
	}
	movement := movementLateral(variant)
	if !strings.Contains(movement, "invoice_id") || !strings.Contains(movement, "tenant_id") || strings.Contains(strings.ToLower(movement), "group by") {
		t.Fatal("a lateral de movimentos não filtra a fatura antes da soma")
	}
	payment := paymentLateral(variant)
	if !strings.Contains(payment, "invoice_id") || !strings.Contains(payment, "tenant_id") {
		t.Fatal("a lateral de pagamentos não filtra a fatura antes da soma")
	}
	body := legacySQLBody(t, reader.query)
	if reader.whole {
		if !strings.Contains(variant, body) {
			t.Fatal("corpo legado ausente")
		}
	} else {
		for _, line := range strings.Split(body, "\n") {
			line = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), ") x"))
			if line == "" || strings.HasPrefix(line, "from (") {
				continue
			}
			if !strings.Contains(variant, line) {
				t.Fatalf("expressão legada ausente: %s", line)
			}
		}
		for _, piece := range []string{
			"where i.status in ('open', 'reconciling') and ($1::uuid is null or i.company_id = $1)",
			"(now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date as d",
			"date_trunc('month', now())",
			"(select coalesce(sum(p.signed_cents),0) from payments p where p.invoice_id=i.id) as paid_cents",
		} {
			if !strings.Contains(variant, piece) {
				t.Fatalf("resumo sem %s", piece)
			}
		}
	}
	switch reader.id {
	case balanceReaderInvoiceDetail:
		requireAll(t, variant, "leg.id = $1", "leg.paid_cents::bigint", "as paid_cents")
		if strings.Count(variant, "::int") != 1 || strings.Contains(variant, "$2") {
			t.Fatal("detalhe alterou o cast ou o parâmetro")
		}
	case balanceReaderContractFinanceList:
		requireAll(t, variant, "where i.contract_id = $1 order by i.due_date desc limit 24", "order by leg.due_date desc", "leg.contract_id = $1")
		if strings.Count(variant, "::int") != 1 || strings.Contains(variant, "$2") {
			t.Fatal("lista alterou o cast ou o parâmetro")
		}
	case balanceReaderReconciliationInvoices:
		requireAll(t, variant, "where i.status = 'reconciling' order by i.due_date", "order by leg.due_date", "leg.status = 'reconciling'")
		if strings.Contains(variant, "$") || strings.Count(variant, "::int") != 1 || strings.Contains(variant, "limit 24") {
			t.Fatal("conciliação alterou filtro, cast ou limite")
		}
	case balanceReaderFinanceSummary:
		if strings.Count(variant, "date_trunc('month', now())") != 1 || strings.Count(variant, "::int") != 1 {
			t.Fatal("caixa do mês foi reescrito")
		}
		clause := cmpMatchesClause(variant)
		if strings.Contains(clause, "received_month") || strings.Contains(clause, "date_trunc") {
			t.Fatal("cmp_matches promoveu o caixa do mês a saldo")
		}
		requireAll(t, clause, "open_cents", "overdue_cents", "nominal_open_cents", "received_open_cents", "cmp_collectible_open_cents")
	default:
		t.Fatalf("leitor %s", reader.id)
	}
}

func assertSqlcPolicy(t *testing.T, reader sqlcReaderCase, variant string) {
	t.Helper()
	before := cloneVariants(balanceVariants)
	t.Setenv("NEXO_BALANCE_READ", "shadow")
	got, err := Pick(reader.id, reader.legacy)
	if err != nil || got.Shadow || got.SQL != reader.legacy || got.Reader != reader.id {
		t.Fatalf("shadow fora da allowlist: err=%v sel=%#v", err, got)
	}
	t.Setenv("NEXO_BALANCE_READ", "cut")
	got, err = Pick(reader.id, reader.legacy)
	if err != nil || got.Shadow || got.SQL != reader.legacy {
		t.Fatalf("cut com allowlist vazia: err=%v sel=%#v", err, got)
	}
	t.Setenv("NEXO_BALANCE_READ", "OFF")
	got, err = Pick(reader.id, reader.legacy)
	if err != nil || got.Shadow || got.SQL != reader.legacy {
		t.Fatalf("modo desconhecido: err=%v sel=%#v", err, got)
	}
	local := balanceReadPolicy{
		Mode:     "shadow",
		Shadow:   map[string]struct{}{reader.id: {}},
		Cut:      map[string]struct{}{},
		Variants: map[string]string{reader.id: variant},
	}
	got, err = local.pick(reader.id, reader.legacy)
	if err != nil || !got.Shadow || got.SQL != variant || got.SQL == reader.legacy {
		t.Fatalf("política local: err=%v sel=%#v", err, got)
	}
	missing := balanceReadPolicy{Mode: "shadow", Shadow: map[string]struct{}{reader.id: {}}, Cut: map[string]struct{}{}, Variants: map[string]string{}}
	if _, err = missing.pick(reader.id, reader.legacy); err != errBalanceVariantMissing {
		t.Fatal(err)
	}
	off := balanceReadPolicy{Mode: "off", Shadow: map[string]struct{}{reader.id: {}}, Cut: map[string]struct{}{reader.id: {}}, Variants: map[string]string{reader.id: variant}}
	got, err = off.pick(reader.id, reader.legacy)
	if err != nil || got.Shadow || got.SQL != reader.legacy {
		t.Fatalf("off local: err=%v sel=%#v", err, got)
	}
	if !sameVariants(before, balanceVariants) {
		t.Fatal("política local mutou o registro global")
	}
}

func assertSqlcStrip(t *testing.T, reader, variant string) {
	t.Helper()
	legacy := jsonx.Object{
		{Name: "paid_cents", Value: int32(10)},
		{Name: "open_cents", Value: int64(40)},
		{Name: "received_month_cents", Value: int32(7)},
		{Name: "status", Value: "open"},
	}
	with := func(extra ...jsonx.Field) []jsonx.Object {
		row := append(jsonx.Object{}, legacy...)
		row = append(row, extra...)
		return []jsonx.Object{row}
	}
	selection := BalanceReadSelection{SQL: variant, Reader: reader, Shadow: true}
	diverged := with(jsonx.Field{Name: "cmp_matches", Value: false}, jsonx.Field{Name: "cmp_received_cents", Value: int32(99)})
	beforeMismatch := counterValue(reader, balanceReadMismatch)
	if err := Strip(selection, diverged); err != nil {
		t.Fatal(err)
	}
	if diverged[0].Get("paid_cents") != int32(10) || diverged[0].Get("open_cents") != int64(40) || diverged[0].Get("received_month_cents") != int32(7) || diverged[0].Get("status") != "open" {
		t.Fatalf("mismatch recompôs o corpo: %#v", diverged[0])
	}
	if diverged[0].Get("cmp_matches") != nil || diverged[0].Get("cmp_received_cents") != nil {
		t.Fatal("cmp_ sobreviveu ao mismatch")
	}
	if counterValue(reader, balanceReadMismatch)-beforeMismatch != 1 {
		t.Fatal("mismatch sem métrica")
	}
	same := with(jsonx.Field{Name: "cmp_matches", Value: true}, jsonx.Field{Name: "cmp_nominal_cents", Value: int32(1)})
	beforeMatch := counterValue(reader, balanceReadMatch)
	if err := Strip(selection, same); err != nil {
		t.Fatal(err)
	}
	if same[0].Get("paid_cents") != int32(10) || same[0].Get("cmp_nominal_cents") != nil {
		t.Fatalf("igualdade: %#v", same[0])
	}
	if counterValue(reader, balanceReadMatch)-beforeMatch != 1 {
		t.Fatal("match sem métrica")
	}
	leaked := with(jsonx.Field{Name: "cmp_matches", Value: true})
	if err := Strip(BalanceReadSelection{SQL: variant, Reader: reader, Shadow: false}, leaked); err != errBalanceCompareLeak {
		t.Fatal(err)
	}
	if leaked[0].Get("cmp_matches") != true || leaked[0].Get("paid_cents") != int32(10) {
		t.Fatal("off alterou a linha")
	}
	broken := with(jsonx.Field{Name: "cmp_matches", Value: "false"})
	if err := Strip(selection, broken); err != errBalanceCompareProjection {
		t.Fatal(err)
	}
	if broken[0].Get("cmp_matches") != "false" || broken[0].Get("received_month_cents") != int32(7) {
		t.Fatal("projeção inválida alterou o corpo")
	}
}

func balanceShadowFormulaPieces() []string {
	return []string{
		"sum(mv.nominal_delta)::bigint as nominal_cents",
		"sum(mv.fee_delta)::bigint as fee_cents",
		"sum(mv.discount_delta)::bigint as discount_cents",
		"(array_agg(mv.status_after order by mv.id desc))[1] as last_status",
		"sum(py.signed_cents)::bigint as signed_cents",
		"coalesce(pay.signed_cents, 0)::bigint as received_cents",
		"coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents",
		"greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents)",
		"greatest(0, x.received_cents - (x.nominal_cents + x.fee_cents - x.discount_cents))",
		"case when x.status = 'canceled' then 0 else greatest(0, x.nominal_cents + x.fee_cents - x.discount_cents - x.received_cents) end",
		"(x.nominal_cents = x.legacy_nominal_cents and x.fee_cents = x.legacy_fee_cents and x.discount_cents = x.legacy_discount_cents and x.received_cents = x.legacy_received_cents and x.status = x.legacy_status) is true",
	}
}

func legacySQLBody(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(raw), "\n")
	for len(lines) > 0 && (strings.TrimSpace(lines[0]) == "" || strings.HasPrefix(strings.TrimSpace(lines[0]), "--")) {
		lines = lines[1:]
	}
	body := strings.TrimSpace(strings.Join(lines, "\n"))
	body = strings.TrimSuffix(body, ";")
	return strings.TrimSpace(body)
}

func movementLateral(sql string) string {
	return between(sql, "from invoice_movements mv", ") m on true")
}

func paymentLateral(sql string) string {
	return between(sql, "from payments py", ") pay on true")
}

func between(sql, start, end string) string {
	i := strings.Index(sql, start)
	if i < 0 {
		return ""
	}
	rest := sql[i:]
	j := strings.Index(rest, end)
	if j < 0 {
		return rest
	}
	return rest[:j]
}

func cmpMatchesClause(sql string) string {
	const marker = "is true as cmp_matches"
	i := strings.LastIndex(sql, marker)
	if i < 0 {
		return ""
	}
	head := sql[:i]
	open := strings.LastIndex(head, "(")
	if open < 0 {
		return head
	}
	return head[open:]
}

func requireAll(t *testing.T, sql string, pieces ...string) {
	t.Helper()
	for _, piece := range pieces {
		if !strings.Contains(sql, piece) {
			t.Fatalf("sem %s", piece)
		}
	}
}

func counterValue(reader, result string) float64 {
	metric := &dto.Metric{}
	if err := balanceReadCompare.WithLabelValues(reader, result).Write(metric); err != nil || metric.Counter == nil || metric.Counter.Value == nil {
		return 0
	}
	return metric.Counter.GetValue()
}

func cloneVariants(src map[string]string) map[string]string {
	out := make(map[string]string, len(src))
	for key, value := range src {
		out[key] = value
	}
	return out
}

func sameVariants(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}
