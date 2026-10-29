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
	"strings"
)

func registerProviderOperations(api huma.API, registry *endpoint.Registry, s Service) {
	base := "/api/financial-connections/{id}/issuance/{issuanceId}/operations"
	for _, spec := range []struct{ method, path, permission string }{{"POST", base, "finance:write"}, {"GET", base, "finance:read"}, {"POST", base + "/{operationId}/retry-lookup", "finance:write"}} {
		registry.Handle(api, spec.method, spec.path, spec.permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor := auth.From(ctx)
			if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
				return endpoint.Result{}, apierr.New(403, "operação exige escopo financeiro completo")
			}
			connection, issuance := chi.URLParam(r, "id"), chi.URLParam(r, "issuanceId")
			if validate.UUID(connection) != nil || validate.UUID(issuance) != nil {
				return endpoint.Result{}, apierr.New(400, "identificadores inválidos")
			}
			var body finance.ProviderOperationInput
			if spec.method == http.MethodPost {
				if e := apierr.DecodeJSON(r, &body); e != nil {
					return endpoint.Result{}, e
				}
			}
			var out any
			err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				var visible bool
				if e := tx.QueryRow(ctx, `select exists(select 1 from provider_issuance where id=$1 and financial_connection_id=$2)`, issuance, connection).Scan(&visible); e != nil {
					return e
				}
				if !visible {
					return apierr.New(404, "emissão não encontrada")
				}
				if spec.method == http.MethodGet {
					rows, e := tx.Objects(ctx, `select id,intent_id,remote_id,kind,payment_id,amount_cents,reason,state,attempts,next_attempt_at,last_error,created_by,created_at,updated_at from provider_operations where issuance_id=$1 order by created_at,id`, issuance)
					out = rows
					return e
				}
				if strings.HasSuffix(spec.path, "/retry-lookup") {
					id := chi.URLParam(r, "operationId")
					if validate.UUID(id) != nil || len(strings.TrimSpace(body.Reason)) < 10 || len(body.Reason) > 500 {
						return apierr.New(400, "operação ou motivo inválidos")
					}
					if e := finance.RequeueProviderOperationLookup(ctx, tx, actorTenant(ctx), issuance, id); e != nil {
						return e
					}
					out = map[string]any{"queued": true, "lookup_only": true}
					return record(ctx, tx, "finance.provider.retry_lookup", "provider_operation", id, map[string]any{"reason": body.Reason})
				}
				if !finance.EFISandboxEnabled() {
					return apierr.New(409, "operações Efí sandbox desabilitadas")
				}
				item, created, e := finance.PrepareProviderOperation(ctx, tx, issuance, connection, actor.UserID, body)
				if e != nil {
					return e
				}
				out = item
				if created {
					return record(ctx, tx, "finance.provider.operation_prepare", "provider_operation", item.Get("id"), map[string]any{"kind": body.Kind, "reason": body.Reason, "amount_cents": body.AmountCents})
				}
				return nil
			})
			return endpoint.Result{Value: out}, err
		})
	}
}
