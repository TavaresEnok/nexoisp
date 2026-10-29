package leitura

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
)

func dueCompareCount(reader, result string) float64 {
	// Inc(1) lands in valInt of the prometheus counter. The field stays unexported.
	counter := balanceReadCompare.WithLabelValues(reader, result)
	return float64(reflect.ValueOf(counter).Elem().FieldByName("valInt").Uint())
}

func TestMain(m *testing.M) {
	if !dueVariantInitRegistered || strings.TrimSpace(dueShadowSQL) == "" || balanceVariants[balanceReaderInvoiceDue] != dueShadowSQL {
		fmt.Fprintln(os.Stderr, "init não registrou shadow/due.sql em invoice-due")
		os.Exit(1)
	}
	// TestBalanceReadRegisterVariant exige o mapa global vazio para provar que
	// um registerBalanceVariant rejeitado não grava leitor. A chave registrada
	// no init volta ao fim da suíte. O binário de produção não executa TestMain.
	delete(balanceVariants, balanceReaderInvoiceDue)
	code := m.Run()
	balanceVariants[balanceReaderInvoiceDue] = dueShadowSQL
	os.Exit(code)
}

func dueLocalPolicy(mode string, shadowAllow, cutAllow, withVariant bool, variant string) balanceReadPolicy {
	policy := balanceReadPolicy{
		Mode:     mode,
		Shadow:   map[string]struct{}{},
		Cut:      map[string]struct{}{},
		Variants: map[string]string{},
	}
	if shadowAllow {
		policy.Shadow[balanceReaderInvoiceDue] = struct{}{}
	}
	if cutAllow {
		policy.Cut[balanceReaderInvoiceDue] = struct{}{}
	}
	if withVariant {
		policy.Variants[balanceReaderInvoiceDue] = variant
	}
	return policy
}

func TestBalanceReadDueVariantRegisteredAndAllowlistsEmpty(t *testing.T) {
	if !dueVariantInitRegistered {
		t.Fatal("init não registrou a variante")
	}
	disk, err := os.ReadFile("shadow/due.sql")
	if err != nil {
		t.Fatal(err)
	}
	if string(disk) != dueShadowSQL {
		t.Fatal("embed divergiu de shadow/due.sql")
	}
	if _, ok := balanceVariants[balanceReaderInvoiceDue]; ok {
		t.Fatal("teste mutou o mapa global")
	}
	local := map[string]string{}
	if err := addBalanceVariant(local, balanceReaderInvoiceDue, dueShadowSQL); err != nil {
		t.Fatal(err)
	}
	if local[balanceReaderInvoiceDue] != dueShadowSQL {
		t.Fatal("registro local não guardou a sentença")
	}
	if len(balanceVariants) != 0 {
		t.Fatal("registro local escreveu no mapa global")
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlist compilada deixou de ser vazia")
	}
	variants, err := os.ReadFile("variants_due.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(variants)
	if !strings.Contains(text, "//go:embed shadow/due.sql") || !strings.Contains(text, "func init()") || !strings.Contains(text, "registerBalanceVariant(balanceReaderInvoiceDue, dueShadowSQL)") {
		t.Fatal("variants_due.go não registra o embed no init")
	}
	for _, mode := range []string{"", "off", "shadow", "cut", "SHADOW", " cut ", "desconhecido"} {
		t.Setenv("NEXO_BALANCE_READ", mode)
		got, err := Pick(balanceReaderInvoiceDue, gen.Due)
		if err != nil || got.Shadow || got.SQL != gen.Due || got.Reader != balanceReaderInvoiceDue {
			t.Fatalf("ambiente %q selecionou variante: %#v %v", mode, got, err)
		}
	}
}

func TestBalanceReadDueVariantOffDelegatesOnce(t *testing.T) {
	id := "6f1b3c2a-7d0e-4a1b-9c2d-111111111111"
	for _, mode := range []string{"", "off", "OFF", "shadow", "cut", "desconhecido"} {
		policy := dueLocalPolicy(mode, true, true, true, dueShadowSQL)
		if mode == "shadow" {
			policy.Shadow = map[string]struct{}{}
		}
		if mode == "cut" {
			policy.Cut = map[string]struct{}{}
		}
		queries, legacyCalls := 0, 0
		got, err := dueHTTPWith(context.Background(), id, policy, func(context.Context, string, ...any) ([]jsonx.Object, error) {
			queries++
			return nil, errors.New("off não executa a variante")
		}, func(context.Context, string) (map[string]any, error) {
			legacyCalls++
			return map[string]any{"status": "open", "remaining_cents": float64(10)}, nil
		})
		if err != nil || queries != 0 || legacyCalls != 1 || got["status"] != "open" || got["remaining_cents"] != float64(10) {
			t.Fatalf("modo %q queries=%d legacy=%d got=%#v err=%v", mode, queries, legacyCalls, got, err)
		}
	}
}

func TestBalanceReadDueVariantShadowOnePathAndPreview(t *testing.T) {
	policy := dueLocalPolicy("shadow", true, false, true, dueShadowSQL)
	id := "6f1b3c2a-7d0e-4a1b-9c2d-222222222222"
	cases := []jsonx.Object{
		dueRow("open", "2026-01-01", int32(10000), int32(150), int32(200), int32(300), int32(45), 2.0, 1.0),
		dueRow("open", "2026-02-01", int32(100), int32(0), int32(0), int32(0), int32(1), 0.5, 0.0),
		dueRow("open", "2026-02-02", int64(100), int64(0), int64(0), int64(0), int64(1), 0.49, float64(0)),
		dueRow("paid", nil, int32(5000), int32(80), int32(0), int32(5000), nil, 10.0, 10.0),
		dueRow("open", "2026-03-01", int32(8000), int32(100), int32(500), int32(250), int32(0), 2.0, 1.0),
		dueRow("reconciling", "2026-03-10", "1000", "0", "0", "4000", "10", "2", "1"),
		dueRow("canceled", "2026-04-01", int32(1500), int32(40), int32(2000), int32(10), int32(-4), 2.0, 1.0),
		dueRow("open", "2026-05-01", int32(10000), int32(900), int32(0), int32(0), int32(1), 2.0, 1.0),
	}
	for i, legacy := range cases {
		want := dueBreakdownFromRow(legacy)
		for _, matched := range []bool{true, false} {
			row := append(jsonx.Object{}, legacy...)
			row = append(row,
				jsonx.Field{Name: "cmp_matches", Value: matched},
				jsonx.Field{Name: "cmp_nominal_cents", Value: int32(1)},
				jsonx.Field{Name: "cmp_received_cents", Value: int32(1)},
				jsonx.Field{Name: "cmp_status", Value: "paid"},
				jsonx.Field{Name: "cmp_note", Value: "não servir"},
			)
			before := append(jsonx.Object{}, row...)
			result := balanceReadMatch
			if !matched {
				result = balanceReadMismatch
			}
			metricBefore := dueCompareCount(balanceReaderInvoiceDue, result)
			queries, legacyCalls := 0, 0
			got, err := dueHTTPWith(context.Background(), id, policy, func(_ context.Context, sql string, args ...any) ([]jsonx.Object, error) {
				queries++
				if sql != dueShadowSQL || sql == gen.Due {
					t.Fatalf("sentença %q", sql)
				}
				if len(args) != 1 || args[0] != id {
					t.Fatalf("args %#v", args)
				}
				return []jsonx.Object{row}, nil
			}, func(context.Context, string) (map[string]any, error) {
				legacyCalls++
				return nil, errors.New("variante não pode chamar DueBreakdown")
			})
			if err != nil || queries != 1 || legacyCalls != 0 || !reflect.DeepEqual(got, want) {
				t.Fatalf("caso %d match=%v queries=%d legacy=%d\ngot %#v\nwant %#v\nerr %v", i, matched, queries, legacyCalls, got, want, err)
			}
			if dueCompareCount(balanceReaderInvoiceDue, result)-metricBefore != 1 {
				t.Fatalf("caso %d não incrementou %s", i, result)
			}
			if !reflect.DeepEqual(row, before) {
				t.Fatal("a sentença devolveu linha já alterada")
			}
			for key := range got {
				if strings.HasPrefix(key, "cmp_") {
					t.Fatalf("corpo serviu %s", key)
				}
			}
			if got["status"] != want["status"] || got["fine_cents"] != want["fine_cents"] || got["interest_cents"] != want["interest_cents"] || got["remaining_cents"] != want["remaining_cents"] || got["fee_if_applied_cents"] != want["fee_if_applied_cents"] || got["paid_cents"] != want["paid_cents"] {
				t.Fatalf("prévia divergiu: %#v", got)
			}
		}
	}
}

func TestBalanceReadDueVariantShadowDoesNotFallBack(t *testing.T) {
	id := "id"
	missing := dueLocalPolicy("shadow", true, false, false, "")
	queries := 0
	_, err := dueHTTPWith(context.Background(), id, missing, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		queries++
		return nil, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("shadow sem variante usou DueBreakdown")
		return nil, nil
	})
	if queries != 0 || !errors.Is(err, errBalanceVariantMissing) {
		t.Fatalf("queries=%d err=%v", queries, err)
	}
	blank := dueLocalPolicy("shadow", true, false, true, "   ")
	_, err = dueHTTPWith(context.Background(), id, blank, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		t.Fatal("sql vazio executou")
		return nil, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("sql vazio usou DueBreakdown")
		return nil, nil
	})
	if !errors.Is(err, errBalanceVariantMissing) {
		t.Fatal(err)
	}

	policy := dueLocalPolicy("shadow", true, false, true, dueShadowSQL)
	legacy := dueRow("open", "2026-01-01", int32(10000), int32(150), int32(200), int32(300), int32(45), 2.0, 1.0)
	bad := append(append(jsonx.Object{}, legacy...), jsonx.Field{Name: "cmp_paid_cents", Value: int32(1)})
	kept := append(jsonx.Object{}, bad...)
	metricBefore := dueCompareCount(balanceReaderInvoiceDue, balanceReadMismatch)
	_, err = dueHTTPWith(context.Background(), id, policy, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		return []jsonx.Object{bad}, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("projeção inválida caiu no legado")
		return nil, nil
	})
	if !errors.Is(err, errBalanceCompareProjection) || !reflect.DeepEqual(bad, kept) {
		t.Fatalf("err=%v row=%#v", err, bad)
	}
	if dueCompareCount(balanceReaderInvoiceDue, balanceReadMismatch) != metricBefore {
		t.Fatal("projeção inválida incrementou métrica")
	}
	invalid := append(append(jsonx.Object{}, legacy...), jsonx.Field{Name: "cmp_matches", Value: "false"})
	_, err = dueHTTPWith(context.Background(), id, policy, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		return []jsonx.Object{invalid}, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("cmp_matches inválido caiu no legado")
		return nil, nil
	})
	if !errors.Is(err, errBalanceCompareProjection) || invalid[len(invalid)-1].Value != "false" {
		t.Fatal(err)
	}

	queries = 0
	_, err = dueHTTPWith(context.Background(), id, policy, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		queries++
		return []jsonx.Object{}, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("404 da variante caiu no legado")
		return nil, nil
	})
	httpErr, ok := err.(*apierr.Error)
	if queries != 1 || !ok || httpErr.Status != 404 || httpErr.Message != "fatura não encontrada" {
		t.Fatalf("missing: %v", err)
	}
	queryErr := errors.New("variante falhou")
	_, err = dueHTTPWith(context.Background(), id, policy, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		return nil, queryErr
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("erro da sentença única caiu no legado")
		return nil, nil
	})
	if !errors.Is(err, queryErr) {
		t.Fatal(err)
	}

	leaked := append(append(jsonx.Object{}, legacy...), jsonx.Field{Name: "cmp_matches", Value: true})
	if err := Strip(BalanceReadSelection{SQL: gen.Due, Reader: balanceReaderInvoiceDue, Shadow: false}, []jsonx.Object{leaked}); !errors.Is(err, errBalanceCompareLeak) || leaked[len(leaked)-1].Name != "cmp_matches" {
		t.Fatalf("off com cmp_: %v", err)
	}
}

func TestBalanceReadDueVariantSQLKeepsLegacyProjection(t *testing.T) {
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("gate de PostgreSQL e EXPLAIN ANALYZE não está aprovado")
	}
	shadow, err := os.ReadFile("shadow/due.sql")
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := os.ReadFile("queries/due.sql")
	if err != nil {
		t.Fatal(err)
	}
	generated, err := os.ReadFile("gen/due.sql.go")
	if err != nil {
		t.Fatal(err)
	}
	formula, err := os.ReadFile("queries/balance_shadow_compare.sql")
	if err != nil {
		t.Fatal(err)
	}
	shadowText := sqlWithoutLineComments(string(shadow))
	legacyText := sqlWithoutLineComments(string(legacy))
	formulaText := sqlWithoutLineComments(string(formula))
	for _, piece := range []string{
		"i.due_date::text as due_date",
		"case when i.status = 'open' then greatest(0, (now() at time zone coalesce(ts.timezone, 'america/sao_paulo'))::date - i.due_date)::int else 0 end as days_late",
		"coalesce(ts.late_fee_percent, 0)::float as fine_pct",
		"coalesce(ts.interest_monthly_percent, 0)::float as int_pct",
		"(select coalesce(sum(signed_cents), 0)::int from payments p where p.invoice_id = i.id) as paid_cents",
		"from invoices i",
		"left join tenant_settings ts on ts.tenant_id = i.tenant_id",
		"where i.id = $1",
		"as cmp_matches",
	} {
		if piece != "as cmp_matches" && !strings.Contains(legacyText, piece) {
			t.Fatalf("legado sem %s", piece)
		}
		if !strings.Contains(shadowText, piece) {
			t.Fatalf("variante sem %s", piece)
		}
	}
	for _, piece := range []string{
		"left join lateral",
		"from invoice_movements mv",
		"mv.tenant_id = i.tenant_id",
		"mv.invoice_id = i.id",
		"sum(mv.nominal_delta)",
		"sum(mv.fee_delta)",
		"sum(mv.discount_delta)",
		"array_agg(mv.status_after order by mv.id desc)",
		"from payments py",
		"py.invoice_id = i.id",
		"py.tenant_id = i.tenant_id",
		"sum(py.signed_cents)",
		"is true as matches",
		"as residual_cents",
		"as excess_cents",
		"as collectible_cents",
		"case when x.status = 'canceled' then 0",
		"coalesce(pay.signed_cents, 0)::bigint as received_cents",
		"coalesce(pay.signed_cents, 0)::bigint as legacy_received_cents",
		"i.amount_cents::bigint as legacy_nominal_cents",
	} {
		if !strings.Contains(formulaText, piece) || !strings.Contains(shadowText, piece) {
			t.Fatalf("fórmula ausente em %s", piece)
		}
	}
	if strings.Contains(shadowText, "financial_balance_shadow") || strings.Contains(legacyText, "cmp_") || strings.Contains(string(generated), "cmp_") {
		t.Fatal("view ou cmp_ entrou na sentença errada")
	}
	if strings.Contains(shadowText, "as fine_cents") || strings.Contains(shadowText, "as interest_cents") || strings.Contains(shadowText, "fee_if_applied_cents") {
		t.Fatal("prévia de multa ou juros entrou na sombra")
	}
	if strings.Contains(shadowText, "any($1::uuid[])") || strings.Count(shadowText, ";") != 1 {
		t.Fatal("a variante due não é uma sentença de um id")
	}
	if strings.Contains(string(generated), "Code generated by sqlc. DO NOT EDIT.") && strings.Contains(string(generated), "const Due = ") && strings.Contains(legacyText, "as paid_cents") {
		return
	}
	t.Fatal("due.sql ou gen.Due mudou de forma")
}

func TestBalanceReadDueVariantWritersStayOnDueBreakdown(t *testing.T) {
	dueHTTP, err := os.ReadFile("due_http.go")
	if err != nil {
		t.Fatal(err)
	}
	dueSrc := string(dueHTTP)
	start := strings.Index(dueSrc, "func DueHTTP(")
	if start < 0 || strings.Count(dueSrc, "func DueHTTP(") != 1 {
		t.Fatal("DueHTTP duplicado")
	}
	fn := dueSrc[start:]
	if strings.Count(fn, "dueHTTPWith(") != 1 || strings.Count(fn, "productionBalancePolicy(") != 1 || strings.Count(fn, "tx.Objects(") != 1 || strings.Count(fn, "DueBreakdown(") != 1 {
		t.Fatalf("DueHTTP não tem um caminho: %s", fn)
	}
	if strings.Contains(fn, "dueServe(") || strings.Contains(fn, "duePick(") || strings.Contains(fn, "stripDueCompare(") {
		t.Fatal("DueHTTP voltou à política local de C3a")
	}
	if strings.Contains(dueSrc, "func dueBreakdownFromRow(") || strings.Contains(dueSrc, "registerBalanceVariant(") {
		t.Fatal("due_http.go reabriu cálculo ou registro")
	}
	calc, err := os.ReadFile("due_calculation.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(calc), "func dueBreakdownFromRow(") != 1 {
		t.Fatal("dueBreakdownFromRow deixou de ter um dono")
	}
	for _, path := range []string{"../../finance/core.go", "../../finance/advanced.go", "auxiliares.go"} {
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		body := string(text)
		if path == "auxiliares.go" {
			if !strings.Contains(body, "func DueBreakdown(") || !strings.Contains(body, "tx.Objects(ctx, gen.Due, id)") || strings.Contains(body, "dueShadowSQL") || strings.Contains(body, "shadow/due.sql") {
				t.Fatal("DueBreakdown deixou de ser gen.Due")
			}
			continue
		}
		if !strings.Contains(body, "leitura.DueBreakdown(") || strings.Contains(body, "DueHTTP") || strings.Contains(body, "dueShadowSQL") || strings.Contains(body, "shadow/due.sql") {
			t.Fatalf("%s passou a depender da variante", path)
		}
	}
	inert, err := os.ReadFile("../../finance/sql/c59c1801_0.sql")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(inert), "cmp_") || !strings.Contains(string(inert), "as paid_cents") {
		t.Fatal("cópia finance/c59c foi ativada")
	}
}
