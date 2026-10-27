package finance

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"time"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/finance/providers/efi"
	"nexoisp/api-go/internal/tenancy"
)

type IssuanceOptions struct {
	Product         string             `json:"product"`
	Expiration      int                `json:"expiration_seconds,omitempty"`
	ValidDays       int                `json:"valid_days,omitempty"`
	Debtor          efi.Debtor         `json:"debtor,omitempty"`
	Customer        efi.BilletCustomer `json:"customer,omitempty"`
	IssuedOn        string             `json:"issued_on,omitempty"`
	NotificationURL string             `json:"notification_url,omitempty"`
}
type AdapterFactory func(context.Context, providers.Create, string, IssuanceOptions) (ConfiguredAdapter, func(), error)

func StoredAdapterFactory(database *db.DB, scope tenancy.Scope) AdapterFactory {
	return func(ctx context.Context, r providers.Create, version string, o IssuanceOptions) (ConfiguredAdapter, func(), error) {
		c, secret, err := LoadCredentialClient(ctx, database, scope, r.Scope.ConnectionID, version)
		if err != nil {
			return nil, func() {}, err
		}
		var a ConfiguredAdapter
		switch o.Product {
		case "pix_cob":
			a, err = efi.NewImmediate(c, r, secret.PixKey, o.Expiration)
		case "pix_cobv":
			a, err = efi.NewDue(c, r, secret.PixKey, o.Debtor, o.ValidDays)
		case "bolix":
			var billet *efi.Bolix
			billet, err = efi.NewBolix(c, r, o.Customer, o.IssuedOn)
			if err == nil {
				err = billet.SetNotificationURL(o.NotificationURL)
				a = billet
			}
		default:
			err = errors.New("unsupported issuance product")
		}
		if err != nil {
			c.Close()
			return nil, func() {}, err
		}
		return a, c.Close, nil
	}
}
func EFISandboxEnabled() bool { return os.Getenv("NEXO_GO_EFI_SANDBOX_ENABLED") == "1" }
func EFIDispatchEnabled() bool {
	return EFISandboxEnabled() && os.Getenv("NEXO_GO_EFI_DISPATCH") == "1"
}

// Preparation validates against actual stored credential/payment semantics but
// performs no provider HTTP request. Operational routes require an explicit gate.
func (s SandboxIssuance) PrepareProduct(ctx context.Context, scope tenancy.Scope, r providers.Create, o IssuanceOptions, credential string) (Issuance, error) {
	factory := StoredAdapterFactory(s.DB, scope)
	a, close, err := factory(ctx, r, credential, o)
	if err != nil {
		return Issuance{}, apierr.New(400, "produto ou credenciais incompatíveis com a cobrança")
	}
	defer close()
	return s.prepareOptions(ctx, scope, r, a.ConfigurationHash(), credential, o)
}
func ProcessProviderIssuance(ctx context.Context, database *db.DB, tenant string) error {
	if !EFISandboxEnabled() {
		return nil
	}
	scope := tenancy.Scope{TenantID: tenant}
	return dispatchPending(ctx, database, scope, StoredAdapterFactory(database, scope), EFIDispatchEnabled())
}

// DispatchPending is an internal worker boundary. Production callers must pass
// through ProcessProviderIssuance's gates; injected factories exist in Go tests,
// never as URLs/provider names configurable through the product.
func DispatchPending(ctx context.Context, database *db.DB, scope tenancy.Scope, factory AdapterFactory) error {
	return dispatchPending(ctx, database, scope, factory, true)
}
func dispatchPending(ctx context.Context, database *db.DB, scope tenancy.Scope, factory AdapterFactory, allowCreate bool) error {
	var ids []string
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		rows, e := tx.Objects(ctx, `select j.id from provider_issuance j join financial_connections c on c.id=j.financial_connection_id where ((j.state='prepared' and $1 and c.status='active') or (j.state='uncertain' and c.status in ('active','disabled'))) and j.credential_version_id is not null and j.next_attempt_at<=now() and c.provider='efi' and c.environment='sandbox' order by j.next_attempt_at,j.id limit 100`, allowCreate)
		for _, r := range rows {
			ids = append(ids, r.Get("id").(string))
		}
		return e
	})
	if err != nil {
		return err
	}
	for _, id := range ids {
		attemptCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		var r providers.Create
		var version string
		var options IssuanceOptions
		e := database.WithScope(attemptCtx, scope, func(tx *db.Tx) error {
			var raw, opts []byte
			if e := tx.QueryRow(attemptCtx, `select request,credential_version_id,product_options from provider_issuance where id=$1 and state in ('prepared','uncertain')`, id).Scan(&raw, &version, &opts); e != nil {
				return e
			}
			if e := json.Unmarshal(raw, &r); e != nil {
				return e
			}
			return json.Unmarshal(opts, &options)
		})
		if e == nil {
			var a ConfiguredAdapter
			var close func()
			a, close, e = factory(attemptCtx, r, version, options)
			if e == nil {
				_, e = (SandboxIssuance{DB: database}).Run(attemptCtx, scope, id, a)
				close()
			}
		}
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		code := ""
		delay := time.Minute
		review := false
		if e != nil {
			code = "local_failure"
			var f *providers.Failure
			if errors.As(e, &f) {
				code = "provider_" + string(f.Kind)
				if f.RetryAfter > delay {
					delay = f.RetryAfter
				}
				review = f.Kind == providers.Conflict || f.Kind == providers.Rejected
			}
			if delay > time.Hour {
				delay = time.Hour
			}
			slog.Warn("provider issuance pending", "tenant", scope.TenantID, "issuance", id, "reason", code)
		}
		// Persist only bounded classifications, never provider errors or payloads.
		if err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := lockIssuanceInvoice(ctx, tx, id); err != nil {
				return err
			}
			if review {
				if err := tx.Exec(ctx, `update provider_issuance set state='review' where id=$1 and state='uncertain'`, id); err != nil {
					return err
				}
			}
			return tx.Exec(ctx, `update provider_issuance set attempts=attempts+1,last_error=case when state='issued' then null else nullif($2,'') end,next_attempt_at=now()+make_interval(secs=>$3) where id=$1`, id, code, int(delay.Seconds()))
		}); err != nil {
			return err
		}
	}
	return nil
}
