package finance

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
)

// SandboxIssuance is an internal preparation boundary, not an HTTP authorization
// boundary. No production job/route calls it. Caller authorization remains required
// before future wiring; keep the registry closed until all activation gates pass.
type SandboxIssuance struct{ DB *db.DB }
type ConfiguredAdapter interface {
	providers.Adapter
	ConfigurationHash() string
}
type Issuance struct {
	ID, State, ChargeID string
	Request             providers.Create
	ConfigHash          string
}

// Every issuance transaction takes the invoice lock before the journal lock,
// matching ordinary receipts and the reservation/payment guards in PostgreSQL.
func lockIssuanceInvoice(ctx context.Context, tx *db.Tx, id string) error {
	var invoice string
	if err := tx.QueryRow(ctx, `select invoice_id from provider_issuance where id=$1`, id).Scan(&invoice); err != nil {
		return err
	}
	return tx.QueryRow(ctx, `select id from invoices where id=$1 for update`, invoice).Scan(&invoice)
}

func (s SandboxIssuance) Prepare(ctx context.Context, scope tenancy.Scope, r providers.Create, configHash string) (Issuance, error) {
	var out Issuance
	hash, err := hex.DecodeString(configHash)
	if err != nil || len(hash) != 32 || r.Validate() != nil || r.Scope.TenantID != scope.TenantID || r.Scope.Provider != "efi" || r.Scope.Environment != "sandbox" {
		return out, errors.New("invalid sandbox issuance")
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return out, err
	}
	err = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
		var invoice string
		if err := tx.QueryRow(ctx, `select id from invoices where id=$1 for update`, r.InvoiceID).Scan(&invoice); err != nil {
			return err
		}
		// Scope and account cannot be selected from provider response/payload.
		var valid bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from financial_connections c join invoices i on i.tenant_id=c.tenant_id and i.company_id is not distinct from c.company_id where c.id=$1 and c.provider=$2 and c.environment=$3 and c.account_ref=$4 and c.status<>'disabled' and i.id=$5)`, r.Scope.ConnectionID, r.Scope.Provider, r.Scope.Environment, r.Scope.AccountRef, r.InvoiceID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return errors.New("invoice/account not visible or disabled")
		}
		if err := tx.Exec(ctx, `insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash) select $1,$2,$3,$4,$5::jsonb,$6 where not exists(select 1 from provider_issuance where invoice_id=$2)`, r.Scope.TenantID, r.InvoiceID, r.Scope.ConnectionID, r.IntentKey, string(raw), configHash); err != nil {
			return err
		}
		var stored []byte
		if err := tx.QueryRow(ctx, `select id,state,coalesce(charge_id,''),request,config_hash from provider_issuance where invoice_id=$1`, r.InvoiceID).Scan(&out.ID, &out.State, &out.ChargeID, &stored, &out.ConfigHash); err != nil {
			return err
		}
		if err := json.Unmarshal(stored, &out.Request); err != nil {
			return err
		}
		if out.Request != r || out.ConfigHash != configHash {
			return errors.New("invoice already has another frozen issuance")
		}
		return nil
	})
	return out, err
}

// Run commits uncertainty BEFORE network I/O. Any later attempt only looks up;
// even 404 never creates a second charge automatically. A crash before sending
// may therefore need operator review. This deliberately favors no duplicate debt.
func (s SandboxIssuance) Run(ctx context.Context, scope tenancy.Scope, id string, adapter ConfiguredAdapter) (providers.Charge, error) {
	var item Issuance
	var send bool
	err := s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := lockIssuanceInvoice(ctx, tx, id); err != nil {
			return err
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `select id,state,coalesce(charge_id,''),request,config_hash from provider_issuance where id=$1 for update`, id).Scan(&item.ID, &item.State, &item.ChargeID, &raw, &item.ConfigHash); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &item.Request); err != nil {
			return err
		}
		if item.Request.Scope.TenantID != scope.TenantID || item.Request.Scope.Environment != "sandbox" || item.Request.Scope.Provider != "efi" || adapter.ConfigurationHash() != item.ConfigHash {
			return errors.New("issuance scope/configuration mismatch")
		}
		if item.State == "review" {
			return errors.New("issuance requires operator review")
		}
		if item.State == "prepared" {
			var valid bool
			if err := tx.QueryRow(ctx, `select exists(select 1 from invoices i join financial_connections c on c.id=$2 and c.tenant_id=i.tenant_id and c.company_id is not distinct from i.company_id where i.id=$1 and i.provider_issuance_id=$6 and i.status='open' and i.gateway_charge_id is null and i.financial_connection_id is null and i.amount_cents=$3 and i.due_date=$4::date and i.fee_cents=0 and i.discount_cents=0 and c.status<>'disabled' and c.account_ref=$5 and not exists(select 1 from payments p where p.invoice_id=i.id))`, item.Request.InvoiceID, item.Request.Scope.ConnectionID, item.Request.Money.Cents, item.Request.DueDate, item.Request.Scope.AccountRef, id).Scan(&valid); err != nil {
				return err
			}
			if !valid {
				return errors.New("invoice changed or already billed; automatic issuance refused")
			}
			if err := tx.Exec(ctx, `update provider_issuance set state='uncertain' where id=$1`, id); err != nil {
				return err
			}
			send = true
		}
		return nil
	})
	if err != nil {
		return providers.Charge{}, err
	}
	if item.State == "issued" {
		return providers.Charge{Scope: item.Request.Scope, ID: item.ChargeID, IntentKey: item.Request.IntentKey, InvoiceID: item.Request.InvoiceID, Money: item.Request.Money}, nil
	}
	var charge providers.Charge
	if send {
		charge, err = adapter.CreateCharge(ctx, item.Request)
	} else {
		var snapshot providers.Snapshot
		snapshot, err = adapter.Lookup(ctx, providers.Reference{Scope: item.Request.Scope, IntentKey: item.Request.IntentKey})
		charge = snapshot.Charge
	}
	if err != nil {
		return providers.Charge{}, err
	} // uncertainty retained, including 404 and 5xx
	if err = providers.ValidateIssued(item.Request, charge); err != nil {
		return providers.Charge{}, err
	}
	// The journal transition binds the invoice in the same transaction (migration
	// 69). If commit/acknowledgement is lost, another Run reads uncertain and GETs,
	// or reads the already committed response without issuing again.
	err = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := lockIssuanceInvoice(ctx, tx, id); err != nil {
			return err
		}
		var state, storedID string
		if err := tx.QueryRow(ctx, `select state,coalesce(charge_id,'') from provider_issuance where id=$1 for update`, id).Scan(&state, &storedID); err != nil {
			return err
		}
		if state == "issued" {
			if storedID != charge.ID {
				return errors.New("provider returned conflicting charge IDs")
			}
			return nil
		}
		if state != "uncertain" {
			return errors.New("issuance no longer eligible for automatic confirmation")
		}
		return tx.Exec(ctx, `update provider_issuance set state='issued',charge_id=$2 where id=$1`, id, charge.ID)
	})
	return charge, err
}
