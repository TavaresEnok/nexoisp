// Package jsonx preserves node-postgres/JSON.stringify wire conventions.
package jsonx

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"strings"
	"time"

	"nexoisp/api-go/internal/fault"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

type UUID string

func (u *UUID) ScanUUID(v pgtype.UUID) error {
	if v.Valid {
		*u = UUID(uuid.UUID(v.Bytes).String())
	}
	return nil
}
func (u UUID) UUIDValue() (pgtype.UUID, error) {
	v, e := uuid.Parse(string(u))
	return pgtype.UUID{Bytes: v, Valid: e == nil}, e
}

type Time struct{ time.Time }

func (t Time) MarshalJSON() ([]byte, error) {
	if t.IsZero() {
		return []byte("null"), nil
	}
	if fault.Active("data_sem_ms") {
		return json.Marshal(t.UTC().Format("2006-01-02T15:04:05Z"))
	}
	return json.Marshal(t.UTC().Format("2006-01-02T15:04:05.000Z"))
}
func (t *Time) ScanTimestamptz(v pgtype.Timestamptz) error { t.Time = v.Time; return nil }
func (t *Time) ScanTimestamp(v pgtype.Timestamp) error     { t.Time = v.Time; return nil }

type Date string

func (d *Date) ScanDate(v pgtype.Date) error {
	if v.Valid {
		*d = Date(v.Time.Format("2006-01-02"))
	}
	return nil
}

type NumericText string

func (n *NumericText) ScanNumeric(v pgtype.Numeric) error {
	if !v.Valid {
		return nil
	}
	s, e := v.Value()
	if e == nil {
		*n = NumericText(fmt.Sprint(s))
	}
	return e
}

type Field struct {
	Name  string
	Value any
}
type Object []Field

func (o Object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	written := 0
	for _, f := range o {
		if fault.Active("omitempty") && f.Value == nil {
			continue
		}
		if written > 0 {
			b.WriteByte(',')
		}
		name, _ := Encode(f.Name)
		value, e := Encode(f.Value)
		if e != nil {
			return nil, e
		}
		b.Write(name)
		b.WriteByte(':')
		b.Write(value)
		written++
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
func (o Object) Get(name string) any {
	for _, f := range o {
		if f.Name == name {
			return f.Value
		}
	}
	return nil
}
func (o *Object) Set(name string, v any) {
	for i := range *o {
		if (*o)[i].Name == name {
			(*o)[i].Value = v
			return
		}
	}
	*o = append(*o, Field{name, v})
}
func Encode(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return lineSeparators(bytes.TrimSuffix(b.Bytes(), []byte{'\n'})), nil
}

// JSON.stringify keeps these Unicode characters literal, including inside CSV cells.
func lineSeparators(b []byte) []byte {
	if !bytes.Contains(b, []byte(`\u202`)) {
		return b
	}
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); {
		if b[i] == '\\' && i+1 < len(b) {
			if b[i+1] == '\\' {
				out = append(out, b[i:i+2]...)
				i += 2
				continue
			}
			if i+6 <= len(b) && (string(b[i:i+6]) == `\u2028` || string(b[i:i+6]) == `\u2029`) {
				if b[i+5] == '8' {
					out = append(out, []byte("\u2028")...)
				} else {
					out = append(out, []byte("\u2029")...)
				}
				i += 6
				continue
			}
		}
		out = append(out, b[i])
		i++
	}
	return out
}

// JSON decodes PostgreSQL JSON in member order, using JavaScript's Number precision.
func JSON(raw []byte) any {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	value, err := ordered(decoder)
	if err != nil {
		return json.RawMessage(raw)
	}
	return value
}
func ordered(d *json.Decoder) (any, error) {
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			o := Object{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return nil, err
				}
				v, err := ordered(d)
				if err != nil {
					return nil, err
				}
				o.Set(k.(string), v)
			}
			_, err = d.Token()
			return o, err
		case '[':
			a := []any{}
			for d.More() {
				v, err := ordered(d)
				if err != nil {
					return nil, err
				}
				a = append(a, v)
			}
			_, err = d.Token()
			return a, err
		}
	}
	return token, nil
}

func Marshal(w io.Writer, v any) error {
	b, err := Encode(v)
	if err != nil {
		return err
	}
	_, err = w.Write(b)
	return err
}

// FromStruct keeps sqlc's column order, including explicit nulls.
func FromStruct(v any) Object {
	r := reflect.ValueOf(v)
	t := r.Type()
	o := Object{}
	for i := 0; i < r.NumField(); i++ {
		name := strings.Split(t.Field(i).Tag.Get("json"), ",")[0]
		if name == "" {
			name = t.Field(i).Name
		}
		o = append(o, Field{name, Normalize(r.Field(i).Interface(), 0)})
	}
	return o
}

func Normalize(v any, oid uint32) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		if x == nil {
			return nil
		}
		return JSON(x)
	case time.Time:
		if oid == 1082 {
			return x.Format("2006-01-02")
		}
		return Time{x}
	case pgtype.Date:
		if !x.Valid {
			return nil
		}
		return x.Time.Format("2006-01-02")
	case pgtype.Timestamp:
		if !x.Valid {
			return nil
		}
		return Time{x.Time}
	case pgtype.Timestamptz:
		if !x.Valid {
			return nil
		}
		return Time{x.Time}
	case pgtype.Text:
		if !x.Valid {
			return nil
		}
		return x.String
	case pgtype.Int8:
		if !x.Valid {
			return nil
		}
		return float64(x.Int64)
	case pgtype.Int4:
		if !x.Valid {
			return nil
		}
		return x.Int32
	case pgtype.Bool:
		if !x.Valid {
			return nil
		}
		return x.Bool
	case pgtype.UUID:
		if !x.Valid {
			return nil
		}
		return uuid.UUID(x.Bytes).String()
	case [16]byte:
		return uuid.UUID(x).String()
	case pgtype.Numeric:
		if !x.Valid {
			return nil
		}
		if fault.Active("numeric_numero") {
			v, _ := x.Float64Value()
			return v.Float64
		}
		s, e := x.Value()
		if e != nil {
			return nil
		}
		return s
	case int64:
		return float64(x) // node-postgres parser: Number(int8).
	case float64:
		if math.IsInf(x, 0) || math.IsNaN(x) {
			return nil
		}
		return x
	}
	return v
}
