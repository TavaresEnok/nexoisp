package csvx

import (
	"encoding/json"
	"fmt"
	"nexoisp/api-go/internal/jsonx"
	"reflect"
	"strings"
)

func Cell(v any) string {
	if v == nil {
		return ""
	}
	var s string
	switch x := v.(type) {
	case string:
		s = x
	case bool:
		s = fmt.Sprint(x)
	case float64:
		s = jsString(x)
	default:
		r := reflect.ValueOf(v)
		if r.Kind() == reflect.Slice {
			parts := []string{}
			for i := 0; i < r.Len(); i++ {
				value := r.Index(i).Interface()
				if value == nil {
					parts = append(parts, "")
				} else {
					parts = append(parts, jsString(value))
				}
			}
			s = strings.Join(parts, "; ")
		} else {
			s = fmt.Sprint(x)
		}
	}
	if strings.ContainsAny(first(s), "=+-@\t\r") {
		s = "'" + s
	}
	return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
}

// JavaScript String(number) uses decimal notation through 1e20; fmt.Sprint
// switches to exponent notation much earlier and changes exported CSV bytes.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == 0 {
			return "0"
		}
		b, _ := jsonx.Encode(x)
		return string(b)
	case map[string]any:
		return "[object Object]"
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			parts[i] = jsString(item)
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(v)
	}
}

func first(s string) string {
	if len(s) > 0 {
		return s[:1]
	}
	return ""
}
func Auto(rows []jsonx.Object) ([]byte, error) {
	cols := []string{}
	seen := map[string]bool{}
	for _, row := range rows {
		for _, f := range row {
			if !strings.HasPrefix(f.Name, "_") && !seen[f.Name] {
				seen[f.Name] = true
				cols = append(cols, f.Name)
			}
		}
	}
	var b strings.Builder
	b.WriteString("\ufeff")
	b.WriteString(strings.Join(cols, ";"))
	b.WriteString("\r\n")
	for _, row := range rows {
		for i, c := range cols {
			if i > 0 {
				b.WriteByte(';')
			}
			v := row.Get(c)
			if v != nil {
				// csv.ts runs after JSON serialization, so all cells first see JSON values.
				raw, e := jsonx.Encode(v)
				if e != nil {
					return nil, e
				}
				if len(raw) > 0 && raw[0] == '{' {
					v = string(raw)
				} else {
					var value any
					if e = json.Unmarshal(raw, &value); e != nil {
						return nil, e
					}
					v = value
				}
				switch v.(type) {
				case jsonx.Time:
					raw, e := jsonx.Encode(v)
					if e != nil {
						return nil, e
					}
					v = strings.Trim(string(raw), "\"")
				default:
					r := reflect.ValueOf(v)
					if r.Kind() == reflect.Map || r.Kind() == reflect.Struct {
						raw, e := jsonx.Encode(v)
						if e != nil {
							return nil, e
						}
						v = string(raw)
					}
				}
			}
			b.WriteString(Cell(v))
		}
		b.WriteString("\r\n")
	}
	return []byte(b.String()), nil
}
