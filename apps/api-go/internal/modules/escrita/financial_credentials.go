package escrita

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/validate"
)

func registerFinancialCredentials(api huma.API, registry *endpoint.Registry, s Service) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		registry.Handle(api, method, "/api/financial-connections/{id}/credentials", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor := auth.From(ctx)
			if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
				return endpoint.Result{}, apierr.New(403, "cofre financeiro exige escopo completo do provedor")
			}
			id := chi.URLParam(r, "id")
			if err := validate.UUID(id); err != nil {
				return endpoint.Result{}, err
			}
			var input finance.PixCredentials
			if method == http.MethodPost {
				if err := apierr.DecodeJSON(r, &input); err != nil {
					return endpoint.Result{}, err
				}
			}
			var out any
			err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				var exists bool
				if err := tx.QueryRow(ctx, `select exists(select 1 from financial_connections where id=$1)`, id).Scan(&exists); err != nil {
					return err
				}
				if !exists {
					return apierr.New(404, "conexão não encontrada")
				}
				if method == http.MethodGet {
					v, e := finance.ListCredentials(ctx, tx, id)
					out = v
					return e
				}
				v, e := finance.SaveFinancialCredentials(ctx, tx, id, actor.UserID, input)
				if e != nil {
					return e
				}
				out = v
				return record(ctx, tx, "finance.credential.create", "financial_connection", id, map[string]any{"credential_version_id": v.ID, "version": v.Version, "kind": v.Kind})
			})
			return endpoint.Result{Value: out}, err
		})
	}
}
