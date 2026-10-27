package leitura

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/csvx"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// The accounting generation is the row, not the external session_id. Bigints
// travel as decimal strings so browsers and CSV never round traffic counters.
const radiusHistorySQL = `select id::text as id,nas_device_id,host(nas_ip) as nas_ip,
 username,session_id,started_at,updated_at,stopped_at,seen_at,
 case when stopped_at is null then 'open' else 'closed' end as state,
 session_seconds::text as session_seconds,bytes_in::text as bytes_in,bytes_out::text as bytes_out,
 framed_ip,host(framed_ipv6_address) as ipv6_address,framed_ipv6_prefix::text as ipv6_prefix,
 delegated_ipv6_prefix::text as delegated_ipv6_prefix,terminate_cause
 from radius_acct where id<$1
 and ($2='' or (stopped_at is null)=($2='open'))
 and ($3='' or username=$3)
 and ($4::uuid is null or nas_device_id=$4::uuid)
 order by radius_acct.id desc limit 101`

const radiusHistoryColumns = "id;nas_device_id;nas_ip;username;session_id;started_at;updated_at;stopped_at;seen_at;state;session_seconds;bytes_in;bytes_out;framed_ip;ipv6_address;ipv6_prefix;delegated_ipv6_prefix;terminate_cause"

type historyFilter struct {
	Before                       int64
	State, Username, NAS, Format string
}

func parseHistory(q url.Values) (historyFilter, error) {
	f := historyFilter{Before: 9223372036854775807}
	for k, v := range q {
		if len(v) != 1 {
			return f, apierr.New(400, "filtro repetido")
		}
		switch k {
		case "before", "state", "username", "nas", "format":
		default:
			return f, apierr.New(400, "filtro desconhecido")
		}
	}
	if raw := q.Get("before"); raw != "" {
		var e error
		f.Before, e = strconv.ParseInt(raw, 10, 64)
		if e != nil || f.Before <= 0 {
			return f, apierr.New(400, "cursor inválido")
		}
	}
	f.State = q.Get("state")
	if f.State != "" && f.State != "open" && f.State != "closed" {
		return f, apierr.New(400, "situação inválida")
	}
	f.Username = q.Get("username")
	if len(f.Username) > 253 {
		return f, apierr.New(400, "usuário muito longo")
	}
	f.NAS = q.Get("nas")
	if f.NAS != "" {
		if e := validate.UUID(f.NAS); e != nil {
			return f, e
		}
	}
	f.Format = q.Get("format")
	if f.Format != "" && f.Format != "csv" {
		return f, apierr.New(400, "formato inválido")
	}
	return f, nil
}
func historyCSV(rows []jsonx.Object) ([]byte, error) {
	if len(rows) == 0 {
		return []byte("\ufeff" + radiusHistoryColumns + "\r\n"), nil
	}
	// RADIUS identities are untrusted text, including whitespace before formulas.
	safe := make([]jsonx.Object, len(rows))
	for i, row := range rows {
		safe[i] = append(jsonx.Object(nil), row...)
		for j, field := range safe[i] {
			if text, ok := field.Value.(string); ok {
				trimmed := strings.TrimLeft(text, " \t\r\n")
				if trimmed != "" && strings.ContainsAny(trimmed[:1], "=+-@") {
					safe[i][j].Value = "'" + text
				}
			}
		}
	}
	return csvx.Auto(safe)
}
func registerRadiusHistory(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, "/api/radius/accounting/sessions", "network:read", false, func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
		if e := accountingScope(ctx); e != nil {
			return endpoint.Result{}, e
		}
		f, e := parseHistory(req.URL.Query())
		if e != nil {
			return endpoint.Result{}, e
		}
		rows, e := s.rows(ctx, radiusHistorySQL, f.Before, f.State, f.Username, null(f.NAS))
		if e != nil {
			return endpoint.Result{}, e
		}
		var next any
		if len(rows) > 100 {
			rows = rows[:100]
			next = rows[99].Get("id")
		}
		if f.Format == "csv" {
			if e = s.Audit.Write(ctx, auth.From(ctx), "export.csv", "radius_accounting", nil, map[string]any{"rows": len(rows), "before": strconv.FormatInt(f.Before, 10), "has_more": next != nil, "state": f.State, "username": f.Username, "nas": f.NAS}, "ok"); e != nil {
				return endpoint.Result{}, e
			}
			body, e := historyCSV(rows)
			return endpoint.Result{CSV: body, Filename: "radius-accounting-page.csv", CacheControl: "no-store"}, e
		}
		return endpoint.Result{Value: map[string]any{"items": rows, "next_before": next, "limit": 100, "source": "radius_acct", "live_connection_proof": false}, CacheControl: "no-store"}, nil
	})
}
