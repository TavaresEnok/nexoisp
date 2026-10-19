package leitura

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

type groupInput struct {
	Page validate.Page
	Args []any
	CSV  bool
}

func parsePaged(path string, r *http.Request, user string) (*groupInput, error) {
	q := validate.Query{Values: r.URL.Query()}
	input := &groupInput{}
	switch path {
	case "/api/leads":
		stage := q.Enum("stage", "", "new", "contacted", "proposal", "won", "lost", "open")
		text := q.BoundedString("q", true, 0, 100)
		input.Args = []any{null(stage), null(text)}
	case "/api/tickets":
		status := q.Enum("status", "", "open", "waiting", "closed", "pending")
		text := q.BoundedString("q", true, 0, 100)
		subscriber := q.UUID("subscriber_id", false)
		mine := q.Enum("mine", "", "1")
		var assigned any
		if mine != "" {
			assigned = user
		}
		input.Args = []any{null(status), null(text), null(subscriber), assigned}
	case "/api/work-orders":
		status := q.Enum("status", "", "open", "analysis", "awaiting_schedule", "scheduled", "en_route", "in_progress", "done", "canceled", "pending")
		text := q.BoundedString("q", true, 0, 100)
		mine := q.Enum("mine", "", "1")
		subscriber := q.UUID("subscriber_id", false)
		contract := q.UUID("contract_id", false)
		var assigned any = null(q.UUID("assignee_id", false))
		if mine != "" {
			assigned = user
		}
		input.Args = []any{null(status), null(text), assigned, null(subscriber), null(contract)}
	case "/api/audit":
		input.Args = []any{}
	case "/api/surveys":
		status := q.Enum("status", "", "answered", "pending", "expired")
		input.Args = []any{null(status)}
	default:
		return nil, nil
	}
	input.Page = q.Page()
	formats := r.URL.Query()["format"]
	input.CSV = len(formats) == 1 && formats[0] == "csv"
	return input, q.Err()
}
func paged(ctx context.Context, tx *db.Tx, query string, args []any, p validate.Page, maxRows int, csv bool) ([]jsonx.Object, string, error) {
	cap := maxRows
	if csv {
		cap = 5000
	}
	limit := cap
	if p.HasLimit {
		limit = min(p.Limit, cap)
	}
	// sqlc exports the query name comment too. Keep the SQL inside the wrapper.
	if strings.HasPrefix(query, "-- name:") {
		query = strings.SplitN(query, "\n", 2)[1]
	}
	query = strings.TrimSuffix(strings.TrimSpace(query), ";")
	rows, err := tx.Objects(ctx, fmt.Sprintf("select x.* from (%s) x limit %d offset %s", query, limit, strconv.FormatFloat(p.Offset, 'f', -1, 64)), args...)
	if err != nil {
		return nil, "", err
	}
	total := int64(len(rows))
	if p.Offset != 0 || len(rows) >= limit {
		err = tx.QueryRow(ctx, "select count(*) as n from ("+query+") x", args...).Scan(&total)
	}
	return rows, strconv.FormatInt(total, 10), err
}
func (s Service) pagedGroup(ctx context.Context, tx *db.Tx, spec grupo, input *groupInput) (endpoint.Result, error) {
	args := input.Args
	maxRows, idx := 500, 0
	if spec.Path == "/api/audit" {
		maxRows = 300
		args = []any{auth.From(ctx).TenantID}
	}
	var summary any
	if spec.Path == "/api/surveys" {
		rows, err := tx.Objects(ctx, spec.SQL[0])
		if err != nil {
			return endpoint.Result{}, err
		}
		summary = first(rows)
		idx = 1
	}
	rows, total, err := paged(ctx, tx, spec.SQL[idx], args, input.Page, maxRows, input.CSV)
	result := endpoint.Result{Value: rows, Total: total}
	if summary != nil {
		result.Value = map[string]any{"summary": summary, "rows": rows}
	}
	return result, err
}
