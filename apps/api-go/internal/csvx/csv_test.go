package csvx

import (
	"nexoisp/api-go/internal/jsonx"
	"testing"
)

func TestCSVUsesJavaScriptNumberStrings(t *testing.T) {
	// Captured from autoCsv(JSON.parse(JSON.stringify(rows))) in csv.ts.
	rows := []jsonx.Object{{{Name: "n", Value: float64(1000000)}}, {{Name: "n", Value: float64(1e20)}}, {{Name: "n", Value: float64(1e21)}}, {{Name: "n", Value: float64(1e-7)}}}
	got, err := Auto(rows)
	if err != nil {
		t.Fatal(err)
	}
	want := "\ufeffn\r\n\"1000000\"\r\n\"100000000000000000000\"\r\n\"1e+21\"\r\n\"1e-7\"\r\n"
	if string(got) != want {
		t.Fatalf("CSV number contract: %q", got)
	}
}
