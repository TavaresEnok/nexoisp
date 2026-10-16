package validate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
)

// ParseAgent preserves the established validation message format for agents.
func (r Rule) ParseAgent(value any, present bool) (map[string]any, error) {
	out, e := r.Parse(value, present)
	if e == nil {
		return out, nil
	}
	issues := []jsonx.Object{}
	r.agentIssues(value, present, []any{}, &issues)
	if len(issues) == 0 {
		return nil, e
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	err := encoder.Encode(issues)
	if err != nil {
		return nil, err
	}
	return nil, apierr.New(400, strings.TrimSuffix(buf.String(), "\n"))
}
func (r Rule) agentIssues(v any, present bool, path []any, issues *[]jsonx.Object) {
	add := func(fields jsonx.Object, message string, pathBefore bool) {
		if pathBefore {
			fields = append(fields, jsonx.Field{Name: "path", Value: path}, jsonx.Field{Name: "message", Value: message})
		} else {
			fields = append(fields, jsonx.Field{Name: "message", Value: message}, jsonx.Field{Name: "path", Value: path})
		}
		*issues = append(*issues, fields)
	}
	if !present && r.HasDefault {
		v = r.Default
		present = true
	}
	if !present && r.Optional || present && v == nil && r.Nullable {
		return
	}
	kind := valueType(v, present)
	if kind != r.Kind && !(r.Kind == "enum" && kind == "string") && r.Kind != "any" {
		expected := r.Kind
		if expected == "enum" {
			expected = enumExpected(r.Checks[0].Choices)
		}
		message := "Expected " + expected + ", received " + kind
		if !present {
			message = "Required"
		}
		fields := jsonx.Object{{Name: "code", Value: "invalid_type"}, {Name: "expected", Value: expected}, {Name: "received", Value: kind}}
		if r.Kind == "enum" {
			fields = jsonx.Object{{Name: "expected", Value: expected}, {Name: "received", Value: kind}, {Name: "code", Value: "invalid_type"}}
		}
		add(fields, message, true)
		return
	}
	if r.Kind == "object" {
		values := map[string]any{}
		switch x := v.(type) {
		case map[string]any:
			values = x
		case jsonx.Object:
			for _, f := range x {
				values[f.Name] = f.Value
			}
		}
		for _, f := range r.Fields {
			value, ok := values[f.Name]
			f.Rule.agentIssues(value, ok, append(append([]any{}, path...), f.Name), issues)
		}
	}
	if r.Kind == "array" {
		for i, item := range v.([]any) {
			r.Element.agentIssues(item, true, append(append([]any{}, path...), i), issues)
		}
	}
	for _, c := range r.Checks {
		switch c.Kind {
		case "enum":
			found := false
			for _, choice := range c.Choices {
				if v == choice {
					found = true
				}
			}
			if !found {
				add(jsonx.Object{{Name: "received", Value: v}, {Name: "code", Value: "invalid_enum_value"}, {Name: "options", Value: c.Choices}}, "Invalid enum value. Expected "+enumExpected(c.Choices)+", received '"+v.(string)+"'", true)
			}
		case "trim":
			v = Trim(v.(string))
		case "min", "max":
			var length float64
			switch x := v.(type) {
			case string:
				length = float64(len(utf16.Encode([]rune(x))))
			case []any:
				length = float64(len(x))
			case float64:
				length = x
			}
			if c.Kind == "min" && length >= c.Number || c.Kind == "max" && length <= c.Number {
				continue
			}
			bound, code, limit, number := "minimum", "too_small", "at least", "greater than or equal to"
			if c.Kind == "max" {
				bound, code, limit, number = "maximum", "too_big", "at most", "less than or equal to"
			}
			message := c.Message
			if message == "" {
				switch r.Kind {
				case "string":
					message = fmt.Sprintf("String must contain %s %g character(s)", limit, c.Number)
				case "array":
					message = fmt.Sprintf("Array must contain %s %g element(s)", limit, c.Number)
				default:
					message = fmt.Sprintf("Number must be %s %g", number, c.Number)
				}
			}
			add(jsonx.Object{{Name: "code", Value: code}, {Name: bound, Value: c.Number}, {Name: "type", Value: r.Kind}, {Name: "inclusive", Value: true}, {Name: "exact", Value: false}}, message, false)
		case "integer":
			if v.(float64) != math.Trunc(v.(float64)) {
				add(jsonx.Object{{Name: "code", Value: "invalid_type"}, {Name: "expected", Value: "integer"}, {Name: "received", Value: "float"}}, "Expected integer, received float", true)
			}
		case "uuid", "regex":
			valid := false
			validation := c.Kind
			if c.Kind == "uuid" {
				valid = uuidRE.MatchString(v.(string))
			} else {
				valid = regexp.MustCompile(c.Text).MatchString(v.(string))
			}
			if !valid {
				message := c.Message
				if message == "" {
					message = "Invalid"
				}
				add(jsonx.Object{{Name: "validation", Value: validation}, {Name: "code", Value: "invalid_string"}}, message, false)
			}
		case "refine":
			if !c.Test(v) {
				if c.Message == "Invalid datetime" {
					add(jsonx.Object{{Name: "code", Value: "invalid_string"}, {Name: "validation", Value: "datetime"}}, c.Message, false)
				} else {
					add(jsonx.Object{{Name: "code", Value: "custom"}}, c.Message, false)
				}
			}
		}
	}
}
