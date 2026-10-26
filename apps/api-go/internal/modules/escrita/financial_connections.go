package escrita

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/validate"
)

const connectionColumns = `id,company_id,provider,environment,account_ref,name,status,is_default,legacy_demo,(webhook_secret_enc is not null) as has_webhook_secret,credential_version_id,created_at`

func registerFinancialConnections(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, en, b := validate.F, validate.Object, validate.Enum, validate.Boolean
	uuid := validate.String().UUID()
	for _, route := range []struct{ method, path string }{{"GET", "/api/financial-connections"}, {"POST", "/api/financial-connections"}, {"PATCH", "/api/financial-connections/{id}"}, {"GET", "/api/financial-connections/pending"}} {
		registry.Handle(api, route.method, route.path, "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor := auth.From(ctx)
			if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
				return endpoint.Result{}, apierr.New(403, "gestão de conexões exige escopo completo do provedor")
			}
			var body map[string]any
			if route.method != "GET" {
				var raw any
				if e := apierr.DecodeJSON(r, &raw); e != nil {
					return endpoint.Result{}, e
				}
				schema := obj(o(f("status", en("active", "disabled", "pending")), f("is_default", b().Opt())))
				if route.method == "POST" {
					schema = obj(o(f("name", text(120).Min(2)), f("company_id", uuid.Nullish()), f("provider", en("demo", "efi", "sejaefi", "asaas", "inter", "sicredi", "mercado_pago", "pagbank", "stripe", "kobana", "shipay", "tuna")), f("environment", en("sandbox", "production")), f("account_ref", text(120).Min(1)), f("is_default", b().Opt()), f("webhook_secret", text(500).Min(32).Opt())))
				}
				var e error
				body, e = schema.Parse(raw, true)
				if e != nil {
					return endpoint.Result{}, e
				}
			}
			var out any
			e := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				if route.method == "GET" {
					query := "select " + connectionColumns + " from financial_connections order by created_at,id"
					if route.path == "/api/financial-connections/pending" {
						query = "select entity,id,provider,reason from financial_connection_pending order by entity,id"
					}
					rows, e := tx.Objects(ctx, query)
					out = rows
					return e
				}
				if route.method == "POST" {
					if body["company_id"] != nil {
						var valid bool
						if e := tx.QueryRow(ctx, "select exists(select 1 from companies where id=$1 and active)", body["company_id"]).Scan(&valid); e != nil {
							return e
						}
						if !valid {
							return apierr.New(400, "empresa não disponível neste provedor")
						}
					}
					if body["provider"] == "sejaefi" {
						body["provider"] = "efi"
					}
					var secret any
					if value, ok := body["webhook_secret"].(string); ok {
						enc, e := cryptox.EncryptSecret(value)
						if e != nil {
							return e
						}
						secret = enc
					}
					// Registration does not activate dispatch. Sandbox activation has
					// its own explicit gate and requires credentials below.
					rows, e := tx.Objects(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name,is_default,webhook_secret_enc) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning `+connectionColumns, actor.TenantID, body["company_id"], body["provider"], body["environment"], body["account_ref"], body["name"], body["is_default"] == true, secret)
					if e != nil {
						return e
					}
					if len(rows) == 0 {
						return apierr.New(409, "conta ou conexão padrão já cadastrada")
					}
					out = rows[0]
					return record(ctx, tx, "finance.connection.create", "financial_connection", rows[0].Get("id"), map[string]any{"provider": body["provider"], "environment": body["environment"]})
				}
				id := chi.URLParam(r, "id")
				if e := validate.UUID(id); e != nil {
					return e
				}
				if e := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,65))`, actor.TenantID); e != nil {
					return e
				}
				rows, e := tx.Objects(ctx, "select "+connectionColumns+" from financial_connections where id=$1 for update", id)
				if e != nil {
					return e
				}
				if len(rows) != 1 {
					return apierr.New(404, "conexão não encontrada")
				}
				c := rows[0]
				if body["status"] == "active" {
					demo := finance.Demo(c.Get("provider")) && c.Get("environment") == "sandbox" && (c.Get("has_webhook_secret") == true || c.Get("legacy_demo") == true)
					efi := false
					if finance.EFISandboxEnabled() && c.Get("provider") == "efi" && c.Get("environment") == "sandbox" {
						if err := tx.QueryRow(ctx, `select exists(select 1 from financial_credential_versions v join financial_connections c on c.credential_version_id=v.id where c.id=$1 and (v.kind='efi_charges' or v.certificate_expires_at>now()))`, id).Scan(&efi); err != nil {
							return err
						}
					}
					if !demo && !efi {
						return apierr.New(409, "ativação exige demonstração ou Efí sandbox explicitamente habilitado com credencial válida")
					}
				}
				if body["is_default"] == true {
					if e = tx.Exec(ctx, `update financial_connections set is_default=false where id<>$1 and company_id is not distinct from $2::uuid and provider=$3 and environment=$4 and is_default`, id, c.Get("company_id"), c.Get("provider"), c.Get("environment")); e != nil {
						return e
					}
				}
				if e = tx.Exec(ctx, "update financial_connections set status=$2,is_default=coalesce($3,is_default) where id=$1", id, body["status"], body["is_default"]); e != nil {
					return e
				}
				out = map[string]any{"id": id, "status": body["status"]}
				return record(ctx, tx, "finance.connection.status", "financial_connection", id, map[string]any{"status": body["status"], "is_default": body["is_default"]})
			})
			return endpoint.Result{Value: out}, e
		})
	}
}
