package leitura

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strings"
	"testing"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
)

func dueRow(status any, due any, amount, fee, discount, paid, days any, fine, interest any) jsonx.Object {
	return jsonx.Object{
		{Name: "status", Value: status},
		{Name: "due_date", Value: due},
		{Name: "amount_cents", Value: amount},
		{Name: "fee_cents", Value: fee},
		{Name: "discount_cents", Value: discount},
		{Name: "paid_cents", Value: paid},
		{Name: "days_late", Value: days},
		{Name: "fine_pct", Value: fine},
		{Name: "int_pct", Value: interest},
	}
}

func dueMap(status, due any, amount, fee, discount, paid, remaining, days, fine, interest, applied float64) map[string]any {
	return map[string]any{
		"status": status, "due_date": due,
		"amount_cents": amount, "fee_cents": fee, "discount_cents": discount, "paid_cents": paid,
		"remaining_cents": remaining, "days_late": days,
		"fine_cents": fine, "interest_cents": interest, "fee_if_applied_cents": applied,
	}
}

func TestDueBreakdownFromRowDelayPartialAndStates(t *testing.T) {
	cases := []struct {
		name string
		row  jsonx.Object
		want map[string]any
	}{
		{
			name: "atraso positivo com multa e juros arredondados",
			row:  dueRow("open", "2026-01-01", int32(10000), int32(150), int32(200), int32(300), int32(45), 2.0, 1.0),
			want: dueMap("open", "2026-01-01", 10000, 150, 200, 300, 9650, 45, 200, 150, 350),
		},
		{
			name: "meio centavo de multa sobe e abaixo de meio fica",
			row:  dueRow("open", "2026-02-01", int32(100), int32(0), int32(0), int32(0), int32(1), 0.5, 0.0),
			want: dueMap("open", "2026-02-01", 100, 0, 0, 0, 100, 1, 1, 0, 1),
		},
		{
			name: "multa abaixo de meio centavo",
			row:  dueRow("open", "2026-02-02", int64(100), int64(0), int64(0), int64(0), int64(1), 0.49, float64(0)),
			want: dueMap("open", "2026-02-02", 100, 0, 0, 0, 100, 1, 0, 0, 0),
		},
		{
			name: "dias nulos não lançam prévia e encargo lançado permanece",
			row:  dueRow("paid", nil, int32(5000), int32(80), int32(0), int32(5000), nil, 10.0, 10.0),
			want: dueMap("paid", nil, 5000, 80, 0, 5000, 80, 0, 0, 0, 80),
		},
		{
			name: "dias zero com parcial desconto e encargos",
			row:  dueRow("open", "2026-03-01", int32(8000), int32(100), int32(500), int32(250), int32(0), 2.0, 1.0),
			want: dueMap("open", "2026-03-01", 8000, 100, 500, 250, 7350, 0, 0, 0, 100),
		},
		{
			name: "excesso de recebimento zera residual e a prévia não substitui fee menor",
			row:  dueRow("reconciling", "2026-03-10", "1000", "0", "0", "4000", "10", "2", "1"),
			want: dueMap("reconciling", "2026-03-10", 1000, 0, 0, 4000, 0, 10, 20, 3, 23),
		},
		{
			name: "dias negativos e cancelada não fabricam multa",
			row:  dueRow("canceled", "2026-04-01", int32(1500), int32(40), int32(2000), int32(10), int32(-4), 2.0, 1.0),
			want: dueMap("canceled", "2026-04-01", 1500, 40, 2000, 10, 0, -4, 0, 0, 40),
		},
		{
			name: "fee lançado maior que a prévia permanece em fee_if_applied",
			row:  dueRow("open", "2026-05-01", int32(10000), int32(900), int32(0), int32(0), int32(1), 2.0, 1.0),
			want: dueMap("open", "2026-05-01", 10000, 900, 0, 0, 10900, 1, 200, 3, 900),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dueBreakdownFromRow(tc.row)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v\nwant %#v", got, tc.want)
			}
		})
	}
}

func TestDueBreakdownMissingAndQueryError(t *testing.T) {
	queryErr := errors.New("falha de leitura")
	got, err := dueBreakdownFromQuery(nil, queryErr)
	if got != nil || !errors.Is(err, queryErr) {
		t.Fatalf("erro da query não preservado: %#v %v", got, err)
	}
	got, err = dueBreakdownFromQuery(nil, nil)
	httpErr, ok := err.(*apierr.Error)
	if got != nil || !ok || httpErr.Status != 404 || httpErr.Message != "fatura não encontrada" {
		t.Fatalf("missing: %#v %v", got, err)
	}
	got, err = dueBreakdownFromQuery([]jsonx.Object{}, nil)
	httpErr, ok = err.(*apierr.Error)
	if got != nil || !ok || httpErr.Status != 404 {
		t.Fatalf("vazio: %#v %v", got, err)
	}
	row := dueRow("open", "2026-01-01", int32(100), int32(0), int32(0), int32(0), int32(0), 0.0, 0.0)
	got, err = dueBreakdownFromQuery([]jsonx.Object{row, dueRow("paid", "x", int32(1), int32(0), int32(0), int32(0), int32(0), 0.0, 0.0)}, nil)
	if err != nil || got["status"] != "open" || got["amount_cents"] != float64(100) {
		t.Fatalf("primeira linha: %#v %v", got, err)
	}
}

func TestDueBreakdownQueriesGenDueOnce(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "auxiliares.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var body *ast.BlockStmt
	var getDue *ast.BlockStmt
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		if fn.Name.Name == "DueBreakdown" {
			body = fn.Body
		}
		if fn.Name.Name == "registerAuxiliares" {
			getDue = fn.Body
		}
	}
	if body == nil || getDue == nil {
		t.Fatal("funções ausentes")
	}
	objects, dueRef := 0, 0
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		if sel.Sel.Name == "Objects" {
			objects++
			if len(call.Args) >= 2 {
				arg, ok := call.Args[1].(*ast.SelectorExpr)
				if ok && arg.Sel.Name == "Due" {
					dueRef++
				}
			}
		}
		return true
	})
	if objects != 1 || dueRef != 1 {
		t.Fatalf("DueBreakdown objects=%d gen.Due=%d", objects, dueRef)
	}
	src := fset.File(file.Pos()).Name()
	text, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	handler := string(text)
	dueCall := strings.Index(handler, "result, err = DueHTTP(ctx, tx, id)")
	oldCall := strings.Index(handler, "result, err = DueBreakdown(ctx, tx, id)")
	uuidAt := strings.Index(handler, "validate.UUID(id)")
	scopeAt := strings.Index(handler, "s.DB.WithScope(")
	if dueCall < 0 || oldCall >= 0 || uuidAt < 0 || scopeAt < 0 || !(uuidAt < scopeAt && scopeAt < dueCall) {
		t.Fatalf("ramo GET uuid=%d scope=%d due=%d antigo=%d", uuidAt, scopeAt, dueCall, oldCall)
	}
	if !strings.Contains(handler, `{"/api/invoices/{id}/due", "finance:read"}`) {
		t.Fatal("permissão do GET due mudou")
	}
}

func TestDueHTTPOffIsLegacySentence(t *testing.T) {
	t.Setenv("NEXO_BALANCE_READ", "shadow")
	t.Setenv("NEXO_BALANCE_READ_SHADOW", "invoice-due")
	policy := dueCompiledPolicy()
	if policy.mode != "off" || len(policy.shadowAllow) != 0 || len(policy.cutAllow) != 0 || len(policy.variants) != 0 {
		t.Fatalf("política compilada habilitou leitor: %+v", policy)
	}
	for _, mode := range []string{"", "off", "OFF", "shadow", "cut", "desconhecido"} {
		local := dueCompiledPolicy()
		local.mode = mode
		if mode == "shadow" {
			local.shadowAllow = map[string]struct{}{"other-reader": {}}
			local.variants = map[string]string{"other-reader": "select variante"}
		}
		if mode == "cut" {
			local.cutAllow = map[string]struct{}{dueReaderID: {}}
			local.variants = map[string]string{dueReaderID: "select corte"}
		}
		sql, shadow, err := duePick(local, dueReaderID, gen.Due)
		if err != nil || shadow || sql != gen.Due {
			t.Fatalf("modo %q escolheu variante: sql=%q shadow=%v err=%v", mode, sql, shadow, err)
		}
		queries, legacyCalls := 0, 0
		got, err := dueServe(context.Background(), "invoice", local, func(string) {
			t.Fatal("off não observa comparação")
		}, func(context.Context, string, ...any) ([]jsonx.Object, error) {
			queries++
			return nil, errors.New("não devia consultar a variante")
		}, func(context.Context, string) (map[string]any, error) {
			legacyCalls++
			return map[string]any{"status": "open", "remaining_cents": float64(10)}, nil
		})
		if err != nil || queries != 0 || legacyCalls != 1 || got["status"] != "open" || got["remaining_cents"] != float64(10) {
			t.Fatalf("modo %q queries=%d legacy=%d got=%#v err=%v", mode, queries, legacyCalls, got, err)
		}
	}
	var _ func(context.Context, *db.Tx, string) (map[string]any, error) = DueHTTP
}

func TestDueShadowOneSelectionStripAndPureCalc(t *testing.T) {
	const variant = "select variante invoice-due"
	policy := duePolicy{
		mode:        "shadow",
		shadowAllow: map[string]struct{}{dueReaderID: {}},
		cutAllow:    map[string]struct{}{},
		variants:    map[string]string{dueReaderID: variant},
	}
	legacyRow := dueRow("open", "2026-01-01", int32(10000), int32(150), int32(200), int32(300), int32(45), 2.0, 1.0)
	want := dueBreakdownFromRow(legacyRow)
	withCompare := append(jsonx.Object{}, legacyRow...)
	withCompare = append(withCompare,
		jsonx.Field{Name: "cmp_matches", Value: false},
		jsonx.Field{Name: "cmp_paid_cents", Value: int32(1)},
		jsonx.Field{Name: "cmp_amount_cents", Value: int32(1)},
		jsonx.Field{Name: "cmp_note", Value: "não servir"},
	)
	original := append(jsonx.Object{}, withCompare...)
	var seen []string
	queries := 0
	legacyCalls := 0
	got, err := dueServe(context.Background(), "6f1b3c2a-7d0e-4a1b-9c2d-111111111111", policy, func(result string) {
		seen = append(seen, result)
	}, func(_ context.Context, sql string, args ...any) ([]jsonx.Object, error) {
		queries++
		if sql != variant || sql == gen.Due {
			t.Fatalf("sentença %q", sql)
		}
		if len(args) != 1 || args[0] != "6f1b3c2a-7d0e-4a1b-9c2d-111111111111" {
			t.Fatalf("args %#v", args)
		}
		return []jsonx.Object{withCompare}, nil
	}, func(context.Context, string) (map[string]any, error) {
		legacyCalls++
		return nil, errors.New("segunda query")
	})
	if err != nil || queries != 1 || legacyCalls != 0 || !reflect.DeepEqual(got, want) {
		t.Fatalf("queries=%d legacy=%d got=%#v want=%#v err=%v", queries, legacyCalls, got, want, err)
	}
	if !reflect.DeepEqual(seen, []string{"mismatch"}) {
		t.Fatalf("métrica %#v", seen)
	}
	if !reflect.DeepEqual(withCompare, original) {
		t.Fatal("strip alterou a linha antes de copiar o resultado da query")
	}
	for _, field := range []string{"cmp_matches", "cmp_paid_cents", "cmp_amount_cents", "cmp_note"} {
		if _, ok := got[field]; ok {
			t.Fatalf("corpo serviu %s", field)
		}
	}
	if got["paid_cents"] != float64(300) || got["amount_cents"] != float64(10000) || got["fine_cents"] != float64(200) {
		t.Fatalf("centavos recompostos: %#v", got)
	}

	matched := append(jsonx.Object{}, legacyRow...)
	matched = append(matched, jsonx.Field{Name: "cmp_matches", Value: true}, jsonx.Field{Name: "cmp_paid_cents", Value: int32(999)})
	seen = nil
	queries = 0
	got, err = dueServe(context.Background(), "id", policy, func(result string) { seen = append(seen, result) }, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		queries++
		return []jsonx.Object{matched}, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("match não pode chamar DueBreakdown")
		return nil, nil
	})
	if err != nil || queries != 1 || !reflect.DeepEqual(got, want) || !reflect.DeepEqual(seen, []string{"match"}) {
		t.Fatalf("match queries=%d got=%#v seen=%#v err=%v", queries, got, seen, err)
	}

	queries = 0
	_, err = dueServe(context.Background(), "id", policy, func(string) { t.Fatal("404 não mede") }, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		queries++
		return []jsonx.Object{}, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("404 da variante não cai no legado")
		return nil, nil
	})
	httpErr, ok := err.(*apierr.Error)
	if queries != 1 || !ok || httpErr.Status != 404 || httpErr.Message != "fatura não encontrada" {
		t.Fatalf("missing shadow: %v", err)
	}
	queryErr := errors.New("variante falhou")
	_, err = dueServe(context.Background(), "id", policy, nil, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		return nil, queryErr
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("erro da sentença única não cai no legado")
		return nil, nil
	})
	if !errors.Is(err, queryErr) {
		t.Fatal(err)
	}
}

func TestDueShadowWithoutVariantOrCmpIsError(t *testing.T) {
	policy := duePolicy{mode: "shadow", shadowAllow: map[string]struct{}{dueReaderID: {}}, cutAllow: map[string]struct{}{}, variants: map[string]string{}}
	queries := 0
	_, err := dueServe(context.Background(), "id", policy, nil, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		queries++
		return nil, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("shadow sem variante não usa o legado")
		return nil, nil
	})
	if queries != 0 || err == nil || !strings.Contains(err.Error(), "shadow sem variante") {
		t.Fatalf("queries=%d err=%v", queries, err)
	}
	policy.variants = map[string]string{dueReaderID: "   "}
	_, err = dueServe(context.Background(), "id", policy, nil, func(context.Context, string, ...any) ([]jsonx.Object, error) {
		t.Fatal("sql vazio não executa")
		return nil, nil
	}, func(context.Context, string) (map[string]any, error) {
		t.Fatal("sql vazio não usa o legado")
		return nil, nil
	})
	if err == nil || !strings.Contains(err.Error(), "shadow sem variante") {
		t.Fatal(err)
	}

	row := dueRow("open", "2026-01-01", int32(10), int32(0), int32(0), int32(0), int32(0), 0.0, 0.0)
	kept := append(jsonx.Object{}, row...)
	bad := append(append(jsonx.Object{}, row...), jsonx.Field{Name: "cmp_paid_cents", Value: int32(1)})
	if err = stripDueCompare(true, []jsonx.Object{bad}, func(string) { t.Fatal("sem matches não mede") }); err == nil || !strings.Contains(err.Error(), "cmp_matches ausente") {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(bad, append(append(jsonx.Object{}, kept...), jsonx.Field{Name: "cmp_paid_cents", Value: int32(1)})) {
		t.Fatal("erro de strip alterou a linha")
	}
	invalid := append(append(jsonx.Object{}, row...), jsonx.Field{Name: "cmp_matches", Value: "false"})
	if err = stripDueCompare(true, []jsonx.Object{invalid}, nil); err == nil || !strings.Contains(err.Error(), "cmp_matches inválido") {
		t.Fatal(err)
	}
	off := append(append(jsonx.Object{}, row...), jsonx.Field{Name: "cmp_matches", Value: true})
	if err = stripDueCompare(false, []jsonx.Object{off}, func(string) { t.Fatal("off não mede") }); err == nil || !strings.Contains(err.Error(), "coluna cmp_") {
		t.Fatal(err)
	}
	if off[len(off)-1].Name != "cmp_matches" {
		t.Fatal("off removeu cmp_ ao falhar")
	}
	clean := append(jsonx.Object{}, row...)
	if err = stripDueCompare(false, []jsonx.Object{clean}, nil); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(clean, row) {
		t.Fatalf("off limpo mudou colunas: %#v", clean)
	}
}

func TestDueWatchedSourcesStayOnDueBreakdown(t *testing.T) {
	dueSQL, err := os.ReadFile("queries/due.sql")
	if err != nil {
		t.Fatal(err)
	}
	generated, err := os.ReadFile("gen/due.sql.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dueSQL), "as paid_cents") || !strings.Contains(string(generated), "const Due = ") || !strings.Contains(string(generated), "Code generated by sqlc. DO NOT EDIT.") {
		t.Fatal("due.sql ou gen.Due mudou de forma")
	}
	if strings.Contains(string(dueSQL), "cmp_") || strings.Contains(string(generated), "cmp_") {
		t.Fatal("cmp_ entrou na sentença legada")
	}
	for _, path := range []string{"../../finance/core.go", "../../finance/advanced.go"} {
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(text), "leitura.DueBreakdown(") {
			t.Fatalf("%s deixou de chamar DueBreakdown", path)
		}
		if strings.Contains(string(text), "DueHTTP") {
			t.Fatalf("%s passou a chamar DueHTTP", path)
		}
	}
	inert, err := os.ReadFile("../../finance/sql/c59c1801_0.sql")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(inert), "cmp_") || !strings.Contains(string(inert), "as paid_cents") {
		t.Fatal("cópia inerte foi ativada ou editada")
	}
	catalog, err := os.ReadFile("../../finance/financeiro.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(catalog), "dueBreakdown") {
		t.Fatal("financeiro.json perdeu o helper inerte")
	}
}
