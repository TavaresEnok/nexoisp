package apierr

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestFrameworkGolden(t *testing.T) {
	b, err := os.ReadFile("../../../../tests/contrato/corpus/framework.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus []struct {
		Name   string
		Status int
		Body   struct{ Error string }
	}
	if err = json.Unmarshal(b, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, c := range corpus {
		t.Run(c.Name, func(t *testing.T) {
			body := "{"
			media := "application/json"
			switch c.Name {
			case "empty":
				body = ""
			case "unsupported":
				body = "<x/>"
				media = "application/xml"
			case "too_large":
				body = strings.Repeat("x", BodyLimit+1)
			}
			r := httptest.NewRequest("POST", "/", strings.NewReader(body))
			r.Header.Set("Content-Type", media)
			var value any
			e := Map(DecodeJSON(r, &value))
			if e.Status != c.Status || e.Message != c.Body.Error {
				t.Fatalf("%+v", e)
			}
		})
	}
}
