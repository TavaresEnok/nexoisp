package finance

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

type ProviderOperationInput struct {
	IntentID    string `json:"intent_id"`
	Kind        string `json:"kind"`
	PaymentID   string `json:"payment_id,omitempty"`
	AmountCents int64  `json:"amount_cents,omitempty"`
	Reason      string `json:"reason"`
}

func PrepareProviderOperation(ctx context.Context, tx *db.Tx, issuance, connection, user string, b ProviderOperationInput) (jsonx.Object, bool, error) {
	intent, err := uuid.Parse(b.IntentID)
	if err != nil || len(strings.TrimSpace(b.Reason)) < 10 || len(b.Reason) > 500 || (b.Kind != "cancel" && b.Kind != "refund") {
		return nil, false, apierr.New(400, "intenção, operação ou motivo inválidos")
	}
	b.IntentID = intent.String()
	if (b.Kind == "cancel" && (b.PaymentID != "" || b.AmountCents != 0)) || (b.Kind == "refund" && (b.AmountCents <= 0 || b.AmountCents > providers.MaxCents || uuid.Validate(b.PaymentID) != nil)) {
		return nil, false, apierr.New(400, "recebimento e valor incompatíveis com a operação")
	}
	if b.PaymentID != "" {
		b.PaymentID = uuid.MustParse(b.PaymentID).String()
	}
	var invoice string
	err = tx.QueryRow(ctx, `select i.id::text from invoices i join provider_issuance j on j.invoice_id=i.id and j.tenant_id=i.tenant_id where j.id=$1 and j.financial_connection_id=$2`, issuance, connection).Scan(&invoice)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, apierr.New(404, "emissão não encontrada")
	}
	if err != nil {
		return nil, false, err
	}
	// Advisory and the invoice row before the operation insert. The guard trigger locks the invoice again.
	if err = LockInvoices(ctx, tx, "", invoice); err != nil {
		return nil, false, err
	}
	rows, err := tx.Objects(ctx, `select i.id from invoices i join provider_issuance j on j.invoice_id=i.id and j.tenant_id=i.tenant_id where j.id=$1 and j.financial_connection_id=$2 for update of i`, issuance, connection)
	if err != nil {
		return nil, false, err
	}
	if len(rows) == 0 {
		return nil, false, apierr.New(404, "emissão não encontrada")
	}
	invoice = rows[0].Get("id").(string)
	prior, err := tx.Objects(ctx, `select id,state,kind,coalesce(payment_id::text,'') as payment_id,coalesce(amount_cents,0) as amount_cents,reason from provider_operations where issuance_id=$1 and intent_id=$2`, issuance, b.IntentID)
	if err != nil {
		return nil, false, err
	}
	if len(prior) > 0 {
		p := prior[0]
		if p.Get("kind") != b.Kind || p.Get("payment_id") != b.PaymentID || int64(num(p.Get("amount_cents"))) != b.AmountCents || p.Get("reason") != b.Reason {
			return nil, false, apierr.New(409, "intenção já utilizada com dados diferentes")
		}
		return p, false, nil
	}
	digest := sha256.Sum256([]byte(issuance + ":" + b.IntentID))
	remote := hex.EncodeToString(digest[:16])
	var payment, amount any
	if b.Kind == "refund" {
		payment = b.PaymentID
		amount = b.AmountCents
	}
	created, err := tx.Objects(ctx, `insert into provider_operations(tenant_id,invoice_id,financial_connection_id,issuance_id,intent_id,kind,remote_id,payment_id,amount_cents,reason,created_by)
 values(app_tenant(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id,state,kind`, invoice, connection, issuance, b.IntentID, b.Kind, remote, payment, amount, b.Reason, user)
	if err != nil {
		return nil, false, err
	}
	return created[0], true, nil
}

func ProcessProviderOperations(ctx context.Context, database *db.DB, tenant string) error {
	if !EFISandboxEnabled() {
		return nil
	}
	scope := tenancy.Scope{TenantID: tenant}
	return DispatchProviderOperations(ctx, database, scope, StoredAdapterFactory(database, scope), os.Getenv("NEXO_GO_EFI_OPERATIONS_WRITE") == "1")
}
func DispatchProviderOperations(ctx context.Context, database *db.DB, scope tenancy.Scope, factory AdapterFactory, allowWrites bool) error {
	var ids []string
	if err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		rows, e := tx.Objects(ctx, `select id from provider_operations where (state='uncertain' or (state='prepared' and $1)) and next_attempt_at<=now() order by next_attempt_at,id limit 100`, allowWrites)
		for _, r := range rows {
			ids = append(ids, r.Get("id").(string))
		}
		return e
	}); err != nil {
		return err
	}
	for _, id := range ids {
		opctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		err := RunProviderOperation(opctx, database, scope, id, factory, allowWrites)
		cancel()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		code := ""
		delay := time.Minute
		review := false
		if err != nil {
			code = "local_failure"
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
				code = "provider_conflict"
				review = true
			}
			if apierr.IsFinancialConflict(err) {
				code = "provider_conflict"
				review = true
			}
		}
		if delay > time.Hour {
			delay = time.Hour
		}
		if e := database.WithScope(ctx, scope, func(tx *db.Tx) error {
			if review {
				if e := tx.Exec(ctx, `update provider_operations set state='review' where id=$1 and state='uncertain'`, id); e != nil {
					return e
				}
			}
			return tx.Exec(ctx, `update provider_operations set attempts=attempts+1,last_error=case when state in ('confirmed','rejected') then null else nullif($2,'') end,next_attempt_at=now()+make_interval(secs=>$3) where id=$1`, id, code, int(delay.Seconds()))
		}); e != nil {
			return e
		}
	}
	return nil
}

func RunProviderOperation(ctx context.Context, database *db.DB, scope tenancy.Scope, id string, factory AdapterFactory, allowWrites bool) error {
	var request providers.Create
	var options IssuanceOptions
	var version, invoice, state, connection, configHash string
	var op providers.OperationRequest
	var send, eligible bool
	err := database.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select invoice_id::text from provider_operations where id=$1`, id).Scan(&invoice); e != nil {
			return e
		}
		if e := LockInvoices(ctx, tx, scope.TenantID, invoice); e != nil {
			return e
		}
		var locked string
		if e := tx.QueryRow(ctx, `select id from invoices where id=$1 for update`, invoice).Scan(&locked); e != nil {
			return e
		}
		var raw, opts []byte
		var stamp *time.Time
		if e := tx.QueryRow(ctx, `select o.state,o.kind,o.remote_id,coalesce(o.amount_cents,0),j.request,j.product_options,j.credential_version_id,o.financial_connection_id,coalesce(p.gateway_payment_id,''),coalesce(p.amount_cents,0),p.paid_at,coalesce(p.method,''),j.charge_id,j.config_hash
 from provider_operations o join provider_issuance j on j.id=o.issuance_id left join payments p on p.id=o.payment_id where o.id=$1 for update of o`, id).Scan(&state, &op.Kind, &op.ID, &op.AmountCents, &raw, &opts, &version, &connection, &op.Payment.ID, &op.Payment.AmountCents, &stamp, &op.Payment.Method, &op.Reference.ChargeID, &configHash); e != nil {
			return e
		}
		if e := json.Unmarshal(raw, &request); e != nil {
			return e
		}
		if e := json.Unmarshal(opts, &options); e != nil {
			return e
		}
		op.Reference.Scope = request.Scope
		op.Reference.IntentKey = request.IntentKey
		op.Payment.Currency = "BRL"
		if stamp != nil {
			op.Payment.PaidAt = stamp.Format(time.RFC3339Nano)
		}
		if state == "confirmed" || state == "rejected" || state == "review" || (state == "prepared" && !allowWrites) {
			return nil
		}
		eligible = true
		if state == "prepared" {
			send = true
			return tx.Exec(ctx, `update provider_operations set state='uncertain' where id=$1`, id)
		}
		return nil
	})
	if err != nil || !eligible {
		return err
	}
	a, close, err := factory(ctx, request, version, options)
	if err != nil {
		return err
	}
	defer close()
	if a.ConfigurationHash() != configHash {
		return &providers.Failure{Kind: providers.Conflict, Cause: errors.New("frozen operation adapter changed")}
	}
	mutator, ok := a.(providers.Operations)
	if !ok {
		return &providers.Failure{Kind: providers.Rejected, Cause: errors.New("operation capability unavailable")}
	}
	var result providers.OperationResult
	if send {
		result, err = mutator.ExecuteOperation(ctx, op)
	} else {
		result, err = mutator.LookupOperation(ctx, op)
	}
	if err != nil {
		return err
	}
	if result.State != "pending" && result.State != "confirmed" && result.State != "rejected" {
		return &providers.Failure{Kind: providers.Conflict, Cause: errors.New("unknown operation outcome")}
	}
	if result.State == "pending" {
		return nil
	}
	if result.State == "confirmed" && op.Kind == "refund" && (result.Refund == nil || result.Refund.Validate() != nil || result.Refund.ID != op.ID || result.Refund.PaymentID != op.Payment.ID || result.Refund.AmountCents != op.AmountCents) {
		return &providers.Failure{Kind: providers.Conflict, Cause: errors.New("refund outcome differs from intention")}
	}
	if result.State == "confirmed" && op.Kind == "refund" {
		settled, _ := time.Parse(time.RFC3339Nano, result.Refund.SettledAt)
		paid, _ := time.Parse(time.RFC3339Nano, op.Payment.PaidAt)
		if settled.Before(paid) {
			return &providers.Failure{Kind: providers.Conflict, Cause: errors.New("refund timestamp precedes receipt")}
		}
	}
	return database.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := LockInvoices(ctx, tx, scope.TenantID, invoice); e != nil {
			return e
		}
		var locked string
		if e := tx.QueryRow(ctx, `select id from invoices where id=$1 for update`, invoice).Scan(&locked); e != nil {
			return e
		}
		var current string
		if e := tx.QueryRow(ctx, `select state from provider_operations where id=$1 for update`, id).Scan(&current); e != nil {
			return e
		}
		if current != "uncertain" {
			return nil
		}
		if result.State == "confirmed" && op.Kind == "refund" {
			if _, e := ApplyProviderRefund(ctx, tx, invoice, connection, *result.Refund); e != nil {
				return e
			}
		}
		if e := tx.Exec(ctx, `update provider_operations set state=$2 where id=$1`, id, result.State); e != nil {
			return e
		}
		if result.State == "confirmed" && op.Kind == "cancel" {
			if e := tx.Exec(ctx, `update invoices set provider_canceled_at=coalesce(provider_canceled_at,now()),status='reconciling',status_note='cobrança removida no fornecedor; obrigação preservada para revisão' where id=$1`, invoice); e != nil {
				return e
			}
			if e := tx.Exec(ctx, `update provider_issuance set receipt_next_at=now() where invoice_id=$1`, invoice); e != nil {
				return e
			}
		}
		return SysAudit(ctx, tx, scope.TenantID, "finance.provider.operation_result", "provider_operation", id, map[string]any{"state": result.State, "kind": op.Kind}, "ok")
	})
}

// RequeueProviderOperationLookup is the database step of POST .../retry-lookup.
// It discovers the invoice without a row lock, then takes the advisory and the invoice before the operation update.
func RequeueProviderOperationLookup(ctx context.Context, tx *db.Tx, tenant, issuance, operation string) error {
	var invoice string
	err := tx.QueryRow(ctx, `select i.id::text from invoices i join provider_operations o on o.invoice_id=i.id where o.id=$1 and o.issuance_id=$2`, operation, issuance).Scan(&invoice)
	if errors.Is(err, pgx.ErrNoRows) {
		return apierr.New(404, "operação não encontrada")
	}
	if err != nil {
		return err
	}
	if err = LockInvoices(ctx, tx, tenant, invoice); err != nil {
		return err
	}
	rows, err := tx.Objects(ctx, `select i.id from invoices i join provider_operations o on o.invoice_id=i.id where o.id=$1 and o.issuance_id=$2 for update of i`, operation, issuance)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return apierr.New(404, "operação não encontrada")
	}
	n, err := tx.Affected(ctx, `update provider_operations set state='uncertain',next_attempt_at=now(),last_error=null where id=$1 and state in ('review','uncertain')`, operation)
	if err != nil {
		return err
	}
	if n == 0 {
		return apierr.New(409, "somente operação incerta ou em revisão pode retomar consulta")
	}
	return nil
}
