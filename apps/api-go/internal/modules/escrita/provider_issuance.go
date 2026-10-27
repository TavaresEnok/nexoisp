package escrita

import (
	"context"
	"encoding/json"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/validate"
	"strings"
	"time"
)

func registerProviderIssuance(api huma.API, registry *endpoint.Registry, s Service) {
	registerInvoiceProviderBilling(api, registry, s)
	registry.Handle(api, http.MethodPost, "/api/financial-connections/{id}/issuance/{issuanceId}/retry-lookup", "finance:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor := auth.From(ctx)
		if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
			return endpoint.Result{}, apierr.New(403, "revisão exige escopo financeiro completo")
		}
		connection, id := chi.URLParam(r, "id"), chi.URLParam(r, "issuanceId")
		if validate.UUID(connection) != nil || validate.UUID(id) != nil {
			return endpoint.Result{}, apierr.New(400, "identificadores inválidos")
		}
		var body struct {
			Reason string `json:"reason"`
		}
		if err := apierr.DecodeJSON(r, &body); err != nil {
			return endpoint.Result{}, err
		}
		body.Reason = strings.TrimSpace(body.Reason)
		if len(body.Reason) < 10 || len(body.Reason) > 500 {
			return endpoint.Result{}, apierr.New(400, "informe motivo da consulta entre 10 e 500 caracteres")
		}
		err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			if err := finance.RetryProviderLookup(ctx, tx, id, connection); err != nil {
				return err
			}
			return record(ctx, tx, "finance.issuance.retry_lookup", "provider_issuance", id, map[string]any{"reason": body.Reason, "lookup_only": true})
		})
		return endpoint.Result{Value: map[string]any{"queued": true, "lookup_only": true}}, err
	})
	registry.Handle(api, http.MethodPost, "/api/financial-connections/{id}/issuance", "finance:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor := auth.From(ctx)
		if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
			return endpoint.Result{}, apierr.New(403, "emissão exige escopo financeiro completo")
		}
		if !finance.EFISandboxEnabled() {
			return endpoint.Result{}, apierr.New(409, "emissão Efí sandbox desabilitada")
		}
		connection := chi.URLParam(r, "id")
		if err := validate.UUID(connection); err != nil {
			return endpoint.Result{}, err
		}
		var body struct {
			InvoiceID string                  `json:"invoice_id"`
			IntentID  string                  `json:"intent_id"`
			Options   finance.IssuanceOptions `json:"options"`
		}
		if err := apierr.DecodeJSON(r, &body); err != nil {
			return endpoint.Result{}, err
		}
		if validate.UUID(body.InvoiceID) != nil || validate.UUID(body.IntentID) != nil {
			return endpoint.Result{}, apierr.New(400, "fatura e intenção devem ser UUIDs válidos")
		}
		// Recovery's search window is server-owned, never selected by the client.
		if body.Options.IssuedOn != "" {
			return endpoint.Result{}, apierr.New(400, "data de emissão é definida pelo servidor")
		}
		if body.Options.Product == "pix_cob" && body.Options.Expiration == 0 {
			body.Options.Expiration = 3600
		}
		var request providers.Create
		var credential string
		err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			var exists bool
			if err := tx.QueryRow(ctx, `select exists(select 1 from financial_connections c join invoices i on i.tenant_id=c.tenant_id and i.company_id is not distinct from c.company_id where c.id=$1 and i.id=$2 and c.status='active' and c.provider='efi' and c.environment='sandbox' and c.credential_version_id is not null)`, connection, body.InvoiceID).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return apierr.New(404, "fatura ou conexão sandbox ativa não disponível nesta empresa")
			}
			request.IntentKey = body.IntentID
			request.InvoiceID = body.InvoiceID
			request.Money.Currency = "BRL"
			if err := tx.QueryRow(ctx, `select c.id,c.tenant_id,c.provider,c.environment,c.account_ref,i.amount_cents,i.due_date::text,c.credential_version_id from financial_connections c join invoices i on i.tenant_id=c.tenant_id where c.id=$1 and i.id=$2`, connection, body.InvoiceID).Scan(&request.Scope.ConnectionID, &request.Scope.TenantID, &request.Scope.Provider, &request.Scope.Environment, &request.Scope.AccountRef, &request.Money.Cents, &request.DueDate, &credential); err != nil {
				return err
			}
			rows, err := tx.Objects(ctx, `select financial_connection_id,credential_version_id,product_options from provider_issuance where invoice_id=$1`, body.InvoiceID)
			if err != nil {
				return err
			}
			if len(rows) > 0 {
				if rows[0].Get("financial_connection_id") != connection {
					return apierr.New(409, "fatura já reservada por outra conexão")
				}
				if value, ok := rows[0].Get("credential_version_id").(string); ok {
					credential = value
				} else {
					return apierr.New(409, "intenção anterior sem versão de credencial exige revisão")
				}
				if body.Options.Product == "bolix" && body.Options.IssuedOn == "" {
					raw, _ := json.Marshal(rows[0].Get("product_options"))
					var old finance.IssuanceOptions
					if err = json.Unmarshal(raw, &old); err != nil {
						return err
					}
					body.Options.IssuedOn = old.IssuedOn
				}
			}
			if body.Options.Product == "bolix" && body.Options.IssuedOn == "" {
				zone, _ := time.LoadLocation("America/Sao_Paulo")
				body.Options.IssuedOn = time.Now().In(zone).Format("2006-01-02")
			}
			return nil
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		item, err := (finance.SandboxIssuance{DB: s.DB, OnPrepared: func(ctx context.Context, tx *db.Tx, item finance.Issuance) error {
			return record(ctx, tx, "finance.issuance.prepare", "provider_issuance", item.ID, map[string]any{"invoice_id": item.Request.InvoiceID, "credential_version_id": item.CredentialID, "product": body.Options.Product})
		}}).PrepareProduct(ctx, actor.Scope, request, body.Options, credential)
		if err != nil {
			return endpoint.Result{}, err
		}
		return endpoint.Result{Value: map[string]any{"id": item.ID, "state": item.State, "invoice_id": body.InvoiceID, "credential_version_id": item.CredentialID, "dispatch_enabled": finance.EFIDispatchEnabled()}}, nil
	})
	registry.Get(api, "/api/financial-connections/{id}/issuance/{issuanceId}", "finance:read", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor := auth.From(ctx)
		if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
			return endpoint.Result{}, apierr.New(403, "consulta de emissão exige escopo completo")
		}
		connection, id := chi.URLParam(r, "id"), chi.URLParam(r, "issuanceId")
		if validate.UUID(connection) != nil || validate.UUID(id) != nil {
			return endpoint.Result{}, apierr.New(400, "identificadores inválidos")
		}
		var out any
		err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			rows, e := tx.Objects(ctx, `select id,invoice_id,state,product,credential_version_id,charge_id,attempts,next_attempt_at,last_error,receipt_attempts,receipt_next_at,receipt_checked_at,receipt_last_error,receipt_review,created_at,updated_at from provider_issuance where id=$1 and financial_connection_id=$2`, id, connection)
			if e != nil {
				return e
			}
			if len(rows) == 0 {
				return apierr.New(404, "emissão não encontrada")
			}
			out = rows[0]
			return nil
		})
		return endpoint.Result{Value: out}, err
	})
}
