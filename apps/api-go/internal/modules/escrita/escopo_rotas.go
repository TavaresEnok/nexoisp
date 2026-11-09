package escrita

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// scopedHandler recebe os parâmetros de caminho já validados como UUID e o corpo
// validado (nil quando a rota não tem corpo).
type scopedHandler func(ctx context.Context, tx *db.Tx, r *http.Request, params map[string]string, body map[string]any) (any, error)

// routeScoped registra uma rota que executa toda a regra numa transação com o
// escopo (provedor, POP, assinante) da sessão; o RLS do PostgreSQL isola os dados.
// Corpo vazio é aceito quando optionalBody é verdadeiro e vira objeto vazio validado.
func routeScoped(api huma.API, registry *endpoint.Registry, s Service, method, path, permission string, rule *validate.Rule, optionalBody bool, run scopedHandler) {
	registry.Handle(api, method, path, permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		params := map[string]string{}
		for _, name := range []string{"id", "lineId"} {
			if value := chi.URLParam(r, name); value != "" {
				if err := validate.UUID(value); err != nil {
					return endpoint.Result{}, err
				}
				params[name] = value
			}
		}
		var body map[string]any
		if rule != nil {
			var raw any = map[string]any{}
			if !(optionalBody && r.ContentLength == 0) {
				if err := apierr.DecodeJSON(r, &raw); err != nil {
					return endpoint.Result{}, err
				}
				// Corpo opcional: JSON null equivale a corpo ausente (clientes antigos).
				if optionalBody && raw == nil {
					raw = map[string]any{}
				}
			}
			parsed, err := rule.Parse(raw, true)
			if err != nil {
				return endpoint.Result{}, err
			}
			body = parsed
		}
		var value any
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			var err error
			value, err = run(ctx, tx, r, params, body)
			return err
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		if result, ok := value.(endpoint.Result); ok {
			return result, nil
		}
		status := 0
		if method == http.MethodPost && params["id"] == "" {
			status = http.StatusCreated
		}
		return endpoint.Result{Value: value, Status: status}, nil
	})
}

// dateRule aceita somente datas de calendário reais no formato AAAA-MM-DD.
func dateRule() validate.Rule {
	return validate.String().Pattern(`^\d{4}-\d{2}-\d{2}$`, "use AAAA-MM-DD").Refine(func(v any) bool {
		text, ok := v.(string)
		return ok && calendarDate(text)
	}, "data inexistente")
}
func calendarDate(text string) bool {
	_, err := time.Parse("2006-01-02", text)
	return err == nil
}

// queryDate lê um filtro de data opcional e recusa datas inexistentes.
func queryDate(q *validate.Query, name string) string {
	value := q.Date(name, false, "use AAAA-MM-DD")
	if value != "" && len(q.Issues) == 0 && !calendarDate(value) {
		q.Issues = append(q.Issues, name+": data inexistente")
	}
	return value
}

// tenantClock devolve o fuso do provedor e a data de hoje nesse fuso.
func tenantClock(ctx context.Context, tx *db.Tx) (string, string, error) {
	rows, err := tx.Objects(ctx, `select z.tz, (now() at time zone z.tz)::date::text as today
		from (select coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo') as tz) z`)
	if err != nil {
		return "", "", err
	}
	return jsonx.String(rows[0].Get("tz")), jsonx.String(rows[0].Get("today")), nil
}

// firstRow devolve a primeira linha ou 404 com a mensagem informada:
// firstRow("não encontrado")(tx.Objects(...)).
func firstRow(missing string) func([]jsonx.Object, error) (jsonx.Object, error) {
	return func(rows []jsonx.Object, err error) (jsonx.Object, error) {
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, missing)
		}
		return rows[0], nil
	}
}

// tenantWide recusa sessões restritas a POP ou assinante: liquidações e títulos
// a pagar são do provedor inteiro (o RLS também os esconde nesses escopos).
func tenantWide(run scopedHandler) scopedHandler {
	return func(ctx context.Context, tx *db.Tx, r *http.Request, params map[string]string, body map[string]any) (any, error) {
		scope := auth.From(ctx).Scope
		if len(scope.PopIDs) > 0 || scope.SubscriberID != "" {
			return nil, apierr.New(403, "disponível somente para acesso a todos os POPs do provedor")
		}
		return run(ctx, tx, r, params, body)
	}
}
