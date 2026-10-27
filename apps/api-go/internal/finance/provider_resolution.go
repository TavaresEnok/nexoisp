package finance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

type ResolutionInput struct {
	IntentID string `json:"intent_id"`
	Reason   string `json:"reason"`
}

// ResolveProviderResult never sends a financial mutation. The HTTP boundary uses
// only StoredAdapterFactory: URLs, snapshots and account identity are not input.
// A not-found, timeout or unbound response is never proof that issuance failed.
func ResolveProviderResult(ctx context.Context, database *db.DB, scope tenancy.Scope, connection, id, actor, kind string, b ResolutionInput, factory AdapterFactory) (jsonx.Object, error) {
	b.Reason = strings.TrimSpace(b.Reason)
	if uuid.Validate(b.IntentID) != nil || utf8.RuneCountInString(b.Reason) < 10 || utf8.RuneCountInString(b.Reason) > 500 || (kind != "resolve" && kind != "reissue") {
		return nil, apierr.New(400, "intenção e justificativa de 10 a 500 caracteres obrigatórias")
	}
	b.IntentID = uuid.MustParse(b.IntentID).String()
	if scope.IsOperator() || scope.SubscriberID != "" || len(scope.PopIDs) > 0 {
		return nil, apierr.New(403, "resolução exige escopo financeiro completo")
	}
	var r providers.Create
	var options IssuanceOptions
	var version, hash, charge, state string
	var replay jsonx.Object
	// Check a committed intention before accessing the PSP, including lost ACKs.
	checkReplay := func(tx *db.Tx) error {
		rows, e := tx.Objects(ctx, `select e.id,e.issuance_id,e.kind,e.created_by,e.reason,e.status,(select j.id from provider_issuance j where j.resolution_id=e.id) as successor_id from provider_resolution_evidence e where e.intent_id=$1`, b.IntentID)
		if e != nil {
			return e
		}
		if len(rows) == 0 {
			return nil
		}
		p := rows[0]
		if p.Get("issuance_id") != id || p.Get("kind") != kind || p.Get("created_by") != actor || p.Get("reason") != b.Reason {
			return apierr.New(409, "intenção de resolução já utilizada com outros dados")
		}
		replay = p
		return nil
	}
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		var raw, opts []byte
		rows, e := tx.Objects(ctx, `select id from provider_issuance where id=$1 and financial_connection_id=$2`, id, connection)
		if e != nil {
			return e
		}
		if len(rows) == 0 {
			return apierr.New(404, "emissão não encontrada")
		}
		if e = checkReplay(tx); e != nil || replay != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `select request,product_options,coalesce(credential_version_id::text,''),config_hash,coalesce(charge_id,''),state from provider_issuance where id=$1`, id).Scan(&raw, &opts, &version, &hash, &charge, &state); e != nil {
			return e
		}
		if e = json.Unmarshal(raw, &r); e != nil {
			return e
		}
		return json.Unmarshal(opts, &options)
	})
	if err != nil || replay != nil {
		return replay, err
	}
	if version == "" || state == "prepared" || (kind == "reissue" && state != "issued") {
		return nil, apierr.New(409, "emissão sem resultado consultável autenticado")
	}
	observed := time.Now().UTC()
	adapter, closeAdapter, err := factory(ctx, r, version, options)
	if err != nil {
		return nil, apierr.New(409, "credencial original indisponível; reserva preservada")
	}
	defer closeAdapter()
	if adapter.ConfigurationHash() != hash {
		return nil, apierr.New(409, "configuração difere da intenção original; reserva preservada")
	}
	snapshot, err := adapter.Lookup(ctx, providers.Reference{Scope: r.Scope, ChargeID: charge, IntentKey: r.IntentKey})
	if err != nil {
		return nil, apierr.New(409, "consulta autenticada inconclusiva; reserva preservada")
	}
	if providers.ValidateIssued(r, snapshot.Charge) != nil || providers.ValidateSnapshot(providers.Reference{Scope: r.Scope, ChargeID: charge, IntentKey: r.IntentKey}, snapshot) != nil || snapshot.Status == "" || (snapshot.Status == "paid" && len(snapshot.Payments) == 0) || snapshot.ReviewRequired || len(snapshot.Refunds) > 0 {
		return nil, apierr.New(409, "evidência divergente, incompleta ou com devoluções; revisão preservada")
	}
	var received int64
	seen := map[string]bool{}
	for _, p := range snapshot.Payments {
		if !seen[p.ID] {
			received += p.AmountCents
			seen[p.ID] = true
		}
	}
	if received > r.Money.Cents || (snapshot.Status == "paid" && received != r.Money.Cents) {
		return nil, apierr.New(409, "total recebido divergente; revisão preservada")
	}
	if kind == "reissue" && (snapshot.Status != "removed" || len(snapshot.Payments) > 0) {
		return nil, apierr.New(409, "reemissão exige remoção comprovada sem recebimentos")
	}
	// A replacement has its own server-owned recovery window. Bolix searches by
	// creation date after an uncertain POST; copying an old generation's date
	// would hide a successfully created replacement from lookup-only recovery.
	successor := r
	successor.IntentKey = b.IntentID
	successorOptions := options
	successorHash := hash
	if kind == "reissue" && options.Product == "bolix" {
		zone, e := time.LoadLocation("America/Sao_Paulo")
		if e != nil {
			return nil, e
		}
		successorOptions.IssuedOn = time.Now().In(zone).Format("2006-01-02")
		next, cleanup, e := factory(ctx, successor, version, successorOptions)
		if e != nil {
			return nil, apierr.New(409, "configuração da reemissão indisponível; reserva preservada")
		}
		successorHash = next.ConfigurationHash()
		cleanup()
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(raw)
	var out jsonx.Object
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := lockIssuanceInvoice(ctx, tx, id); e != nil {
			return e
		}
		if e := checkReplay(tx); e != nil {
			return e
		}
		if replay != nil {
			out = replay
			return nil
		}
		var current bool
		if e := tx.QueryRow(ctx, `select i.provider_issuance_id=j.id and i.status<>'canceled' from invoices i join provider_issuance j on j.invoice_id=i.id where j.id=$1 for update of j`, id).Scan(&current); e != nil {
			return e
		}
		if !current {
			return apierr.New(409, "somente a geração atual pode ser resolvida ou substituída")
		}
		if time.Since(observed) > 2*time.Minute {
			return apierr.New(409, "evidência expirada; consulte novamente")
		}
		// Do not clear a reservation while a cancel/refund may still have succeeded.
		var held bool
		if e := tx.QueryRow(ctx, `select exists(select 1 from provider_operations where invoice_id=$1 and state in ('prepared','uncertain','review')) or exists(select 1 from payments where invoice_id=$1 and (kind='reversal' or source='manual' or financial_connection_id is distinct from $2::uuid)) or exists(select 1 from gateway_events where financial_connection_id=$2 and charge_id=$3 and status='divergent')`, r.InvoiceID, connection, snapshot.Charge.ID).Scan(&held); e != nil {
			return e
		}
		if held {
			return apierr.New(409, "operações, estornos ou divergências pendentes; revisão preservada")
		}
		// Every local receipt must be backed by this exact authenticated snapshot.
		local, e := tx.Objects(ctx, `select gateway_payment_id from payments where invoice_id=$1`, r.InvoiceID)
		if e != nil {
			return e
		}
		proven := map[string]bool{}
		for _, p := range snapshot.Payments {
			proven[p.ID] = true
		}
		for _, p := range local {
			v, _ := p.Get("gateway_payment_id").(string)
			if !proven[v] {
				return apierr.New(409, "recebimento local ausente da evidência; revisão preservada")
			}
		}
		if kind == "reissue" && len(local) > 0 {
			return apierr.New(409, "fatura já possui recebimentos")
		}
		var nowState, nowCharge string
		if e = tx.QueryRow(ctx, `select state,coalesce(charge_id,'') from provider_issuance where id=$1`, id).Scan(&nowState, &nowCharge); e != nil {
			return e
		}
		if nowCharge != "" && nowCharge != snapshot.Charge.ID {
			return apierr.New(409, "identidade da cobrança divergiu")
		}
		if nowState == "review" {
			if e = tx.Exec(ctx, `update provider_issuance set state='uncertain' where id=$1`, id); e != nil {
				return e
			}
			nowState = "uncertain"
		}
		if nowState == "uncertain" {
			if e = tx.Exec(ctx, `update provider_issuance set state='issued',charge_id=$2 where id=$1`, id, snapshot.Charge.ID); e != nil {
				return e
			}
		} else if nowState != "issued" {
			return apierr.New(409, "estado de emissão incompatível")
		}
		evidence, e := tx.Objects(ctx, `insert into provider_resolution_evidence(tenant_id,issuance_id,intent_id,kind,created_by,reason,status,charge_id,amount_cents,payments_count,refunds_count,review_required,credential_version_id,config_hash,snapshot_hash,observed_at) values(app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8,$9,0,false,$10,$11,$12,$13) returning id,issuance_id,kind,status`, id, b.IntentID, kind, actor, b.Reason, snapshot.Status, snapshot.Charge.ID, r.Money.Cents, len(snapshot.Payments), version, hash, hex.EncodeToString(digest[:]), observed)
		if e != nil {
			return e
		}
		out = evidence[0]
		if e = applyProviderSnapshot(ctx, tx, scope.TenantID, id, r, snapshot); e != nil {
			return e
		}
		if kind == "reissue" {
			requestJSON, _ := json.Marshal(successor)
			optsJSON, _ := json.Marshal(successorOptions)
			rows, e := tx.Objects(ctx, `insert into provider_issuance(tenant_id,invoice_id,financial_connection_id,intent_key,request,config_hash,credential_version_id,product,product_options,predecessor_id,resolution_id) values(app_tenant(),$1,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9,$10) returning id`, r.InvoiceID, connection, b.IntentID, string(requestJSON), successorHash, version, options.Product, string(optsJSON), id, out.Get("id"))
			if e != nil {
				return e
			}
			out.Set("successor_id", rows[0].Get("id"))
		} else if snapshot.Status != "removed" {
			inv, e := one(ctx, tx, "applyGatewayPayment", 0, r.InvoiceID)
			if e != nil {
				return e
			}
			if len(snapshot.Payments) > 0 && inv.Get("status") != "paid" {
				if _, e = settle(ctx, tx, inv, true); e != nil {
					return e
				}
			} else if len(snapshot.Payments) == 0 {
				if e = tx.Exec(ctx, `update invoices set status='open',status_note='resultado confirmado por consulta autenticada' where id=$1`, r.InvoiceID); e != nil {
					return e
				}
			}
		}
		if e = storeProviderArtifacts(ctx, tx, id, snapshot.Charge, snapshot.Status == "active"); e != nil {
			return e
		}
		if e = tx.Exec(ctx, `update provider_issuance set receipt_review=false,receipt_last_error=null,last_error=null,receipt_checked_at=now(),receipt_next_at=now()+interval '5 minutes' where id=$1`, id); e != nil {
			return e
		}
		return SysAudit(ctx, tx, scope.TenantID, "finance.provider."+kind, "provider_issuance", id, map[string]any{"evidence_id": out.Get("id"), "intent_id": b.IntentID, "actor_id": actor, "reason": b.Reason, "snapshot_hash": hex.EncodeToString(digest[:]), "successor_id": out.Get("successor_id"), "lookup_only": true}, "ok")
	})
	return out, err
}
