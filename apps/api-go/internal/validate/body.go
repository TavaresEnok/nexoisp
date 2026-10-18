package validate

import (
	"fmt"
	"math"
	"nexoisp/api-go/internal/jsonx"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"nexoisp/api-go/internal/apierr"
)

// Rule is the native validation contract of a JSON field. Checks retain declaration order.
type Rule struct {
	Alternatives       []Rule
	LiteralValue       any
	LiteralEmpty       bool
	Kind               string
	Optional, Nullable bool
	HasDefault         bool
	Default            any
	Fields             []Field
	Element            *Rule
	Checks             []Check
	Transform          func(any) any
	TransformMissing   bool
}
type Field struct {
	Name string
	Rule Rule
}
type Check struct {
	Apply   func(any) any
	Test    func(any) bool
	Kind    string
	Number  float64
	Text    string
	Choices []string
	Message string
}

func Any() Rule                       { return Rule{Kind: "any"} }
func Record(element Rule) Rule        { return Rule{Kind: "record", Element: &element} }
func Union(alternatives ...Rule) Rule { return Rule{Kind: "union", Alternatives: alternatives} }
func String() Rule                    { return Rule{Kind: "string"} }
func Number() Rule                    { return Rule{Kind: "number"} }
func Boolean() Rule                   { return Rule{Kind: "boolean"} }
func Object(fields ...Field) Rule     { return Rule{Kind: "object", Fields: fields} }
func Array(element Rule) Rule         { return Rule{Kind: "array", Element: &element} }
func F(name string, rule Rule) Field  { return Field{Name: name, Rule: rule} }
func (r Rule) Opt() Rule              { r.Optional = true; r.HasDefault = false; return r }
func (r Rule) Null() Rule             { r.Nullable = true; return r }
func (r Rule) Nullish() Rule          { r.Optional = true; r.Nullable = true; r.HasDefault = false; return r }
func (r Rule) Def(value any) Rule     { r.HasDefault = true; r.Default = value; return r }
func (r Rule) Trimmed() Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "trim"})
	return r
}
func (r Rule) Upper() Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "upper"})
	return r
}
func (r Rule) Min(value float64, message ...string) Rule { return r.checkNumber("min", value, message) }
func (r Rule) Max(value float64, message ...string) Rule { return r.checkNumber("max", value, message) }
func (r Rule) Length(n float64) Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "length", Number: n})
	return r
}
func (r Rule) Positive() Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "positive"})
	return r
}
func (r Rule) Int() Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "integer"})
	return r
}
func (r Rule) checkNumber(kind string, value float64, messages []string) Rule {
	c := Check{Kind: kind, Number: value}
	if len(messages) > 0 {
		c.Message = messages[0]
	}
	r.Checks = append(append([]Check{}, r.Checks...), c)
	return r
}
func (r Rule) Pattern(pattern, message string) Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "regex", Text: pattern, Message: message})
	return r
}
func (r Rule) UUID() Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "uuid", Message: "Invalid uuid"})
	return r
}
func LiteralMessage(value any, message string) Rule {
	return Rule{Kind: "literal", LiteralValue: value, Checks: []Check{{Message: message}}}
}
func Literal(value any) Rule { return Rule{Kind: "literal", LiteralValue: value} }
func Enum(values ...string) Rule {
	return Rule{Kind: "enum", Checks: []Check{{Kind: "enum", Choices: values}}}
}
func (r Rule) Then(transform func(any) any, missing bool) Rule {
	r.Transform = transform
	r.TransformMissing = missing
	return r
}
func (r Rule) OrEmpty() Rule { r.LiteralEmpty = true; return r }
func (r Rule) Apply(transform func(any) any) Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "apply", Apply: transform})
	return r
}
func (r Rule) Refine(test func(any) bool, message string) Rule {
	r.Checks = append(append([]Check{}, r.Checks...), Check{Kind: "refine", Test: test, Message: message})
	return r
}
func (r Rule) Parse(value any, present bool) (map[string]any, error) {
	issues := []string{}
	out, _ := r.parse(value, present, "", &issues)
	if len(issues) > 0 {
		return nil, apierr.New(400, strings.Join(issues, "; "))
	}
	result, _ := out.(map[string]any)
	return result, nil
}
func valueType(v any, present bool) string {
	if !present {
		return "undefined"
	}
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	default:
		return "object"
	}
}
func (r Rule) parse(value any, present bool, path string, issues *[]string) (any, bool) {
	issue := func(message string) {
		label := path
		if label == "" {
			label = "dados"
		}
		*issues = append(*issues, label+": "+message)
	}
	if !present && r.HasDefault {
		value = r.Default
		present = true
	}
	if !present && r.Optional {
		if r.TransformMissing && r.Transform != nil {
			return r.Transform(nil), true
		}
		return nil, false
	}
	if present && value == nil && r.Nullable {
		if r.Transform != nil {
			return r.Transform(nil), true
		}
		return nil, true
	}
	if r.Kind == "literal" {
		if value != r.LiteralValue {
			if len(r.Checks) > 0 {
				issue(r.Checks[0].Message)
			} else {
				issue(fmt.Sprintf("Invalid literal value, expected %v", r.LiteralValue))
			}
		}
		return value, present
	}
	if r.Kind == "any" {
		return value, present
	}
	if r.Kind == "union" {
		var dirty []string
		for _, alternative := range r.Alternatives {
			local := []string{}
			out, keep := alternative.parse(value, present, path, &local)
			if len(local) == 0 {
				return out, keep
			}
			if dirty == nil && alternative.Kind == valueType(value, present) {
				dirty = local
			}
		}
		if dirty != nil {
			*issues = append(*issues, dirty...)
		} else {
			issue("Invalid input")
		}
		return nil, present
	}
	kind := valueType(value, present)
	if kind != r.Kind && !(r.Kind == "enum" && kind == "string") && !(r.Kind == "record" && kind == "object") {
		expected := r.Kind
		if expected == "enum" {
			expected = enumExpected(r.Checks[0].Choices)
		}
		if !present {
			issue("Required")
		} else {
			issue("Expected " + expected + ", received " + kind)
		}
		return nil, present
	}
	if r.LiteralEmpty && value == "" {
		if r.Transform != nil {
			return r.Transform(value), true
		}
		return value, true
	}
	before := len(*issues)
	switch r.Kind {
	case "object":
		out := map[string]any{}
		obj := map[string]any{}
		switch v := value.(type) {
		case map[string]any:
			obj = v
		case jsonx.Object:
			for _, field := range v {
				obj[field.Name] = field.Value
			}
		}
		for _, f := range r.Fields {
			v, ok := obj[f.Name]
			p := f.Name
			if path != "" {
				p = path + "." + p
			}
			x, keep := f.Rule.parse(v, ok, p, issues)
			if keep {
				out[f.Name] = x
			}
		}
		value = out
	case "record":
		entries := jsonx.Object{}
		switch v := value.(type) {
		case jsonx.Object:
			entries = v
		case map[string]any:
			keys := []string{}
			for k := range v {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				entries = append(entries, jsonx.Field{Name: k, Value: v[k]})
			}
		}
		out := jsonx.Object{}
		for _, entry := range entries {
			p := entry.Name
			if path != "" {
				p = path + "." + p
			}
			item, keep := r.Element.parse(entry.Value, true, p, issues)
			if keep && entry.Name != "__proto__" {
				out.Set(entry.Name, item)
			}
		}
		value = out
	case "array":
		list := value.([]any)
		out := make([]any, len(list))
		for i, v := range list {
			p := fmt.Sprint(i)
			if path != "" {
				p = path + "." + p
			}
			out[i], _ = r.Element.parse(v, true, p, issues)
		}
		value = out
	}
	for _, c := range r.Checks {
		message := c.Message
		switch c.Kind {
		case "apply":
			value = c.Apply(value)
		case "refine":
			if !c.Test(value) {
				issue(c.Message)
			}
		case "trim":
			value = Trim(value.(string))
		case "upper":
			value = strings.ToUpper(value.(string))
		case "length":
			if float64(len(utf16.Encode([]rune(value.(string))))) != c.Number {
				issue(fmt.Sprintf("String must contain exactly %g character(s)", c.Number))
			}
		case "integer":
			if value.(float64) != math.Trunc(value.(float64)) {
				issue("Expected integer, received float")
			}
		case "positive":
			if value.(float64) <= 0 {
				issue("Number must be greater than 0")
			}
		case "min", "max":
			var n float64
			switch x := value.(type) {
			case string:
				n = float64(len(utf16.Encode([]rune(x))))
			case float64:
				n = x
			case []any:
				n = float64(len(x))
			}
			bad := c.Kind == "min" && n < c.Number || c.Kind == "max" && n > c.Number
			if !bad {
				continue
			}
			if message == "" {
				limit := "at least"
				bound := "greater than or equal to"
				if c.Kind == "max" {
					limit = "at most"
					bound = "less than or equal to"
				}
				switch r.Kind {
				case "string":
					message = fmt.Sprintf("String must contain %s %g character(s)", limit, c.Number)
				case "array":
					message = fmt.Sprintf("Array must contain %s %g element(s)", limit, c.Number)
				default:
					message = fmt.Sprintf("Number must be %s %g", bound, c.Number)
				}
			}
			issue(message)
		case "regex":
			if !regexp.MustCompile(c.Text).MatchString(value.(string)) {
				if message == "" {
					message = "Invalid"
				}
				issue(message)
			}
		case "uuid":
			if !uuidRE.MatchString(value.(string)) {
				issue(c.Message)
			}
		case "enum":
			found := false
			for _, choice := range c.Choices {
				if value == choice {
					found = true
					break
				}
			}
			if !found {
				issue("Invalid enum value. Expected " + enumExpected(c.Choices) + ", received '" + value.(string) + "'")
			}
		}
	}
	if len(*issues) == before && r.Transform != nil {
		value = r.Transform(value)
	}
	return value, true
}
func enumExpected(choices []string) string { return "'" + strings.Join(choices, "' | '") + "'" }
