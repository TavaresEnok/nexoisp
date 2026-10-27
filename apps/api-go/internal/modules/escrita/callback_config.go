package escrita

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/validate"
)

func registerCallbackConfig(api huma.API, registry *endpoint.Registry, s Service) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		registry.Handle(api, method, "/api/financial-connections/{id}/callback", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor := auth.From(ctx)
			if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
				return endpoint.Result{}, apierr.New(403, "configuração exige escopo completo")
			}
			id := chi.URLParam(r, "id")
			if validate.UUID(id) != nil {
				return endpoint.Result{}, apierr.New(400, "conexão inválida")
			}
			var kind, version string
			var inbox, last any
			err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				rows, e := tx.Objects(ctx, `select v.kind,v.id from financial_connections c join financial_credential_versions v on v.id=c.credential_version_id where c.id=$1 and c.provider='efi' and c.environment='sandbox'`, id)
				if e != nil {
					return e
				}
				if len(rows) == 0 {
					return apierr.New(404, "conexão sandbox com credencial não encontrada")
				}
				kind = rows[0].Get("kind").(string)
				version = rows[0].Get("id").(string)
				counts, e := tx.Objects(ctx, `select count(*)::int as total,count(*) filter(where status in ('pending','unmatched'))::int as pending,count(*) filter(where status='review')::int as review,max(created_at) as last_received_at,max(processed_at) filter(where status='processed') as last_processed_at from provider_notices where financial_connection_id=$1`, id)
				if e != nil {
					return e
				}
				inbox = counts[0]
				audits, e := tx.Objects(ctx, `select action,at,detail->>'outcome' as outcome from audit_events where entity_id=$1 and action in ('finance.callback.attempt','finance.callback.result') order by at desc,id desc limit 1`, id)
				if e != nil {
					return e
				}
				if len(audits) > 0 {
					last = audits[0]
				}
				return nil
			})
			if err != nil {
				return endpoint.Result{}, err
			}
			callback, e := finance.PixCallbackURL(id)
			if kind == "efi_charges" {
				callback, e = finance.ChargesCallbackURL(id)
			}
			if e != nil {
				return endpoint.Result{}, apierr.New(409, "origem HTTPS de callback inválida no servidor")
			}
			listenerReady := os.Getenv("NEXO_GO_EFI_WEBHOOK_ADDR") != "" && os.Getenv("NEXO_GO_EFI_WEBHOOK_CERT") != "" && os.Getenv("NEXO_GO_EFI_WEBHOOK_KEY") != "" && os.Getenv("NEXO_GO_EFI_WEBHOOK_PROVIDER_CERTS") != ""
			enabled := finance.EFISandboxEnabled() && os.Getenv("NEXO_GO_EFI_CALLBACK_REGISTRATION") == "1" && callback != "" && listenerReady && kind == "efi_pix"
			if method == http.MethodGet {
				return endpoint.Result{Value: map[string]any{"kind": kind, "url": callback, "registration_enabled": enabled, "charges_receiver_enabled": finance.EFISandboxEnabled() && os.Getenv("NEXO_GO_EFI_CHARGES_CALLBACK_ENABLED") == "1", "inbox": inbox, "last_registration": last}}, nil
			}
			if !enabled {
				return endpoint.Result{}, apierr.New(409, "registro Pix exige callback HTTPS/mTLS e registro sandbox habilitados no servidor; Cobranças usa URL na emissão")
			}
			var body struct {
				Reason  string `json:"reason"`
				Replace bool   `json:"replace_existing"`
			}
			if err := apierr.DecodeJSON(r, &body); err != nil {
				return endpoint.Result{}, err
			}
			body.Reason = strings.TrimSpace(body.Reason)
			if len(body.Reason) < 10 || len(body.Reason) > 500 {
				return endpoint.Result{}, apierr.New(400, "justificativa deve ter 10 a 500 caracteres")
			}
			attempt := uuid.NewString()
			if err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				return record(ctx, tx, "finance.callback.attempt", "financial_connection", id, map[string]any{"attempt_id": attempt, "reason": body.Reason, "replace_existing": body.Replace, "outcome": "unknown"})
			}); err != nil {
				return endpoint.Result{}, err
			}
			opctx, cancel := context.WithTimeout(ctx, 40*time.Second)
			defer cancel()
			// Credential rotation uses the same account row lock. A bounded
			// registration cannot silently configure the previous Pix key while
			// the current credential version changes underneath it.
			err = s.DB.WithScope(opctx, actor.Scope, func(tx *db.Tx) error {
				var current string
				if e := tx.QueryRow(opctx, `select credential_version_id from financial_connections where id=$1 for update`, id).Scan(&current); e != nil {
					return e
				}
				if current != version {
					return apierr.New(409, "credencial alterada; consulte a configuração novamente")
				}
				client, secret, e := finance.LoadCredentialClient(opctx, s.DB, actor.Scope, id, version)
				if e != nil {
					return e
				}
				defer client.Close()
				return client.RegisterPixWebhook(opctx, secret.PixKey, callback, body.Replace)
			})
			outcome := "confirmed"
			if err != nil {
				outcome = "unconfirmed"
			}
			if auditErr := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				return record(ctx, tx, "finance.callback.result", "financial_connection", id, map[string]any{"attempt_id": attempt, "outcome": outcome})
			}); auditErr != nil {
				return endpoint.Result{}, auditErr
			}
			if err != nil {
				var f *providers.Failure
				if errors.As(err, &f) && f.Kind == providers.Conflict {
					return endpoint.Result{}, apierr.New(409, "callback existente ou leitura divergente; confira antes de autorizar substituição")
				}
				return endpoint.Result{}, apierr.New(502, "registro sem confirmação; consulte antes de repetir")
			}
			return endpoint.Result{Value: map[string]any{"confirmed": true, "url": callback}}, nil
		})
	}
}
