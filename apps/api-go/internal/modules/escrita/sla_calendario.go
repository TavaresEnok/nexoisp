package escrita

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Calendário de expediente e feriados usados pelas políticas de SLA marcadas
// como "só no expediente" (função sla_due). Alterações valem para prazos
// calculados a partir delas; prazos já atribuídos não são recalculados.
var slaTimezones = []string{"America/Sao_Paulo", "America/Fortaleza", "America/Recife", "America/Bahia", "America/Maceio", "America/Belem", "America/Araguaina", "America/Manaus", "America/Cuiaba", "America/Campo_Grande", "America/Porto_Velho", "America/Boa_Vista", "America/Rio_Branco", "America/Santarem", "America/Noronha"}

func registerSlaCalendar(api huma.API, registry *endpoint.Registry, s Service) {
	clock := validate.String().Pattern(`^([01][0-9]|2[0-3]):[0-5][0-9]$`, "use HH:MM")
	day := validate.Object(validate.F("start", clock), validate.F("end", clock)).Null()
	calendar := validate.Object(
		validate.F("timezone", validate.Enum(slaTimezones...)),
		validate.F("hours", validate.Array(day).Min(7).Max(7)),
	)
	holiday := validate.Object(
		validate.F("day", validate.String().Pattern(`^\d{4}-\d{2}-\d{2}$`, "use AAAA-MM-DD")),
		validate.F("name", validate.String().Trimmed().Min(2).Max(80)),
	)
	scoped := func(ctx context.Context, run func(*db.Tx) (any, error)) (endpoint.Result, error) {
		var value any
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			var err error
			value, err = run(tx)
			return err
		})
		return endpoint.Result{Value: value}, err
	}
	parse := func(r *http.Request, rule validate.Rule) (map[string]any, error) {
		var raw any
		if err := apierr.DecodeJSON(r, &raw); err != nil {
			return nil, err
		}
		return rule.Parse(raw, true)
	}

	registry.Get(api, "/api/sla-calendar", "settings:manage", false, func(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			rows, err := tx.Objects(ctx, "select timezone, hours, updated_at from sla_calendars")
			if err != nil || len(rows) > 0 {
				if len(rows) > 0 {
					return rows[0], err
				}
				return nil, err
			}
			return map[string]any{"timezone": nil, "hours": nil, "updated_at": nil}, nil
		})
	})
	registry.Handle(api, http.MethodPut, "/api/sla-calendar", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		b, err := parse(r, calendar)
		if err != nil {
			return endpoint.Result{}, err
		}
		for _, entry := range b["hours"].([]any) {
			if window, ok := entry.(map[string]any); ok && window["end"].(string) <= window["start"].(string) {
				return endpoint.Result{}, apierr.New(400, "hours: o fim do expediente deve ser depois do início")
			}
		}
		hours, err := jsonx.Encode(b["hours"])
		if err != nil {
			return endpoint.Result{}, err
		}
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			rows, err := tx.Objects(ctx, `insert into sla_calendars (tenant_id, timezone, hours) values (app_tenant(), $1, $2::jsonb)
				on conflict (tenant_id) do update set timezone = excluded.timezone, hours = excluded.hours, updated_at = now()
				returning timezone, hours, updated_at`, b["timezone"], string(hours))
			if err != nil {
				return nil, err
			}
			return rows[0], record(ctx, tx, "sla_calendar.update", "tenant", auth.From(ctx).TenantID, map[string]any{"timezone": b["timezone"]})
		})
	})
	registry.Get(api, "/api/sla-holidays", "settings:manage", false, func(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			return tx.Objects(ctx, "select id, day, name from sla_holidays order by day")
		})
	})
	registry.Handle(api, http.MethodPost, "/api/sla-holidays", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		b, err := parse(r, holiday)
		if err != nil {
			return endpoint.Result{}, err
		}
		result, err := scoped(ctx, func(tx *db.Tx) (any, error) {
			rows, err := tx.Objects(ctx, "insert into sla_holidays (tenant_id, day, name) values (app_tenant(), $1::date, $2) returning id, day, name", b["day"], b["name"])
			if err != nil {
				return nil, catalogConflict(err, "já existe feriado cadastrado nesta data")
			}
			return rows[0], record(ctx, tx, "sla_holiday.create", "sla_holiday", rows[0].Get("id"), b)
		})
		result.Status = http.StatusCreated
		return result, err
	})
	registry.Handle(api, http.MethodDelete, "/api/sla-holidays/{id}", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		id := chi.URLParam(r, "id")
		if err := validate.UUID(id); err != nil {
			return endpoint.Result{}, err
		}
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			rows, err := tx.Objects(ctx, "delete from sla_holidays where id = $1 returning day, name", id)
			if err != nil {
				return nil, err
			}
			if len(rows) == 0 {
				return nil, apierr.New(404, "feriado não encontrado")
			}
			return map[string]any{"ok": true}, record(ctx, tx, "sla_holiday.delete", "sla_holiday", id, map[string]any{"name": rows[0].Get("name")})
		})
	})
}
