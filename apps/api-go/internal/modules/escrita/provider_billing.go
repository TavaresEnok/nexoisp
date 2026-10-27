package escrita

import (
	"context"
	"net/http"
	"os"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/validate"
)

// Financial operators need a narrowly scoped account projection, not access to
// settings or the credential vault. No ciphertext, API identifier, certificate,
// debtor payload or OAuth metadata is selected here.
func registerInvoiceProviderBilling(api huma.API, registry *endpoint.Registry, s Service) {
	registry.Get(api, "/api/invoices/{id}/provider-billing", "finance:read", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor := auth.From(ctx)
		if actor.SubscriberID != "" || len(actor.PopIDs) > 0 {
			return endpoint.Result{}, apierr.New(403, "operação de cobrança exige escopo financeiro completo")
		}
		id := chi.URLParam(r, "id")
		if err := validate.UUID(id); err != nil {
			return endpoint.Result{}, err
		}
		out := map[string]any{"sandbox_enabled": finance.EFISandboxEnabled(), "dispatch_enabled": finance.EFIDispatchEnabled(), "operations_write_enabled": finance.EFISandboxEnabled() && os.Getenv("NEXO_GO_EFI_OPERATIONS_WRITE") == "1"}
		err := s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			var exists bool
			if err := tx.QueryRow(ctx, `select exists(select 1 from invoices where id=$1)`, id).Scan(&exists); err != nil {
				return err
			}
			if !exists {
				return apierr.New(404, "fatura não encontrada")
			}
			accounts, err := tx.Objects(ctx, `select c.id,c.name,c.provider,c.environment,c.is_default,
			 case when v.kind='efi_pix' then array['pix_cob','pix_cobv'] else array['bolix'] end as products
			 from financial_connections c join invoices i on i.tenant_id=c.tenant_id and i.company_id is not distinct from c.company_id
			 join financial_credential_versions v on v.id=c.credential_version_id and v.financial_connection_id=c.id
			 where i.id=$1 and c.status='active' and c.provider='efi' and c.environment='sandbox'
			 and (v.kind='efi_charges' or (v.kind='efi_pix' and v.certificate_expires_at>now()))
			 order by c.is_default desc,c.name,c.id`, id)
			if err != nil {
				return err
			}
			out["accounts"] = accounts
			issuances, err := tx.Objects(ctx, `select j.id,j.financial_connection_id,j.request->>'intent_key' as intent_id,j.state,j.product,j.charge_id,j.attempts,j.last_error,j.receipt_checked_at,j.receipt_review,j.receipt_last_error,j.created_at,j.updated_at,c.name as account_name,c.status as account_status from provider_issuance j join financial_connections c on c.id=j.financial_connection_id where j.invoice_id=$1 order by j.created_at,j.id`, id)
			if err != nil {
				return err
			}
			out["issuances"] = issuances
			operations, err := tx.Objects(ctx, `select id,issuance_id,intent_id,kind,payment_id,amount_cents,reason,state,attempts,last_error,created_at,updated_at from provider_operations where invoice_id=$1 order by created_at,id`, id)
			if err != nil {
				return err
			}
			out["operations"] = operations
			payments, err := tx.Objects(ctx, `select p.id,p.amount_cents,p.paid_at,
			 p.amount_cents-coalesce((select sum(r.amount_cents) from payments r where r.reversal_of=p.id),0)
			 -coalesce((select sum(o.amount_cents) from provider_operations o where o.payment_id=p.id and o.state in ('prepared','uncertain','review')),0) as refundable_cents
			 from payments p join provider_issuance j on j.invoice_id=p.invoice_id and j.financial_connection_id=p.financial_connection_id
			 where p.invoice_id=$1 and p.kind='payment' and p.source<>'manual' and p.method='pix' and j.state='issued' and j.product in ('pix_cob','pix_cobv') order by p.paid_at,p.id`, id)
			out["refund_payments"] = payments
			return err
		})
		return endpoint.Result{Value: out}, err
	})
}
