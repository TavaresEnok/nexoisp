package leitura

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

func accountingScope(ctx context.Context) error {
	actor := auth.From(ctx)
	if actor == nil || actor.TenantID == "" || actor.SubscriberID != "" || actor.PopIDs != nil || actor.Support {
		return apierr.New(403, "a revisão de accounting exige escopo integral do provedor, fora do suporte")
	}
	return nil
}
func registerRadiusAccounting(api huma.API, r *endpoint.Registry, s Service) {
	r.Get(api, "/api/radius/accounting/events", "network:read", false, func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
		if e := accountingScope(ctx); e != nil {
			return endpoint.Result{}, e
		}
		status := req.URL.Query().Get("status")
		if status == "" {
			status = "quarantine"
		}
		if status != "quarantine" && status != "applied" && status != "ignored" {
			return endpoint.Result{}, apierr.New(400, "situação de accounting inválida")
		}
		before := int64(9223372036854775807)
		if raw := req.URL.Query().Get("before"); raw != "" {
			var e error
			before, e = strconv.ParseInt(raw, 10, 64)
			if e != nil || before <= 0 {
				return endpoint.Result{}, apierr.New(400, "cursor inválido")
			}
		}
		rows, e := s.rows(ctx, `select id::text as id,nas_device_id,host(source_ip) as source_ip,kind,session_id,username,event_at,status,reason,accounting_id::text,deliveries,reprocesses,received_at,last_received_at,review_reason,reviewed_at from radius_accounting_events where status=$1 and id<$2 order by id desc limit 100`, status, before)
		return endpoint.Result{Value: rows}, e
	})
	for _, action := range []string{"reconcile", "dismiss"} {
		r.Handle(api, http.MethodPost, "/api/radius/accounting/events/{event}/"+action, "network:write", func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
			if e := accountingScope(ctx); e != nil {
				return endpoint.Result{}, e
			}
			id, e := strconv.ParseInt(chi.URLParam(req, "event"), 10, 64)
			if e != nil || id <= 0 {
				return endpoint.Result{}, apierr.New(400, "evento inválido")
			}
			var input struct {
				Reason string `json:"reason"`
			}
			if e = apierr.DecodeJSON(req, &input); e != nil {
				return endpoint.Result{}, e
			}
			input.Reason = strings.TrimSpace(input.Reason)
			if n := utf8.RuneCountInString(input.Reason); n < 10 || n > 500 {
				return endpoint.Result{}, apierr.New(400, "informe um motivo de 10 a 500 caracteres")
			}
			var result string
			e = s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				var exists bool
				if err := tx.QueryRow(ctx, `select exists(select 1 from radius_accounting_events where id=$1)`, id).Scan(&exists); err != nil {
					return err
				}
				if !exists {
					return apierr.New(404, "evento não disponível")
				}
				query := `select radius_retry_accounting($1,$2,$3)`
				if action == "dismiss" {
					query = `select radius_dismiss_accounting($1,$2,$3)`
				}
				return tx.QueryRow(ctx, query, id, auth.From(ctx).UserID, input.Reason).Scan(&result)
			})
			return endpoint.Result{Value: map[string]any{"result": result, "sends_to_nas": false}}, e
		})
	}
}
