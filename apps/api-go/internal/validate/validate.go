package validate

import (
	"fmt"
	"math"
	"net/url"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/fault"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

var uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func UUID(v string) error {
	if !uuidRE.MatchString(v) {
		if fault.Active("zod_mensagem") {
			return apierr.New(400, "uuid inválido")
		}
		return apierr.New(400, "dados: Invalid uuid")
	}
	return nil
}

type Page struct {
	Q, Status string
	Limit     int
	Offset    float64
	HasLimit  bool
}

func Trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func Parse(q url.Values) (Page, error) {
	p := Page{}
	issues := []string{}
	if v, ok := q["q"]; ok {
		if len(v) != 1 {
			issues = append(issues, "q: Expected string, received array")
		} else {
			p.Q = Trim(v[0])
			if len(utf16.Encode([]rune(p.Q))) > 100 {
				issues = append(issues, "q: String must contain at most 100 character(s)")
			}
		}
	}
	if v, ok := q["status"]; ok {
		if len(v) != 1 {
			issues = append(issues, "status: Expected 'active' | 'inactive', received array")
		} else {
			p.Status = v[0]
			if p.Status != "active" && p.Status != "inactive" {
				issues = append(issues, fmt.Sprintf("status: Invalid enum value. Expected 'active' | 'inactive', received '%s'", p.Status))
			}
		}
	}
	for _, name := range []string{"limit", "offset"} {
		values, ok := q[name]
		if !ok {
			continue
		}
		v := strings.Join(values, ",")
		n := number(v)
		min := float64(0)
		if name == "limit" {
			min = 1
			p.HasLimit = true
		}
		if math.IsNaN(n) {
			issues = append(issues, name+": Expected number, received nan")
			continue
		}
		if math.IsInf(n, 0) || n != math.Trunc(n) {
			issues = append(issues, name+": Expected integer, received float")
		}
		if n < min {
			issues = append(issues, fmt.Sprintf("%s: Number must be greater than or equal to %.0f", name, min))
		}
		if name == "limit" && n > 5000 {
			issues = append(issues, "limit: Number must be less than or equal to 5000")
		}
		if n >= 0 {
			if name == "limit" {
				p.Limit = int(n)
			} else {
				p.Offset = n
			}
		}
	}
	if len(issues) > 0 {
		return p, apierr.New(400, strings.Join(issues, "; "))
	}
	return p, nil
}
func number(s string) float64 {
	s = Trim(s)
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' {
		base := 0
		switch s[1] {
		case 'x', 'X':
			base = 16
		case 'b', 'B':
			base = 2
		case 'o', 'O':
			base = 8
		}
		if base != 0 {
			v, e := strconv.ParseUint(s[2:], base, 64)
			if e == nil {
				return float64(v)
			}
			return math.NaN()
		}
	}
	if strings.Contains(s, "_") {
		return math.NaN()
	}
	if s == "Infinity" || s == "+Infinity" {
		return math.Inf(1)
	}
	if s == "-Infinity" {
		return math.Inf(-1)
	}
	if !regexp.MustCompile(`^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$`).MatchString(s) {
		return math.NaN()
	}
	v, e := strconv.ParseFloat(s, 64)
	if e != nil && !math.IsInf(v, 0) {
		return math.NaN()
	}
	return v
}
