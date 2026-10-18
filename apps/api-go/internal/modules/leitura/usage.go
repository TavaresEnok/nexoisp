package leitura

import (
	"context"
	"fmt"
	"net/http"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
	"nexoisp/api-go/internal/validate"

	"github.com/go-chi/chi/v5"
)

const usageHourly = `select to_char(u.hour at time zone coalesce(ts.timezone, 'America/Sao_Paulo'), 'YYYY-MM-DD"T"HH24:00') as period,
            sum(u.bytes_in)::float as bytes_in, sum(u.bytes_out)::float as bytes_out
     from usage_hourly u join service_resources r on r.id = u.resource_id left join tenant_settings ts on ts.tenant_id = u.tenant_id
     where r.contract_id = $1 group by 1 order by 1 desc`
const usageDaily = `select to_char(date_trunc('%s', u.day::timestamp)::date, 'YYYY-MM-DD') as period, sum(u.bytes_in)::float as bytes_in, sum(u.bytes_out)::float as bytes_out
     from usage_daily u join service_resources r on r.id = u.resource_id
     where r.contract_id = $1 and u.day >= (current_date - %s)::date
     group by 1 order by 1 desc`

func (s Service) usage(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	q := validate.Query{Values: r.URL.Query()}
	id := q.UUID("contract_id", true)
	by := q.Enum("by", "day", "hour", "day", "week", "year")
	if err := q.Err(); err != nil {
		return endpoint.Result{}, err
	}
	var rows []jsonx.Object
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		own, err := tx.Objects(ctx, gen.UsageCheck0, id, null(auth.From(ctx).SubscriberID))
		if err != nil {
			return err
		}
		if len(own) == 0 {
			return apierr.New(404, "contrato não encontrado")
		}
		query := usageHourly
		if by != "hour" {
			span := map[string]string{"day": "interval '30 days'", "week": "interval '26 weeks'", "year": "interval '3 years'"}[by]
			query = fmt.Sprintf(usageDaily, by, span)
		}
		rows, err = tx.Objects(ctx, query, id)
		return err
	})
	return endpoint.Result{Value: rows}, err
}

func (s Service) contractUsage(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	id := chi.URLParam(r, "id")
	if err := validate.UUID(id); err != nil {
		return endpoint.Result{}, err
	}
	q := validate.Query{Values: r.URL.Query()}
	by := q.Enum("by", "day", "hour", "day", "week", "year")
	if err := q.Err(); err != nil {
		return endpoint.Result{}, err
	}
	query := usageHourly
	if by != "hour" {
		query = fmt.Sprintf(usageDaily, by, map[string]string{"day": "interval '30 days'", "week": "interval '26 weeks'", "year": "interval '3 years'"}[by])
	}
	rows, err := s.rows(ctx, query, id)
	return endpoint.Result{Value: rows}, err
}
