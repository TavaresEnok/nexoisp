package leitura

import (
	"encoding/json"
	"maps"
	"os"
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"

	"github.com/prometheus/client_golang/prometheus"
)

func TestBalanceReadInvoiceListRegisteredOutsideLegacy(t *testing.T) {
	legacy, err := os.ReadFile("dinamicas/4a483e96_1.sql")
	if err != nil {
		t.Fatal(err)
	}
	variant, err := os.ReadFile("shadow/4a483e96_1.sql")
	if err != nil {
		t.Fatal(err)
	}
	legacySQL := string(legacy)
	variantSQL := string(variant)
	if !strings.Contains(variantSQL, legacySQL) {
		t.Fatal("a variante não preserva a sentença legada da lista")
	}
	if invoiceListVariantSQL != variantSQL {
		t.Fatal("o embed da lista não é shadow/4a483e96_1.sql")
	}
	if balanceVariants[balanceReaderInvoiceList] != variantSQL || strings.TrimSpace(variantSQL) == "" {
		t.Fatal("init não registrou invoice-list com o embed próprio")
	}

	meta, err := os.ReadFile("dinamicas.json")
	if err != nil {
		t.Fatal(err)
	}
	var specs []struct {
		Path       string   `json:"path"`
		Permission string   `json:"permission"`
		Queries    []string `json:"queries"`
	}
	if err := json.Unmarshal(meta, &specs); err != nil {
		t.Fatal(err)
	}
	var invoices *struct {
		Path       string   `json:"path"`
		Permission string   `json:"permission"`
		Queries    []string `json:"queries"`
	}
	for i := range specs {
		if specs[i].Path == "/api/invoices" {
			invoices = &specs[i]
		}
	}
	if invoices == nil || invoices.Permission != "finance:read" || len(invoices.Queries) < 2 || invoices.Queries[1] != "4a483e96_1.sql" {
		t.Fatalf("dinamicas.json da lista mudou: %#v", invoices)
	}
	if strings.Contains(string(meta), "shadow/") {
		t.Fatal("dinamicas.json passou a apontar para shadow")
	}

	handler, err := os.ReadFile("dinamicas.go")
	if err != nil {
		t.Fatal(err)
	}
	fn := functionSource(t, string(handler), "func (s Service) invoices(")
	if !strings.Contains(fn, `dynamicSQL("/api/invoices", 1,`) || !strings.Contains(fn, `balanceRowsInTx(ctx, tx, balanceReaderInvoiceList, query, args...)`) {
		t.Fatal("a lista deixou de passar o SQL legado do índice 1 por balanceRowsInTx")
	}
	if strings.Contains(fn, "invoiceListVariantSQL") {
		t.Fatal("a lista em produção passou a executar a variante")
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlist de produção da lista foi preenchida")
	}
	legacyQuery := dynamicSQL("/api/invoices", 1, map[string]string{"limit": "25", "offset": "50"})
	if strings.Contains(legacyQuery, "cmp_") || strings.Contains(legacyQuery, "{{") || !strings.Contains(legacyQuery, "limit 25 offset 50") {
		t.Fatalf("índice 1 não é a sentença legada: %s", legacyQuery)
	}
	selected, err := Pick(balanceReaderInvoiceList, legacyQuery)
	if err != nil || selected.Shadow || selected.SQL != legacyQuery || selected.Reader != balanceReaderInvoiceList {
		t.Fatalf("allowlists vazias não devolveram o índice 1: err=%v sel=%#v", err, selected)
	}

	sqlc, err := os.ReadFile("../../../sqlc.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(sqlc), "shadow") {
		t.Fatal("sqlc.yaml passou a ler shadow")
	}
}

func TestBalanceReadInvoiceListFormulaAndSelection(t *testing.T) {
	variant := invoiceListVariantSQL
	compare, err := os.ReadFile("queries/balance_shadow_compare.sql")
	if err != nil {
		t.Fatal(err)
	}
	compareSQL := sqlWithoutLineComments(string(compare))
	variantSQL := sqlWithoutLineComments(variant)
	for _, piece := range []string{
		"left join lateral",
		"from invoice_movements mv",
		"where mv.tenant_id = i.tenant_id and mv.invoice_id = i.id",
		"sum(mv.nominal_delta)::bigint as nominal_cents",
		"sum(mv.fee_delta)::bigint as fee_cents",
		"sum(mv.discount_delta)::bigint as discount_cents",
		"(array_agg(mv.status_after order by mv.id desc))[1] as last_status",
		"from payments py",
		"where py.invoice_id = i.id and py.tenant_id = i.tenant_id",
		"sum(py.signed_cents)::bigint as signed_cents",
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
		if !strings.Contains(variantSQL, piece) {
			t.Fatalf("variante sem a expressão %s", piece)
		}
	}
	if strings.Contains(variantSQL, "financial_balance_shadow") || strings.Contains(variantSQL, "group by tenant_id") {
		t.Fatal("variante lê a view ou agrega o tenant")
	}
	if strings.Contains(variantSQL, "id = any(") || strings.Contains(variantSQL, "$6") {
		t.Fatal("variante troca os parâmetros da lista ou abre segunda lista de ids")
	}
	if strings.Contains(variant, ";") {
		t.Fatal("variante tem mais de uma sentença")
	}
	for _, banned := range []string{"row_security", "bypassrls", "security definer", "set role", "security_invoker"} {
		if strings.Contains(variantSQL, banned) {
			t.Fatalf("variante altera RLS: %s", banned)
		}
	}
	page := strings.Index(variantSQL, "limit {{limit}} offset {{offset}}")
	sums := strings.Index(variantSQL, "from invoice_movements mv")
	filtered := strings.Index(variantSQL, "where i.id = leg.id and i.tenant_id = leg.tenant_id")
	if page < 0 || sums < 0 || filtered < 0 || page > sums || filtered > sums {
		t.Fatal("a lateral soma antes de filtrar a página já selecionada")
	}
	for _, piece := range []string{
		"$1::uuid",
		"$2::text",
		"$3::date",
		"$4",
		"$5::uuid",
		"{{limit}}",
		"{{offset}}",
		"coalesce(sum(x.signed_cents), 0)::int",
		"as overdue",
		"as subscriber_name",
		"as plan_name",
		"as cmp_matches",
		"as cmp_residual_cents",
		"as cmp_excess_cents",
		"as cmp_collectible_cents",
		"leg.paid_cents::bigint = cmp.received_cents",
		"leg.overdue is not distinct from (leg.status = 'open' and leg.due_date < $3::date)",
	} {
		if !strings.Contains(variantSQL, piece) {
			t.Fatalf("lista sem %s", piece)
		}
	}
	if strings.Contains(variantSQL, "fine_cents") || strings.Contains(variantSQL, "received_month_cents") {
		t.Fatal("variante promove prévia ou caixa do mês")
	}
	templates := templateNames(variant)
	if len(templates) != 2 || templates["limit"] != 1 || templates["offset"] != 1 {
		t.Fatalf("templates %v", templates)
	}
}

func TestBalanceReadInvoiceListPolicyKeepsProductionOff(t *testing.T) {
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlist de produção da lista foi preenchida")
	}
	legacy := dynamicSQL("/api/invoices", 1, map[string]string{"limit": "25", "offset": "50"})
	if strings.Contains(legacy, "{{") || strings.Contains(legacy, "cmp_") || !strings.Contains(legacy, "limit 25 offset 50") {
		t.Fatalf("legado parametrizado: %s", legacy)
	}
	before := maps.Clone(balanceVariants)
	for _, mode := range []string{"", "off", "shadow", "cut", "SHADOW", " ligado"} {
		t.Setenv("NEXO_BALANCE_READ", mode)
		got, err := Pick(balanceReaderInvoiceList, legacy)
		if err != nil || got.Shadow || got.SQL != legacy || got.Reader != balanceReaderInvoiceList {
			t.Fatalf("modo %q selecionou a variante: err=%v sel=%#v", mode, err, got)
		}
	}
	if !maps.Equal(balanceVariants, before) {
		t.Fatal("Pick mutou o registro global")
	}

	local := balanceReadPolicy{
		Mode:     "shadow",
		Shadow:   map[string]struct{}{balanceReaderInvoiceList: {}},
		Cut:      map[string]struct{}{},
		Variants: map[string]string{balanceReaderInvoiceList: invoiceListVariantSQL},
	}
	got, err := local.pick(balanceReaderInvoiceList, legacy)
	if err != nil || !got.Shadow || got.SQL != invoiceListVariantSQL || got.Reader != balanceReaderInvoiceList {
		t.Fatalf("política local não exerce a variante única: err=%v sel=%#v", err, got)
	}
	if !maps.Equal(balanceVariants, before) {
		t.Fatal("política local gravou no mapa global")
	}
	applied := got.SQL
	for key, value := range map[string]string{"limit": "25", "offset": "50"} {
		applied = strings.ReplaceAll(applied, "{{"+key+"}}", value)
	}
	if strings.Contains(applied, "{{") || strings.Contains(applied, ";") || !strings.Contains(applied, "limit 25 offset 50") {
		t.Fatal("a variante única não aceita a mesma paginação")
	}
	off := balanceReadPolicy{Mode: "off", Shadow: local.Shadow, Cut: local.Cut, Variants: local.Variants}
	got, err = off.pick(balanceReaderInvoiceList, legacy)
	if err != nil || got.Shadow || got.SQL != legacy {
		t.Fatalf("off local: err=%v sel=%#v", err, got)
	}
	emptyShadow := balanceReadPolicy{Mode: "shadow", Shadow: map[string]struct{}{}, Cut: map[string]struct{}{}, Variants: local.Variants}
	got, err = emptyShadow.pick(balanceReaderInvoiceList, legacy)
	if err != nil || got.Shadow || got.SQL != legacy {
		t.Fatalf("shadow com allowlist vazia: err=%v sel=%#v", err, got)
	}
	cut := balanceReadPolicy{Mode: "cut", Shadow: local.Shadow, Cut: map[string]struct{}{}, Variants: local.Variants}
	got, err = cut.pick(balanceReaderInvoiceList, legacy)
	if err != nil || got.Shadow || got.SQL != legacy {
		t.Fatalf("cut com allowlist vazia: err=%v sel=%#v", err, got)
	}
	missing := balanceReadPolicy{Mode: "shadow", Shadow: local.Shadow, Cut: map[string]struct{}{}, Variants: map[string]string{}}
	got, err = missing.pick(balanceReaderInvoiceList, legacy)
	if err != errBalanceVariantMissing || got.SQL != "" || got.Shadow {
		t.Fatalf("shadow sem variante caiu no legado: err=%v sel=%#v", err, got)
	}
}

func TestBalanceReadInvoiceListStripKeepsLegacyBody(t *testing.T) {
	legacy := jsonx.Object{
		{Name: "id", Value: "inv-1"},
		{Name: "status", Value: "open"},
		{Name: "amount_cents", Value: int32(1000)},
		{Name: "fee_cents", Value: int32(10)},
		{Name: "discount_cents", Value: int32(5)},
		{Name: "paid_cents", Value: int32(40)},
		{Name: "overdue", Value: true},
		{Name: "subscriber_name", Value: "Ada"},
		{Name: "plan_name", Value: "100 mega"},
	}
	clone := func(extra ...jsonx.Field) []jsonx.Object {
		row := append(jsonx.Object{}, legacy...)
		return []jsonx.Object{append(row, extra...)}
	}
	reg := prometheus.NewRegistry()
	if err := RegisterBalanceReadMetrics(reg); err != nil && !strings.Contains(err.Error(), "duplicate") {
		t.Fatal(err)
	}

	off := clone(jsonx.Field{Name: "cmp_matches", Value: true})
	offSelection := BalanceReadSelection{SQL: "legacy", Reader: balanceReaderInvoiceList, Shadow: false}
	if err := Strip(offSelection, off); err != errBalanceCompareLeak {
		t.Fatal(err)
	}
	if off[0].Get("paid_cents") != int32(40) || off[0].Get("cmp_matches") != true {
		t.Fatalf("off alterou a linha: %#v", off[0])
	}

	sameBody := clone()
	if err := Strip(offSelection, sameBody); err != nil {
		t.Fatal(err)
	}
	assertSameFields(t, sameBody[0], legacy)

	matchBefore := sample(reg, balanceReaderInvoiceList, balanceReadMatch)
	matched := clone(
		jsonx.Field{Name: "cmp_matches", Value: true},
		jsonx.Field{Name: "cmp_received_cents", Value: int64(40)},
		jsonx.Field{Name: "cmp_residual_cents", Value: int64(965)},
		jsonx.Field{Name: "cmp_excess_cents", Value: int64(0)},
		jsonx.Field{Name: "cmp_collectible_cents", Value: int64(965)},
	)
	shadow := BalanceReadSelection{SQL: invoiceListVariantSQL, Reader: balanceReaderInvoiceList, Shadow: true}
	if err := Strip(shadow, matched); err != nil {
		t.Fatal(err)
	}
	assertSameFields(t, matched[0], legacy)
	if sample(reg, balanceReaderInvoiceList, balanceReadMatch)-matchBefore != 1 {
		t.Fatal("igualdade sem métrica match")
	}

	mismatchBefore := sample(reg, balanceReaderInvoiceList, balanceReadMismatch)
	diverged := clone(
		jsonx.Field{Name: "cmp_matches", Value: false},
		jsonx.Field{Name: "cmp_received_cents", Value: int64(999)},
		jsonx.Field{Name: "cmp_residual_cents", Value: int64(1)},
		jsonx.Field{Name: "cmp_excess_cents", Value: int64(2)},
		jsonx.Field{Name: "cmp_collectible_cents", Value: int64(3)},
	)
	if err := Strip(shadow, diverged); err != nil {
		t.Fatal(err)
	}
	assertSameFields(t, diverged[0], legacy)
	if diverged[0].Get("paid_cents") != int32(40) || diverged[0].Get("amount_cents") != int32(1000) {
		t.Fatal("divergência recompôs centavos")
	}
	if sample(reg, balanceReaderInvoiceList, balanceReadMismatch)-mismatchBefore != 1 {
		t.Fatal("divergência sem métrica mismatch")
	}
}

func TestBalanceReadInvoiceListDatabaseGatePending(t *testing.T) {
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("gate de PostgreSQL e EXPLAIN da lista não está aprovado")
	}
	if _, err := os.Stat("shadow/4a483e96_1.sql"); err != nil {
		t.Fatal(err)
	}
}

func functionSource(t *testing.T, file, signature string) string {
	t.Helper()
	start := strings.Index(file, signature)
	if start < 0 {
		t.Fatalf("função ausente: %s", signature)
	}
	rest := file[start+len(signature):]
	next := strings.Index(rest, "\nfunc ")
	if next < 0 {
		return file[start:]
	}
	return file[start : start+len(signature)+next]
}

func templateNames(sql string) map[string]int {
	names := map[string]int{}
	rest := sql
	for {
		open := strings.Index(rest, "{{")
		if open < 0 {
			return names
		}
		rest = rest[open+2:]
		close := strings.Index(rest, "}}")
		if close < 0 {
			names["unclosed"]++
			return names
		}
		names[rest[:close]]++
		rest = rest[close+2:]
	}
}

func assertSameFields(t *testing.T, got, want jsonx.Object) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("corpo %d campos, legado %d: %#v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].Name != want[i].Name || got[i].Value != want[i].Value {
			t.Fatalf("campo %d: got=%#v want=%#v", i, got[i], want[i])
		}
		if strings.HasPrefix(got[i].Name, "cmp_") {
			t.Fatalf("cmp_ no corpo: %s", got[i].Name)
		}
	}
}
