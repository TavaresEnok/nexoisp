package escrita

import (
	"context"
	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/validate"
)

func registerProviderNoticeReview(api huma.API, r *endpoint.Registry, s Service) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		path := "/api/financial-connections/{id}/notices"
		if method == http.MethodPost {
			path += "/{notice}/review"
		}
		r.Handle(api, method, path, "settings:manage", func(ctx context.Context, req *http.Request) (endpoint.Result, error) {
			actor := auth.From(ctx)
			if actor.Support || actor.SubscriberID != "" || actor.PopIDs != nil {
				return endpoint.Result{}, apierr.New(403, "triagem financeira exige escopo integral do provedor, fora do suporte")
			}
			connection := chi.URLParam(req, "id")
			if e := validate.UUID(connection); e != nil {
				return endpoint.Result{}, e
			}
			connection = uuid.MustParse(connection).String()
			var out any
			if method == http.MethodPost {
				notice := chi.URLParam(req, "notice")
				if e := validate.UUID(notice); e != nil {
					return endpoint.Result{}, e
				}
				var input struct {
					IntentID string `json:"intent_id"`
					Action   string `json:"action"`
					Reason   string `json:"reason"`
				}
				if e := apierr.DecodeJSON(req, &input); e != nil {
					return endpoint.Result{}, e
				}
				e := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
					v, e := finance.ReviewProviderNotice(ctx, tx, connection, notice, actor.UserID, input.IntentID, input.Action, input.Reason)
					out = v
					return e
				})
				return endpoint.Result{Value: out}, e
			}
			view := req.URL.Query().Get("view")
			if view == "" {
				view = "open"
			}
			if view != "open" && view != "acknowledged" && view != "processed" {
				return endpoint.Result{}, apierr.New(400, "filtro de triagem inválido")
			}
			var cursor any
			if before := req.URL.Query().Get("before"); before != "" {
				if e := validate.UUID(before); e != nil {
					return endpoint.Result{}, e
				}
				cursor = before
			}
			e := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				var exists bool
				if e := tx.QueryRow(ctx, `select exists(select 1 from financial_connections where id=$1)`, connection).Scan(&exists); e != nil {
					return e
				}
				if !exists {
					return apierr.New(404, "conexão não encontrada")
				}
				rows, e := tx.Objects(ctx, `with decisions as materialized (
      select distinct on(entity_id) entity_id,action,detail->>'reason' as reason,at from audit_events
      where entity_type='provider_notice' and action in ('finance.notice.ack','finance.notice.retry') and detail->>'connection_id'=$1::text order by entity_id,id desc)
     select n.id,n.status,n.charge_id,n.payment_id,n.created_at,n.processed_at,
       coalesce(d.action='finance.notice.ack',false) as acknowledged,d.reason as review_reason,d.at as reviewed_at
     from provider_notices n left join decisions d on d.entity_id=n.id::text
     where n.financial_connection_id=$1::uuid and (
       ($2='processed' and n.status='processed') or
       ($2='acknowledged' and n.status<>'processed' and d.action='finance.notice.ack') or
       ($2='open' and n.status<>'processed' and d.action is distinct from 'finance.notice.ack'))
     and ($3::uuid is null or (n.created_at,n.id)<(select x.created_at,x.id from provider_notices x where x.id=$3 and x.financial_connection_id=$1::uuid))
     order by n.created_at desc,n.id desc limit 100`, connection, view, cursor)
				out = rows
				return e
			})
			return endpoint.Result{Value: out}, e
		})
	}
}
