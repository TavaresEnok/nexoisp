package escrita

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/validate"
	"time"
)

func registerProviderResolution(api huma.API, registry *endpoint.Registry, s Service) {
	for _, kind := range []string{"resolve", "reissue"} {
		registry.Handle(api, http.MethodPost, "/api/financial-connections/{id}/issuance/{issuanceId}/"+kind, "finance:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor := auth.From(ctx)
			if actor.Support || actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
				return endpoint.Result{}, apierr.New(403, "resolução exige escopo financeiro completo")
			}
			if !finance.EFISandboxEnabled() {
				return endpoint.Result{}, apierr.New(409, "consulta Efí sandbox desabilitada")
			}
			connection, id := chi.URLParam(r, "id"), chi.URLParam(r, "issuanceId")
			if validate.UUID(connection) != nil || validate.UUID(id) != nil {
				return endpoint.Result{}, apierr.New(400, "identificadores inválidos")
			}
			var body finance.ResolutionInput
			if e := apierr.DecodeJSON(r, &body); e != nil {
				return endpoint.Result{}, e
			}
			opctx, cancel := context.WithTimeout(ctx, 45*time.Second)
			defer cancel()
			out, e := finance.ResolveProviderResult(opctx, s.DB, actor.Scope, connection, id, actor.UserID, kind, body, finance.StoredAdapterFactory(s.DB, actor.Scope))
			return endpoint.Result{Value: out}, e
		})
	}
}
