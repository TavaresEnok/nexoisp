package finance

import (
	"context"
	"encoding/json"
	"errors"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
	"time"
)

func ProcessProviderReceipts(ctx context.Context, database *db.DB, tenant string) error {
	// Suspending new dispatch must preserve lookup/receipt processing of old debt.
	if !EFISandboxEnabled() {
		return nil
	}
	scope := tenancy.Scope{TenantID: tenant}
	if err := ReconcileChargesNotices(ctx, database, scope, storedChargesNotificationLookup(database, scope)); err != nil {
		return err
	}
	return ReconcileProviderReceipts(ctx, database, scope, StoredAdapterFactory(database, scope))
}
func ReconcileProviderReceipts(ctx context.Context, database *db.DB, scope tenancy.Scope, factory AdapterFactory) error {
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error { return queueMatchedNotices(ctx, tx) }); err != nil {
		return err
	}
	var ids []string
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		rows, e := tx.Objects(ctx, `select j.id from provider_issuance j join financial_connections c on c.id=j.financial_connection_id where j.state='issued' and not j.receipt_review and j.credential_version_id is not null and j.receipt_next_at<=now() and c.provider='efi' and c.environment='sandbox' and c.status in ('active','disabled') order by j.receipt_next_at,j.id limit 100`)
		for _, r := range rows {
			ids = append(ids, r.Get("id").(string))
		}
		return e
	}); err != nil {
		return err
	}
	for _, id := range ids {
		opctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		var request providers.Create
		var version, charge string
		var options IssuanceOptions
		var snapshot providers.Snapshot
		err := database.WithScope(opctx, scope, func(tx *db.Tx) error {
			var raw, opts []byte
			if e := tx.QueryRow(opctx, `select request,credential_version_id,charge_id,product_options from provider_issuance where id=$1 and state='issued' and not receipt_review`, id).Scan(&raw, &version, &charge, &opts); e != nil {
				return e
			}
			if e := json.Unmarshal(raw, &request); e != nil {
				return e
			}
			return json.Unmarshal(opts, &options)
		})
		if err == nil {
			var a ConfiguredAdapter
			var cleanup func()
			a, cleanup, err = factory(opctx, request, version, options)
			if err == nil {
				snapshot, err = a.Lookup(opctx, providers.Reference{Scope: request.Scope, ChargeID: charge, IntentKey: request.IntentKey})
				cleanup()
			}
			if err == nil {
				if e := providers.ValidateIssued(request, snapshot.Charge); e != nil {
					err = &providers.Failure{Kind: providers.Conflict, Cause: e}
				}
			}
			if err == nil {
				if e := providers.ValidateSnapshot(providers.Reference{Scope: request.Scope, ChargeID: charge, IntentKey: request.IntentKey}, snapshot); e != nil {
					err = &providers.Failure{Kind: providers.Conflict, Cause: e}
				}
			}
		}
		if err == nil {
			err = database.WithScope(opctx, scope, func(tx *db.Tx) error {
				if e := lockIssuanceInvoice(opctx, tx, id); e != nil {
					return e
				}
				var eligible bool
				if e := tx.QueryRow(opctx, `select state='issued' and not receipt_review from provider_issuance where id=$1 for update`, id).Scan(&eligible); e != nil {
					return e
				}
				if !eligible {
					return nil
				}
				return applyProviderSnapshot(opctx, tx, scope.TenantID, id, request, snapshot)
			})
		}
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		code := ""
		review := false
		delay := 5 * time.Minute
		if err != nil {
			code = "local_failure"
			delay = time.Minute
			var f *providers.Failure
			if errors.As(err, &f) {
				code = "provider_" + string(f.Kind)
				review = f.Kind == providers.Conflict || f.Kind == providers.Rejected
				if f.RetryAfter > delay {
					delay = f.RetryAfter
				}
			}
			var conflict *apierr.Error
			if errors.As(err, &conflict) && conflict.Status == 409 {
				// A previously posted payment ID with different money/date is a
				// financial divergence, not a transient transport failure.
				code, review = "provider_conflict", true
			}
			if apierr.IsFinancialConflict(err) {
				code, review = "provider_conflict", true
			}
			if delay > time.Hour {
				delay = time.Hour
			}
		}
		if e := database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if e := lockIssuanceInvoice(ctx, tx, id); e != nil {
				return e
			}
			if review {
				if e := tx.Exec(ctx, `update provider_notices set status='review',processed_at=now() where financial_connection_id=$1 and charge_id=$2 and status='pending'`, request.Scope.ConnectionID, charge); e != nil {
					return e
				}
				if e := tx.Exec(ctx, `update invoices set status='reconciling',payment_methods=null,status_note='consulta do fornecedor exige revisão financeira' where id=$1 and status<>'canceled'`, request.InvoiceID); e != nil {
					return e
				}
			}
			return tx.Exec(ctx, `update provider_issuance set receipt_attempts=receipt_attempts+1,receipt_checked_at=now(),receipt_next_at=now()+make_interval(secs=>$2),receipt_last_error=nullif($3,''),receipt_review=receipt_review or $4 where id=$1`, id, int(delay.Seconds()), code, review)
		}); e != nil {
			return e
		}
	}
	return nil
}

// Caller holds the invoice before the issuance lock and validates the complete snapshot.
func applyProviderSnapshot(ctx context.Context, tx *db.Tx, tenant, id string, request providers.Create, snapshot providers.Snapshot) error {
	var superseded bool
	if e := tx.QueryRow(ctx, `select provider_issuance_id is distinct from $2::uuid from invoices where id=$1`, request.InvoiceID, id).Scan(&superseded); e != nil {
		return e
	}
	forceReview := superseded || snapshot.ReviewRequired || len(snapshot.Refunds) > 0 || snapshot.Status == "removed"
	for _, payment := range snapshot.Payments {
		duplicate, status, e := paymentWithReview(ctx, tx, request.InvoiceID, request.Scope.Provider, request.Scope.ConnectionID, paymentObject(payment), "reconciliation", forceReview)
		if e != nil {
			return e
		}
		if !duplicate {
			if e = SysAudit(ctx, tx, tenant, "finance.provider.receipt", "invoice", request.InvoiceID, map[string]any{"provider_issuance_id": id, "payment_id": payment.ID, "amount_cents": payment.AmountCents, "status": status}, "ok"); e != nil {
				return e
			}
		}
	}
	for _, refund := range snapshot.Refunds {
		if _, e := ApplyProviderRefund(ctx, tx, request.InvoiceID, request.Scope.ConnectionID, refund); e != nil {
			return e
		}
	}
	if forceReview {
		if e := tx.Exec(ctx, `update invoices set status='reconciling',payment_methods=null,status_note='fornecedor informa remoção ou devolução; revisar obrigação e saldo' where id=$1 and provider_issuance_id=$2 and status<>'canceled'`, request.InvoiceID, id); e != nil {
			return e
		}
	}
	if e := storeProviderArtifacts(ctx, tx, id, snapshot.Charge, snapshot.Status == "active"); e != nil {
		return e
	}
	return tx.Exec(ctx, `update provider_notices set status='processed',processed_at=now() where financial_connection_id=$1 and charge_id=$2 and status='pending'`, request.Scope.ConnectionID, snapshot.Charge.ID)
}
