package leitura

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
)

const financeMaxSafeInteger int64 = 9007199254740991

func financeRepresentationError() error {
	return &apierr.Error{Status: 422, Code: "finance_aggregate_out_of_range", Message: "agregado financeiro fora do intervalo de representação exata"}
}

// These two readers bypass Objects' global int8 -> float64 convention. PostgreSQL
// serializes the integer first; UseNumber validates it before any JS conversion.
// The wrapper preserves the selected SQL (including the closed B04 gates), RLS,
// parameters and column order. Neither query has nested/non-scalar projections.
type financeRowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func financeReadRows(ctx context.Context, tx financeRowQuerier, query string, args ...any) ([]jsonx.Object, error) {
	query = strings.TrimSuffix(strings.TrimSpace(query), ";")
	var raw string
	err := tx.QueryRow(ctx, "select coalesce(json_agg(finance_row), '[]'::json)::text from ("+query+"\n) finance_row", args...).Scan(&raw)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "22003" {
			return nil, financeRepresentationError()
		}
		return nil, err
	}
	return financeDecodeRows(raw)
}

func financeDecodeRows(raw string) ([]jsonx.Object, error) {
	d := json.NewDecoder(strings.NewReader(raw))
	d.UseNumber()
	if token, err := d.Token(); err != nil || token != json.Delim('[') {
		return nil, financeRepresentationError()
	}
	rows := []jsonx.Object{}
	for d.More() {
		if token, err := d.Token(); err != nil || token != json.Delim('{') {
			return nil, financeRepresentationError()
		}
		row := jsonx.Object{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, financeRepresentationError()
			}
			name, ok := key.(string)
			if !ok {
				return nil, financeRepresentationError()
			}
			value, err := d.Token()
			if err != nil {
				return nil, financeRepresentationError()
			}
			if number, ok := value.(json.Number); ok {
				n, err := number.Int64()
				if err != nil || n < -financeMaxSafeInteger || n > financeMaxSafeInteger {
					return nil, financeRepresentationError()
				}
				value = n
			}
			if _, nested := value.(json.Delim); nested {
				return nil, financeRepresentationError()
			}
			row.Set(name, value)
		}
		if token, err := d.Token(); err != nil || token != json.Delim('}') {
			return nil, financeRepresentationError()
		}
		rows = append(rows, row)
	}
	if token, err := d.Token(); err != nil || token != json.Delim(']') {
		return nil, financeRepresentationError()
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, financeRepresentationError()
	}
	return rows, nil
}

func (s Service) financeSummaryRows(ctx context.Context, legacy string, args ...any) ([]jsonx.Object, error) {
	selection, err := Pick(balanceReaderFinanceSummary, legacy)
	if err != nil {
		return nil, err
	}
	var rows []jsonx.Object
	err = s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		var err error
		rows, err = financeReadRows(ctx, tx, selection.SQL, args...)
		if err != nil {
			return err
		}
		return Strip(selection, rows)
	})
	return rows, err
}
