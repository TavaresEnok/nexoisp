package leitura

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/csvx"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

const contractsWhere = `($2::text is null or c.status = $2)
        and ($3::uuid is null or exists (select 1 from contract_tags x where x.contract_id = c.id and x.tag_id = $3))
        and ($4::uuid is null or c.company_id = $4)
        and ($1::text is null or c.subscriber_id in (select s.id from subscribers s where s.name ilike '%' || $1 || '%')
             or c.plan_version_id in (select pv.id from plan_versions pv join plans p on p.id = pv.plan_id where p.name ilike '%' || $1 || '%'))
        and ($5::uuid is null or c.plan_version_id in (select pv.id from plan_versions pv where pv.plan_id = $5))
        and ($6::uuid is null or c.subscriber_id = $6)`
const contractsSQL = `select c.*, s.name as subscriber_name, s.document as subscriber_document,
                p.id as plan_id, p.name as plan_name, pv.version as plan_version, pv.price_cents, pv.down_kbps, pv.up_kbps, pv.profile_name,
                coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name) order by t.name) from contract_tags ct join tags t on t.id = ct.tag_id where ct.contract_id = c.id), '[]') as tags
         from (select * from contracts c where %s order by c.created_at desc, c.id limit %d offset %s) c
         join subscribers s on s.id = c.subscriber_id join plan_versions pv on pv.id = c.plan_version_id join plans p on p.id = pv.plan_id
         order by c.created_at desc, c.id`

func null(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (s Service) contracts(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	q := validate.Query{Values: r.URL.Query()}
	text := q.String("q", true, false)
	status := q.Enum("status", "", "active", "ended")
	tag := q.UUID("tag", false)
	company := q.UUID("company_id", false)
	plan := q.UUID("plan_id", false)
	subscriber := q.UUID("subscriber_id", false)
	format := q.String("format", false, false)
	page := q.Page()
	if err := q.Err(); err != nil {
		return endpoint.Result{}, err
	}
	cap := 500
	if format == "csv" {
		cap = 5000
	}
	limit := cap
	if page.HasLimit {
		limit = min(page.Limit, cap)
	}
	args := []any{null(text), null(status), null(tag), null(company), null(plan), null(subscriber)}
	var rows []jsonx.Object
	var total int64
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		var err error
		rows, err = tx.Objects(ctx, fmt.Sprintf(contractsSQL, contractsWhere, limit, strconv.FormatFloat(page.Offset, 'f', -1, 64)), args...)
		if err != nil {
			return err
		}
		if page.Offset == 0 && len(rows) < limit {
			total = int64(len(rows))
			return nil
		}
		return tx.QueryRow(ctx, "select count(*) as n from contracts c where "+contractsWhere, args...).Scan(&total)
	})
	result := endpoint.Result{Value: rows, Total: strconv.FormatInt(total, 10)}
	if err == nil && format == "csv" && r.Method == http.MethodGet {
		err = s.Audit.Write(ctx, auth.From(ctx), "export.csv", "list", nil, map[string]any{"path": "/api/contracts", "rows": len(rows)}, "ok")
		if err == nil {
			result.CSV, err = csvx.Auto(rows)
			result.Filename = "contracts.csv"
		}
	}
	return result, err
}
