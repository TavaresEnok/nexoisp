package validate

import (
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"nexoisp/api-go/internal/apierr"
)

// Query accumulates issues in schema order, matching the original Zod object.
type Query struct {
	Values url.Values
	Issues []string
}

func (q *Query) String(name string, trim bool, required bool) string {
	values, exists := q.Values[name]
	if !exists {
		if required {
			q.Issues = append(q.Issues, name+": Required")
		}
		return ""
	}
	if len(values) != 1 {
		q.Issues = append(q.Issues, name+": Expected string, received array")
		return ""
	}
	value := values[0]
	if trim {
		value = Trim(value)
	}
	return value
}
func (q *Query) UUID(name string, required bool) string {
	before := len(q.Issues)
	v := q.String(name, false, required)
	if len(q.Issues) == before {
		if _, present := q.Values[name]; present && !uuidRE.MatchString(v) {
			q.Issues = append(q.Issues, name+": Invalid uuid")
		}
	}
	return v
}
func (q *Query) Enum(name, fallback string, options ...string) string {
	values, present := q.Values[name]
	if !present {
		return fallback
	}
	quoted := make([]string, len(options))
	for i, v := range options {
		quoted[i] = "'" + v + "'"
	}
	expected := strings.Join(quoted, " | ")
	if len(values) != 1 {
		q.Issues = append(q.Issues, fmt.Sprintf("%s: Expected %s, received array", name, expected))
		return ""
	}
	v := values[0]
	for _, allowed := range options {
		if v == allowed {
			return v
		}
	}
	q.Issues = append(q.Issues, fmt.Sprintf("%s: Invalid enum value. Expected %s, received '%s'", name, expected, v))
	return v
}
func (q *Query) Page() Page {
	values := url.Values{}
	for _, name := range []string{"limit", "offset"} {
		if v, ok := q.Values[name]; ok {
			values[name] = v
		}
	}
	p, err := Parse(values)
	if err != nil {
		q.Issues = append(q.Issues, apierr.Map(err).Message)
	}
	return p
}
func (q *Query) Err() error {
	if len(q.Issues) > 0 {
		return apierr.New(400, strings.Join(q.Issues, "; "))
	}
	return nil
}

func (q *Query) BoundedString(name string, trim bool, min, max int) string {
	return q.Text(name, false, trim, min, max)
}
func (q *Query) Text(name string, required, trim bool, min, max int) string {
	before := len(q.Issues)
	v := q.String(name, trim, required)
	if _, ok := q.Values[name]; ok && len(q.Issues) == before {
		n := len(utf16.Encode([]rune(v)))
		if min > 0 && n < min {
			q.Issues = append(q.Issues, fmt.Sprintf("%s: String must contain at least %d character(s)", name, min))
		}
		if max >= 0 && n > max {
			q.Issues = append(q.Issues, fmt.Sprintf("%s: String must contain at most %d character(s)", name, max))
		}
	}
	return v
}
func (q *Query) Integer(name string, fallback, min, max int) int {
	values, ok := q.Values[name]
	if !ok {
		return fallback
	}
	n := number(strings.Join(values, ","))
	if math.IsNaN(n) {
		q.Issues = append(q.Issues, name+": Expected number, received nan")
		return 0
	}
	if math.IsInf(n, 0) || n != math.Trunc(n) {
		q.Issues = append(q.Issues, name+": Expected integer, received float")
	}
	if n < float64(min) {
		q.Issues = append(q.Issues, fmt.Sprintf("%s: Number must be greater than or equal to %d", name, min))
	}
	if n > float64(max) {
		q.Issues = append(q.Issues, fmt.Sprintf("%s: Number must be less than or equal to %d", name, max))
	}
	if n < float64(min) || n > float64(max) || math.IsInf(n, 0) {
		return fallback
	}
	return int(n)
}

func (q *Query) Date(name string, required bool, message string) string {
	before := len(q.Issues)
	value := q.String(name, false, required)
	if _, present := q.Values[name]; present && len(q.Issues) == before && !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(value) {
		q.Issues = append(q.Issues, name+": "+message)
	}
	return value
}
func (q *Query) Number(name string, fallback *float64, min, max float64, integer bool) float64 {
	values, present := q.Values[name]
	if !present && fallback != nil {
		return *fallback
	}
	value := math.NaN()
	if present {
		value = number(strings.Join(values, ","))
	}
	if math.IsNaN(value) {
		q.Issues = append(q.Issues, name+": Expected number, received nan")
		return 0
	}
	if integer && (math.IsInf(value, 0) || value != math.Trunc(value)) {
		q.Issues = append(q.Issues, name+": Expected integer, received float")
	}
	if value < min {
		q.Issues = append(q.Issues, fmt.Sprintf("%s: Number must be greater than or equal to %s", name, strconv.FormatFloat(min, 'f', -1, 64)))
	}
	if value > max {
		q.Issues = append(q.Issues, fmt.Sprintf("%s: Number must be less than or equal to %s", name, strconv.FormatFloat(max, 'f', -1, 64)))
	}
	return value
}

// JSNumber implements the Number(string) coercion accepted by existing settings.
func JSNumber(value string) float64 { return number(value) }
