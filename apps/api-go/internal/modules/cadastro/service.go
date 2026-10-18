package cadastro

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"

	"github.com/jackc/pgx/v5"
)

//go:embed queries/list.sql
var listFile string

type Service struct{ DB *db.DB }

func (s Service) Subscriber(ctx context.Context, id string) (jsonx.Object, error) {
	var result jsonx.Object
	c := auth.From(ctx)
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		row, err := tx.Queries.Subscriber(ctx, jsonx.UUID(id))
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(404, "assinante não encontrado")
		}
		if err != nil {
			return err
		}
		result = jsonx.FromStruct(row)
		contracts, err := tx.Queries.SubscriberContracts(ctx, jsonx.UUID(id))
		if err != nil {
			return err
		}
		items := []jsonx.Object{}
		for _, k := range contracts {
			items = append(items, jsonx.FromStruct(k))
		}
		result.Set("contracts", items)
		return nil
	})
	return result, err
}
func (s Service) Contract(ctx context.Context, id string) (jsonx.Object, error) {
	var result jsonx.Object
	c := auth.From(ctx)
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		row, err := tx.Queries.Contract(ctx, jsonx.UUID(id))
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(404, "contrato não encontrado")
		}
		if err != nil {
			return err
		}
		result = jsonx.FromStruct(row)
		history, err := tx.Queries.History(ctx, jsonx.UUID(id))
		if err != nil {
			return err
		}
		items := []jsonx.Object{}
		for _, h := range history {
			items = append(items, jsonx.FromStruct(h))
		}
		result.Set("history", items)
		return nil
	})
	return result, err
}
func (s Service) List(ctx context.Context, p validate.Page, csv bool) ([]jsonx.Object, int64, error) {
	var result []jsonx.Object
	var total int64
	cap := 500
	if csv {
		cap = 5000
	}
	limit := cap
	if p.HasLimit {
		limit = min(p.Limit, cap)
	}
	sql := strings.TrimSuffix(strings.TrimSpace(strings.SplitN(listFile, "\n", 2)[1]), ";")
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, p.Q)
	var q, status any
	if p.Q != "" {
		q = p.Q
	}
	if p.Status != "" {
		status = p.Status
	}
	params := []any{q, digits, status}
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		var err error
		result, err = tx.Objects(ctx, fmt.Sprintf("select x.* from (%s) x limit %d offset %s", sql, limit, strconv.FormatFloat(p.Offset, 'f', -1, 64)), params...)
		if err != nil {
			return err
		}
		if p.Offset == 0 && len(result) < limit {
			total = int64(len(result))
			return nil
		}
		return tx.QueryRow(ctx, "select count(*) as n from ("+sql+") x", params...).Scan(&total)
	})
	return result, total, err
}
