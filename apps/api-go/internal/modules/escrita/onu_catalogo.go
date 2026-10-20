package escrita

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Catálogo de referência de ONUs (modelos e templates de provisionamento).
// Documentação técnica do provedor: não envia comandos à OLT nem altera ONUs.
// O prefixo /api/olt/ exige o módulo OLT (auth.Modules).
const (
	onuModelColumns = `m.id, m.code, m.vendor, m.description, m.ports, m.wifi, m.mode, m.profile,
		to_jsonb(m.compatible_olts) as compatible_olts, m.notes, m.updated_at,
		(select count(*)::int from onu_template_models x where x.model_id = m.id) as templates`
	onuTemplateColumns = `t.id, t.name, t.vendor, t.mode, to_jsonb(t.compatible_olts) as compatible_olts, t.gpon, t.wan, t.notes, t.updated_at,
		coalesce((select jsonb_agg(x.model_id order by x.model_id) from onu_template_models x where x.template_id = t.id), '[]'::jsonb) as model_ids`
)

func onuSchemas() (model, template validate.Rule) {
	str := func(max float64) validate.Rule { return validate.String().Trimmed().Max(max) }
	olts := validate.Array(validate.String().Trimmed().Min(1).Max(80)).Max(30)
	mode := validate.Enum("Bridge", "Router")
	model = validate.Object(
		validate.F("code", str(80).Min(1)), validate.F("vendor", str(80).Min(1)), validate.F("mode", mode),
		validate.F("description", str(500).Def("")), validate.F("ports", str(120).Def("")), validate.F("wifi", str(120).Def("")),
		validate.F("profile", str(120).Def("")), validate.F("compatible_olts", olts.Def([]any{})), validate.F("notes", str(2000).Def("")),
	)
	template = validate.Object(
		validate.F("name", str(120).Min(2)), validate.F("vendor", str(80).Min(1)), validate.F("mode", mode),
		validate.F("model_ids", validate.Array(validate.String().UUID()).Max(50).Def([]any{})),
		validate.F("compatible_olts", olts.Def([]any{})), validate.F("gpon", validate.String().Max(20000).Def("")),
		validate.F("wan", validate.String().Max(20000).Def("")), validate.F("notes", str(2000).Def("")),
	)
	return
}

func texts(value any) []string {
	out := []string{}
	for _, item := range value.([]any) {
		out = append(out, item.(string))
	}
	return out
}

func catalogConflict(err error, message string) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return apierr.New(409, message)
	}
	return err
}

func registerOnuCatalog(api huma.API, registry *endpoint.Registry, s Service) {
	modelSchema, templateSchema := onuSchemas()
	scoped := func(ctx context.Context, run func(*db.Tx) (any, error)) (endpoint.Result, error) {
		var value any
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			var err error
			value, err = run(tx)
			return err
		})
		return endpoint.Result{Value: value}, err
	}
	body := func(r *http.Request, rule validate.Rule) (map[string]any, error) {
		var raw any
		if err := apierr.DecodeJSON(r, &raw); err != nil {
			return nil, err
		}
		return rule.Parse(raw, true)
	}
	id := func(r *http.Request) (string, error) {
		value := chi.URLParam(r, "id")
		return value, validate.UUID(value)
	}
	one := func(tx *db.Tx, ctx context.Context, query, id string) (any, error) {
		rows, err := tx.Objects(ctx, query, id)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "registro do catálogo não encontrado")
		}
		return rows[0], nil
	}

	registry.Get(api, "/api/olt/onu-models", "network:read", false, func(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			return tx.Objects(ctx, "select "+onuModelColumns+" from onu_models m order by m.vendor, m.code")
		})
	})
	saveModel := func(ctx context.Context, tx *db.Tx, current string, b map[string]any) (any, error) {
		args := []any{b["code"], b["vendor"], b["description"], b["ports"], b["wifi"], b["mode"], b["profile"], texts(b["compatible_olts"]), b["notes"]}
		var rows []jsonx.Object
		var err error
		if current == "" {
			rows, err = tx.Objects(ctx, `insert into onu_models (tenant_id, code, vendor, description, ports, wifi, mode, profile, compatible_olts, notes)
				values (app_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, args...)
		} else {
			rows, err = tx.Objects(ctx, `update onu_models set code = $2, vendor = $3, description = $4, ports = $5, wifi = $6, mode = $7,
				profile = $8, compatible_olts = $9, notes = $10, updated_at = now() where id = $1 returning id`, append([]any{current}, args...)...)
		}
		if err != nil {
			return nil, catalogConflict(err, "já existe um modelo de ONU com este código")
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "registro do catálogo não encontrado")
		}
		saved := jsonx.String(rows[0].Get("id"))
		if err = record(ctx, tx, map[bool]string{true: "onu_model.create", false: "onu_model.update"}[current == ""], "onu_model", saved, map[string]any{"code": b["code"]}); err != nil {
			return nil, err
		}
		return one(tx, ctx, "select "+onuModelColumns+" from onu_models m where m.id = $1", saved)
	}
	registry.Handle(api, http.MethodPost, "/api/olt/onu-models", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		b, err := body(r, modelSchema)
		if err != nil {
			return endpoint.Result{}, err
		}
		result, err := scoped(ctx, func(tx *db.Tx) (any, error) { return saveModel(ctx, tx, "", b) })
		result.Status = http.StatusCreated
		return result, err
	})
	registry.Handle(api, http.MethodPatch, "/api/olt/onu-models/{id}", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		current, err := id(r)
		if err != nil {
			return endpoint.Result{}, err
		}
		b, err := body(r, modelSchema)
		if err != nil {
			return endpoint.Result{}, err
		}
		return scoped(ctx, func(tx *db.Tx) (any, error) { return saveModel(ctx, tx, current, b) })
	})
	registry.Handle(api, http.MethodDelete, "/api/olt/onu-models/{id}", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		current, err := id(r)
		if err != nil {
			return endpoint.Result{}, err
		}
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			used, err := tx.Objects(ctx, "select exists (select 1 from onu_template_models where model_id = $1) as used", current)
			if err != nil {
				return nil, err
			}
			if used[0].Get("used") == true {
				return nil, apierr.New(409, "o modelo está associado a templates; remova a associação antes de excluir")
			}
			rows, err := tx.Objects(ctx, "delete from onu_models where id = $1 returning code", current)
			if err != nil {
				return nil, err
			}
			if len(rows) == 0 {
				return nil, apierr.New(404, "registro do catálogo não encontrado")
			}
			return map[string]any{"ok": true}, record(ctx, tx, "onu_model.delete", "onu_model", current, map[string]any{"code": rows[0].Get("code")})
		})
	})

	registry.Get(api, "/api/olt/onu-templates", "network:read", false, func(ctx context.Context, _ *http.Request) (endpoint.Result, error) {
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			return tx.Objects(ctx, "select "+onuTemplateColumns+" from onu_templates t order by t.vendor, t.name")
		})
	})
	saveTemplate := func(ctx context.Context, tx *db.Tx, current string, b map[string]any) (any, error) {
		models := texts(b["model_ids"])
		found, err := tx.Objects(ctx, "select count(*) = $2 as ok from onu_models where id = any($1::uuid[])", models, int64(len(dedupe(models))))
		if err != nil {
			return nil, err
		}
		if found[0].Get("ok") != true {
			return nil, apierr.New(400, "model_ids: modelo de ONU inexistente")
		}
		args := []any{b["name"], b["vendor"], b["mode"], texts(b["compatible_olts"]), b["gpon"], b["wan"], b["notes"]}
		var rows []jsonx.Object
		if current == "" {
			rows, err = tx.Objects(ctx, `insert into onu_templates (tenant_id, name, vendor, mode, compatible_olts, gpon, wan, notes)
				values (app_tenant(), $1, $2, $3, $4, $5, $6, $7) returning id`, args...)
		} else {
			rows, err = tx.Objects(ctx, `update onu_templates set name = $2, vendor = $3, mode = $4, compatible_olts = $5, gpon = $6,
				wan = $7, notes = $8, updated_at = now() where id = $1 returning id`, append([]any{current}, args...)...)
		}
		if err != nil {
			return nil, catalogConflict(err, "já existe um template com este nome")
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "registro do catálogo não encontrado")
		}
		saved := jsonx.String(rows[0].Get("id"))
		if err = tx.Exec(ctx, "delete from onu_template_models where template_id = $1", saved); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, `insert into onu_template_models (tenant_id, template_id, model_id)
			select app_tenant(), $1, m from unnest($2::uuid[]) m on conflict do nothing`, saved, models); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, map[bool]string{true: "onu_template.create", false: "onu_template.update"}[current == ""], "onu_template", saved, map[string]any{"name": b["name"]}); err != nil {
			return nil, err
		}
		return one(tx, ctx, "select "+onuTemplateColumns+" from onu_templates t where t.id = $1", saved)
	}
	registry.Handle(api, http.MethodPost, "/api/olt/onu-templates", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		b, err := body(r, templateSchema)
		if err != nil {
			return endpoint.Result{}, err
		}
		result, err := scoped(ctx, func(tx *db.Tx) (any, error) { return saveTemplate(ctx, tx, "", b) })
		result.Status = http.StatusCreated
		return result, err
	})
	registry.Handle(api, http.MethodPatch, "/api/olt/onu-templates/{id}", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		current, err := id(r)
		if err != nil {
			return endpoint.Result{}, err
		}
		b, err := body(r, templateSchema)
		if err != nil {
			return endpoint.Result{}, err
		}
		return scoped(ctx, func(tx *db.Tx) (any, error) { return saveTemplate(ctx, tx, current, b) })
	})
	registry.Handle(api, http.MethodDelete, "/api/olt/onu-templates/{id}", "network:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		current, err := id(r)
		if err != nil {
			return endpoint.Result{}, err
		}
		return scoped(ctx, func(tx *db.Tx) (any, error) {
			rows, err := tx.Objects(ctx, "delete from onu_templates where id = $1 returning name", current)
			if err != nil {
				return nil, err
			}
			if len(rows) == 0 {
				return nil, apierr.New(404, "registro do catálogo não encontrado")
			}
			return map[string]any{"ok": true}, record(ctx, tx, "onu_template.delete", "onu_template", current, map[string]any{"name": rows[0].Get("name")})
		})
	})
}

func dedupe(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}
