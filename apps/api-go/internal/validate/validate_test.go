package validate

import (
	"encoding/json"
	"net/url"
	"os"
	"testing"
)

func TestZodGolden(t *testing.T) {
	b, err := os.ReadFile("../../../../tests/contrato/corpus/zod/query.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Validators []struct {
			Input map[string]any
			OK    bool
			Value map[string]any
			Error string
		}
		UUID []struct {
			Input string
			OK    bool
		}
	}
	if err = json.Unmarshal(b, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, c := range corpus.Validators {
		q := url.Values{}
		for k, v := range c.Input {
			switch x := v.(type) {
			case string:
				q.Set(k, x)
			case []any:
				for _, y := range x {
					q.Add(k, y.(string))
				}
			}
		}
		_, err := Parse(q)
		if c.OK != (err == nil) {
			t.Errorf("%v: esperado ok=%v, erro=%v", q, c.OK, err)
		}
		if err != nil && err.Error() != c.Error {
			t.Errorf("%v: esperado %q, obtido %q", q, c.Error, err.Error())
		}
	}
	for _, c := range corpus.UUID {
		if err := UUID(c.Input); c.OK != (err == nil) {
			t.Errorf("uuid %q: %v", c.Input, err)
		}
	}
	// A mensagem de UUID solto também precisa manter o caminho vazio do Zod.
	if err := UUID("invalido"); err == nil || err.Error() != "dados: Invalid uuid" {
		t.Fatal(err)
	}
}
