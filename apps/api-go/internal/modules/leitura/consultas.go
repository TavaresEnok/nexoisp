package leitura

import (
	"context"
	"net/http"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/csvx"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

type filter struct {
	Name, Kind         string
	Trim               bool
	Min, Max, Fallback int
	Choices            []string
}
type consulta struct {
	Path, Permission, SQL string
	Args                  []string
	One                   bool
	Missing, Wrap         string
	Filters               []filter
}

func registerConsultas(api huma.API, registry *endpoint.Registry, s Service) {
	for _, spec := range consultas {
		registry.Get(api, spec.Path, spec.Permission, false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			// Path schemas precede query schemas in the original handlers.
			id := chi.URLParam(r, "id")
			for _, param := range spec.Args {
				if param == "id" {
					if err := validate.UUID(id); err != nil {
						return endpoint.Result{}, err
					}
					break
				}
			}
			query := validate.Query{Values: r.URL.Query()}
			values := map[string]any{}
			for _, f := range spec.Filters {
				switch f.Kind {
				case "uuid":
					values[f.Name] = null(query.UUID(f.Name, false))
				case "enum":
					values[f.Name] = null(query.Enum(f.Name, "", f.Choices...))
				case "flag":
					values[f.Name] = query.Enum(f.Name, "", f.Choices...) != ""
				case "string":
					if _, present := r.URL.Query()[f.Name]; present {
						values[f.Name] = query.BoundedString(f.Name, f.Trim, f.Min, f.Max)
					}
				case "integer":
					values[f.Name] = query.Integer(f.Name, f.Fallback, f.Min, f.Max)
				}
			}
			if err := query.Err(); err != nil {
				return endpoint.Result{}, err
			}
			args := []any{}
			for _, param := range spec.Args {
				switch {
				case param == "id":
					args = append(args, id)
				case param == "tenant":
					args = append(args, null(auth.From(ctx).TenantID))
				case strings.HasPrefix(param, "query:"):
					args = append(args, values[strings.TrimPrefix(param, "query:")])
				}
			}
			rows, err := s.rows(ctx, spec.SQL, args...)
			if err != nil {
				return endpoint.Result{}, err
			}
			result := endpoint.Result{Value: rows}
			if spec.One {
				if len(rows) == 0 && spec.Missing != "" {
					return result, apierr.New(404, spec.Missing)
				}
				result.Value = first(rows)
			}
			if spec.Wrap != "" {
				result.Value = map[string]any{spec.Wrap: result.Value}
			}
			if spec.Path == "/api/stock/items" || spec.Path == "/api/stock/units" {
				return s.export(ctx, r, result)
			}
			return result, nil
		})
	}
}
func (s Service) export(ctx context.Context, r *http.Request, result endpoint.Result) (endpoint.Result, error) {
	formats := r.URL.Query()["format"]
	if r.Method != http.MethodGet || len(formats) != 1 || formats[0] != "csv" {
		return result, nil
	}
	// Kept separate from the business transaction, as in the Fastify onSend hook.
	items := result.Value.([]jsonx.Object)
	err := s.Audit.Write(ctx, auth.From(ctx), "export.csv", "list", nil, map[string]any{"path": r.URL.Path, "rows": len(items)}, "ok")
	if err == nil {
		result.CSV, err = csvx.Auto(items)
		result.Filename = strings.ReplaceAll(strings.TrimPrefix(r.URL.Path, "/api/"), "/", "-") + ".csv"
	}
	return result, err
}
