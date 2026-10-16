package escrita

import (
	"context"
	"fmt"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"math"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"strconv"
	"unicode/utf16"
)

func registerCustom(api huma.API, registry *endpoint.Registry, s Service) {
	for _, entity := range []struct{ singular, table, permission string }{{"subscriber", "subscribers", "subscribers:write"}, {"contract", "contracts", "contracts:write"}} {
		registry.Handle(api, "PUT", "/api/"+entity.table+"/{id}/custom", entity.permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if e := validate.UUID(id); e != nil {
				return endpoint.Result{}, e
			}
			var raw any
			if e := apierr.DecodeJSON(r, &raw); e != nil {
				return endpoint.Result{}, e
			}
			body, e := validate.Object(validate.F("values", validate.Record(validate.Union(validate.String(), validate.Number(), validate.Boolean(), validate.Literal(nil))))).Parse(raw, true)
			if e != nil {
				return endpoint.Result{}, e
			}
			var result any
			e = s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				defs, e := tx.Objects(ctx, "select * from custom_fields where entity = $1 and active", entity.singular)
				if e != nil {
					return e
				}
				byKey := map[string]jsonx.Object{}
				for _, d := range defs {
					byKey[jsonx.String(d.Get("key"))] = d
				}
				clean := jsonx.Object{}
				cleared, keys := []string{}, []string{}
				for _, entry := range body["values"].(jsonx.Object) {
					d := byKey[entry.Name]
					if d == nil {
						return apierr.New(400, fmt.Sprintf("campo \"%s\" não existe ou está inativo", entry.Name))
					}
					v := entry.Value
					label := jsonx.String(d.Get("label"))
					if v == nil || v == "" {
						if d.Get("required") == true {
							return apierr.New(400, fmt.Sprintf("\"%s\" é obrigatório", label))
						}
						v = nil
						cleared = append(cleared, entry.Name)
					} else {
						bad, message := false, ""
						switch d.Get("type") {
						case "text":
							text, ok := v.(string)
							bad = !ok || len(utf16.Encode([]rune(text))) > 300
							message = "texto de até 300 caracteres"
							v = validate.Trim(text)
						case "number":
							n, ok := v.(float64)
							bad = !ok || math.IsNaN(n) || math.IsInf(n, 0)
							message = "informe um número"
						case "boolean":
							_, ok := v.(bool)
							bad = !ok
							message = "informe sim ou não"
						case "date":
							text, ok := v.(string)
							bad = !ok || !customDate(text)
							message = "use AAAA-MM-DD"
						default:
							found := false
							if values, ok := d.Get("options").([]any); ok {
								for _, option := range values {
									if option == v {
										found = true
									}
								}
							}
							bad = !found
							message = "valor fora das opções"
						}
						if bad {
							return apierr.New(400, fmt.Sprintf("\"%s\": %s", label, message))
						}
					}
					clean.Set(entry.Name, v)
					keys = append(keys, entry.Name)
				}
				encoded, e := jsonx.Encode(clean)
				if e != nil {
					return e
				}
				updated, e := tx.Objects(ctx, "update "+entity.table+" set custom = (custom || $2::jsonb) where id = $1 returning custom", id, encoded)
				if e != nil {
					return e
				}
				if len(updated) == 0 {
					return apierr.New(404, "registro não encontrado")
				}
				if len(cleared) > 0 {
					if e = tx.Exec(ctx, "update "+entity.table+" set custom = custom - $2::text[] where id = $1", id, cleared); e != nil {
						return e
					}
				}
				if e = record(ctx, tx, entity.singular+".custom", entity.singular, id, map[string]any{"keys": keys}); e != nil {
					return e
				}
				updated, e = tx.Objects(ctx, "select custom from "+entity.table+" where id = $1", id)
				if e != nil {
					return e
				}
				result = updated[0]
				return nil
			})
			return endpoint.Result{Value: result}, e
		})
	}
}
func customDate(value string) bool {
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(value) {
		return false
	}
	month, _ := strconv.Atoi(value[5:7])
	day, _ := strconv.Atoi(value[8:10])
	return month >= 1 && month <= 12 && day >= 1 && day <= 31
}
