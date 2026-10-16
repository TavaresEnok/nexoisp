package validate

import (
	"encoding/json"
	"nexoisp/api-go/internal/apierr"
	"os"
	"testing"
	"time"
)

func TestAgentZodErrorCompatibility(t *testing.T) {
	raw, e := os.ReadFile("testdata/agent-errors.json")
	if e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Schema string
		Input  any
		Error  string
	}
	if e = json.Unmarshal(raw, &cases); e != nil {
		t.Fatal(e)
	}
	for _, test := range cases {
		var rule Rule
		switch test.Schema {
		case "hello":
			rule = Object(F("session_id", String().Min(8).Max(80)), F("version", String().Max(40)), F("info", Record(Any()).Opt()))
		case "progress":
			rule = Object(F("status", Enum("EXECUTING", "VERIFYING")), F("steps", Array(Any()).Max(100)))
		case "observations":
			rule = Object(F("items", Array(Object(F("resource_id", String().UUID()), F("at", String().Refine(func(v any) bool { _, e := time.Parse(time.RFC3339Nano, v.(string)); return e == nil }, "Invalid datetime"))))))
		}
		_, e = rule.ParseAgent(test.Input, true)
		if e == nil || apierr.Map(e).Message != test.Error {
			t.Fatalf("%s: esperado %s; obtido %v", test.Schema, test.Error, e)
		}
	}
}
