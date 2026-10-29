package cloudjournal

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCsSchemaClassify(t *testing.T) {
	if MaxLockRequeues != 3 {
		t.Fatalf("MaxLockRequeues=%d", MaxLockRequeues)
	}
	cases := []struct {
		invoice, maintenance string
		want                 LogKind
	}{
		{invoice: "inv-1", maintenance: "", want: LogKindBilling},
		{invoice: "inv-1", maintenance: "mnt-1", want: LogKindBilling},
		{invoice: " ", maintenance: "", want: LogKindBilling},
		{invoice: "", maintenance: "mnt-1", want: LogKindMaintenance},
		{invoice: "", maintenance: "", want: LogKindOther},
	}
	for _, tc := range cases {
		if got := Classify(tc.invoice, tc.maintenance); got != tc.want {
			t.Fatalf("Classify(%q,%q)=%s, want %s", tc.invoice, tc.maintenance, got, tc.want)
		}
	}
	if DecisionSend != "send" || DecisionOptOut != "opt_out" || DecisionSettled != "settled" || DecisionLockTimeout != "lock_timeout" || DecisionIneligible != "ineligible" {
		t.Fatal("Decision divergiu do desenho")
	}
	if LogKindBilling != "billing" || LogKindMaintenance != "maintenance" || LogKindOther != "other" {
		t.Fatal("LogKind divergiu do desenho")
	}
	var effect StatusEffect
	if effect.MoneyWrites != 0 || effect.Sends != 0 || effect.Applied || effect.Duplicate {
		t.Fatal("StatusEffect zero não é neutro")
	}
	var _ Sender = csSchemaSender{}
	var _ Authenticator = csSchemaAuth{}
}

func TestCsSchemaTypesFileOwnsOnlyFoundation(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("origem do teste indisponível")
	}
	path := filepath.Join(filepath.Dir(file), "types.go")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, path, src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Imports) != 1 || parsed.Imports[0].Path.Value != `"context"` {
		t.Fatalf("imports de types.go: %v", importPaths(parsed))
	}
	funcs := map[string]bool{}
	types := map[string]bool{}
	for _, decl := range parsed.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			funcs[d.Name.Name] = true
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				if ts, ok := spec.(*ast.TypeSpec); ok {
					types[ts.Name.Name] = true
				}
			}
		}
	}
	if len(funcs) != 1 || !funcs["Classify"] {
		t.Fatalf("funções: %v", funcs)
	}
	wantTypes := []string{"Decision", "LogKind", "Sender", "Authenticator", "StatusEffect"}
	if len(types) != len(wantTypes) {
		t.Fatalf("tipos: %v", types)
	}
	for _, name := range wantTypes {
		if !types[name] {
			t.Fatalf("tipo ausente %s em %v", name, types)
		}
	}
	for _, banned := range []string{"Revalidate", "MarkWire", "ConsentBilling", "ConsentMaintenance", "AcceptStatus", "RecordResult", "SweepReserved", "cloudapi", "internal/db", "Unproved"} {
		if strings.Contains(string(src), banned) {
			t.Fatalf("types.go declara símbolo de outra raiz: %s", banned)
		}
	}
}

type csSchemaSender struct{}

func (csSchemaSender) Send(context.Context, string) (bool, error) { return false, nil }

type csSchemaAuth struct{}

func (csSchemaAuth) Proven() bool { return false }

func (csSchemaAuth) Verify(map[string]string, []byte) error { return nil }

func importPaths(f *ast.File) []string {
	out := make([]string, 0, len(f.Imports))
	for _, imp := range f.Imports {
		out = append(out, imp.Path.Value)
	}
	return out
}
