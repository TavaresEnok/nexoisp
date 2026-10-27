package finance

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/finance/providers/efi"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

// Public delivery is an UNVERIFIED hint. No body amount/status/account is ever
// accepted as cash. Persist each delivery before ack: the PSP reuses one token
// across status changes, so deduping by token would silently lose later events.
func AcceptChargesNotice(ctx context.Context, database *db.DB, connection, token string) error {
	if !efi.ValidNotificationToken(token) {
		return apierr.New(400, "token de notificação inválido")
	}
	c, err := LookupConnection(ctx, database, connection)
	if err != nil {
		return err
	}
	if c.Get("provider") != "efi" || c.Get("environment") != "sandbox" || (c.Get("status") != "active" && c.Get("status") != "disabled") {
		return apierr.New(404, "conexão não disponível")
	}
	scope := tenancy.Scope{TenantID: jsonx.String(c.Get("tenant_id"))}
	delivery := uuid.NewString()
	raw, _ := json.Marshal(map[string]string{"kind": "efi_charges", "notification": token, "delivery": delivery})
	return database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var allowed bool
		if err := tx.QueryRow(ctx, `select exists(select 1 from financial_connections c join financial_credential_versions v on v.id=c.credential_version_id where c.id=$1 and v.kind='efi_charges')`, connection).Scan(&allowed); err != nil {
			return err
		}
		if !allowed {
			return apierr.New(404, "conexão Cobranças não disponível")
		}
		if err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,72))`, connection); err != nil {
			return err
		}
		var backlog int
		if err := tx.QueryRow(ctx, `select count(*) from provider_notices where financial_connection_id=$1 and status='unmatched'`, connection).Scan(&backlog); err != nil {
			return err
		}
		if backlog >= 1000 {
			return apierr.New(429, "fila de notificações aguardando processamento")
		}
		return tx.Exec(ctx, `insert into provider_notices(tenant_id,financial_connection_id,payload_hash,charge_id,payment_id,payload,status) values(app_tenant(),$1,$2,'notification-token',$3,$4::jsonb,'unmatched')`, connection, cryptox.SHA256(string(raw)), delivery, string(raw))
	})
}

type ChargesNotificationLookup func(context.Context, string, string) ([]efi.ChargeNotice, error)

func storedChargesNotificationLookup(database *db.DB, scope tenancy.Scope) ChargesNotificationLookup {
	return func(ctx context.Context, connection, token string) ([]efi.ChargeNotice, error) {
		var version string
		if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select credential_version_id from financial_connections where id=$1 and provider='efi' and environment='sandbox'`, connection).Scan(&version)
		}); err != nil {
			return nil, err
		}
		client, secret, err := LoadCredentialClient(ctx, database, scope, connection, version)
		if err != nil {
			return nil, err
		}
		defer client.Close()
		if secret.Kind != "efi_charges" {
			return nil, errors.New("incompatible notification credential")
		}
		return client.ChargeNotifications(ctx, token)
	}
}

// Snapshot the delivery IDs BEFORE HTTP. Only that snapshot can be acknowledged;
// another delivery arriving during lookup remains available for the next pass.
func ReconcileChargesNotices(ctx context.Context, database *db.DB, scope tenancy.Scope, lookup ChargesNotificationLookup) error {
	var deliveries []jsonx.Object
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var e error
		deliveries, e = tx.Objects(ctx, `select id,financial_connection_id,payload->>'notification' as token from provider_notices where status='unmatched' and payload->>'kind'='efi_charges' and (processed_at is null or processed_at<now()-interval '1 minute') order by created_at,id limit 100`)
		return e
	}); err != nil {
		return err
	}
	// Group same-token deliveries in this batch without suppressing later updates.
	type batch struct {
		connection, token string
		ids               []string
	}
	groups := map[string]*batch{}
	for _, v := range deliveries {
		connection, token := jsonx.String(v.Get("financial_connection_id")), jsonx.String(v.Get("token"))
		key := connection + ":" + token
		if groups[key] == nil {
			groups[key] = &batch{connection: connection, token: token}
		}
		groups[key].ids = append(groups[key].ids, jsonx.String(v.Get("id")))
	}
	for _, g := range groups {
		opctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		notices, lookupErr := lookup(opctx, g.connection, g.token)
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		state := "processed"
		if lookupErr != nil {
			state = "unmatched"
			var f *providers.Failure
			if errors.As(lookupErr, &f) && (f.Kind == providers.Conflict || f.Kind == providers.Rejected) {
				state = "review"
			}
		}
		if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if lookupErr == nil {
				for _, notice := range notices {
					rows, e := tx.Objects(ctx, `select id,request from provider_issuance where financial_connection_id=$1 and charge_id=$2 and product='bolix' and state='issued'`, g.connection, notice.ChargeID)
					if e != nil {
						return e
					}
					if len(rows) == 0 {
						state = "unmatched"
						continue
					}
					var r providers.Create
					raw, _ := json.Marshal(rows[0].Get("request"))
					if e = json.Unmarshal(raw, &r); e != nil {
						return e
					}
					if notice.CustomID != "" && notice.CustomID != efi.TxID(r) {
						state = "review"
						continue
					}
					// Schedules authoritative GET charge; token history never posts cash.
					if e = tx.Exec(ctx, `update provider_issuance set receipt_next_at=now() where id=$1`, rows[0].Get("id")); e != nil {
						return e
					}
				}
			}
			return tx.Exec(ctx, `update provider_notices set status=$2,processed_at=now() where id=any($1::uuid[]) and status='unmatched'`, g.ids, state)
		}); err != nil {
			return err
		}
	}
	return nil
}
