package escrita

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

const sitesCSVHeader = "local_id;tipo;local;pop_id;pop;cidade;endereco;latitude;longitude;ativo;observacoes"

func registerNetworkSitesExport(api huma.API, registry *endpoint.Registry, s Service) {
	registry.Handle(api, "GET", "/api/network/sites/export.csv", "network:read", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := siteActor(ctx)
		if err != nil {
			return endpoint.Result{}, err
		}
		filter, err := siteQuery(r.URL.RawQuery)
		if err != nil {
			return endpoint.Result{}, err
		}
		var total int
		var items []jsonx.Object
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			var e error
			total, items, e = sitePage(ctx, tx, filter)
			return e
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		body := exportSitesCSV(items)
		return endpoint.Result{
			CSV:          body,
			Filename:     "locais-infraestrutura-pagina.csv",
			Total:        strconv.Itoa(total),
			CacheControl: "private, no-store",
		}, nil
	})
}

func exportSitesCSV(items []jsonx.Object) []byte {
	var b strings.Builder
	b.WriteString("\ufeff")
	b.WriteString(sitesCSVHeader)
	b.WriteString("\r\n")
	for _, item := range items {
		row := []string{
			escapeCSVText(item.Get("id")),
			escapeCSVText(item.Get("kind")),
			escapeCSVText(item.Get("name")),
			escapeCSVText(item.Get("pop_id")),
			escapeCSVText(item.Get("pop_name")),
			escapeCSVText(item.Get("city")),
			escapeCSVText(item.Get("address")),
			formatCoord(item.Get("latitude")),
			formatCoord(item.Get("longitude")),
			formatBool(item.Get("active")),
			escapeCSVText(item.Get("notes")),
		}
		b.WriteString(strings.Join(row, ";"))
		b.WriteString("\r\n")
	}
	return []byte(b.String())
}

func escapeCSVText(v any) string {
	if v == nil {
		return ""
	}
	var s string
	switch x := v.(type) {
	case string:
		s = x
	default:
		s = fmt.Sprint(v)
	}
	if s == "" {
		return ""
	}
	trimmed := strings.TrimLeft(s, " \t\r\n")
	if trimmed != "" && strings.ContainsAny(trimmed[:1], "=+-@") {
		s = "'" + s
	}
	return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
}

func formatCoord(v any) string {
	if v == nil {
		return ""
	}
	switch val := v.(type) {
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return ""
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case float32:
		f := float64(val)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return ""
		}
		return strconv.FormatFloat(f, 'f', -1, 64)
	case int:
		return strconv.Itoa(val)
	case int64:
		return strconv.FormatInt(val, 10)
	case string:
		if f, err := strconv.ParseFloat(val, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return strconv.FormatFloat(f, 'f', -1, 64)
		}
		return ""
	default:
		return ""
	}
}

func formatBool(v any) string {
	if b, ok := v.(bool); ok && b {
		return "true"
	}
	return "false"
}
