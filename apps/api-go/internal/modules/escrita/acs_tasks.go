package escrita

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"nexoisp/api-go/internal/acs"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
)

func registerACSTasks(api huma.API, registry *endpoint.Registry, s Service) {
	for _, portal := range []bool{false, true} {
		base := "/api/contracts/{id}/cpe/tasks"
		permission := "network:read"
		write := "network:operate"
		if portal {
			base = "/api/portal/cpe/{id}/tasks"
			permission = "portal:self"
			write = "portal:self"
		}
		registry.Get(api, base, permission, false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if validate.UUID(id) != nil {
				return endpoint.Result{}, apierr.New(400, "contrato inválido")
			}
			var out any
			err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				var exists bool
				if e := tx.QueryRow(ctx, `select exists(select 1 from contracts where id=$1)`, id).Scan(&exists); e != nil {
					return e
				}
				if !exists {
					return apierr.New(404, "contrato não encontrado")
				}
				items, e := acs.Tasks(ctx, tx, id)
				out = items
				return e
			})
			return endpoint.Result{Value: out}, err
		})
		registry.Handle(api, http.MethodPost, base+"/{taskId}/retry-lookup", write, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			contract, id := chi.URLParam(r, "id"), chi.URLParam(r, "taskId")
			if validate.UUID(contract) != nil || validate.UUID(id) != nil {
				return endpoint.Result{}, apierr.New(400, "identificadores inválidos")
			}
			var body struct {
				Reason string `json:"reason"`
			}
			if e := apierr.DecodeJSON(r, &body); e != nil {
				return endpoint.Result{}, e
			}
			body.Reason = strings.TrimSpace(body.Reason)
			if len(body.Reason) < 10 || len(body.Reason) > 500 {
				return endpoint.Result{}, apierr.New(400, "justificativa deve ter 10 a 500 caracteres")
			}
			err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				if e := acs.RetryTaskLookup(ctx, tx, contract, id); e != nil {
					return e
				}
				if os.Getenv("NEXO_GO_JOBS") == "1" && os.Getenv("NEXO_GO_JOB_ACS_TASKS") == "1" {
					if e := tx.EnqueuePeriodic(ctx, "ACS_TASKS", auth.From(ctx).TenantID); e != nil {
						return e
					}
				}
				return record(ctx, tx, "acs.task.retry_lookup", "acs_task", id, map[string]any{"reason": body.Reason, "lookup_only": true})
			})
			return endpoint.Result{Value: map[string]bool{"queued": true, "lookup_only": true}}, err
		})
	}
	registry.Handle(api, http.MethodPost, "/api/acs/ownership/assign", "tenants:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor := auth.From(ctx)
		if actor.Role != "saas_operator" || actor.Support || actor.TenantID != "" {
			return endpoint.Result{}, apierr.New(403, "atribuição CPE exige operador global fora do suporte")
		}
		if os.Getenv("NEXO_ACS_OWNERSHIP_ENABLED") != "1" || !acs.Configured() {
			return endpoint.Result{}, apierr.New(409, "atribuição ACS desabilitada")
		}
		var body struct {
			Tenant string `json:"tenant_id"`
			Device string `json:"acs_device_id"`
			Serial string `json:"serial"`
			Reason string `json:"reason"`
		}
		if e := apierr.DecodeJSON(r, &body); e != nil {
			return endpoint.Result{}, e
		}
		body.Reason = strings.TrimSpace(body.Reason)
		if uuid.Validate(body.Tenant) != nil || len(body.Device) < 3 || len(body.Device) > 200 || len(body.Serial) < 3 || len(body.Serial) > 64 || len(body.Reason) < 10 || len(body.Reason) > 500 {
			return endpoint.Result{}, apierr.New(400, "atribuição/justificativa inválida")
		}
		body.Tenant = uuid.MustParse(body.Tenant).String()
		scope, _ := tenancy.OperatorScope("gerenciar_provedores")
		attempt := uuid.NewString()
		if e := s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
			var exists bool
			if e := tx.QueryRow(ctx, `select exists(select 1 from tenants where id=$1 and status='active')`, body.Tenant).Scan(&exists); e != nil {
				return e
			}
			if !exists {
				return apierr.New(404, "provedor ativo não encontrado")
			}
			return record(ctx, tx, "acs.ownership.attempt", "acs_device", body.Device, map[string]any{"attempt_id": attempt, "tenant_id": body.Tenant, "reason": body.Reason, "outcome": "unknown"})
		}); e != nil {
			return endpoint.Result{}, e
		}
		opctx, cancel := context.WithTimeout(ctx, 35*time.Second)
		defer cancel()
		err := s.DB.WithScope(opctx, scope, func(tx *db.Tx) error {
			if e := tx.Exec(opctx, `select pg_advisory_xact_lock(hashtextextended($1,75))`, body.Device); e != nil {
				return e
			}
			return acs.AssignTenant(opctx, body.Device, body.Tenant, body.Serial)
		})
		outcome := "confirmed"
		if err != nil {
			outcome = "unconfirmed"
		}
		if e := s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
			return record(ctx, tx, "acs.ownership.result", "acs_device", body.Device, map[string]any{"attempt_id": attempt, "tenant_id": body.Tenant, "outcome": outcome})
		}); e != nil {
			return endpoint.Result{}, e
		}
		return endpoint.Result{Value: map[string]any{"assigned": err == nil, "tenant_id": body.Tenant}}, err
	})
}
