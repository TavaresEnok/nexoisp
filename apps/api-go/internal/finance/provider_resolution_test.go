package finance

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/finance/providers/efi"
	"nexoisp/api-go/internal/tenancy"
)

type resolutionAdapter struct {
	issuanceFake
	snapshot providers.Snapshot
}

func (a *resolutionAdapter) Lookup(context.Context, providers.Reference) (providers.Snapshot, error) {
	a.reads.Add(1)
	if a.lookupError != nil {
		return providers.Snapshot{}, a.lookupError
	}
	return a.snapshot, nil
}
func resolutionFixture(t *testing.T) (*db.DB, tenancy.Scope, providers.Create, Issuance, string, *resolutionAdapter) {
	t.Helper()
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	ctx := context.Background()
	var user string
	var version CredentialMetadata
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		var e error
		version, e = SavePixCredentials(ctx, tx, r.Scope.ConnectionID, user, syntheticPixCredentials(t))
		return e
	}); err != nil {
		t.Fatal(err)
	}
	item, e := (SandboxIssuance{DB: d}).PrepareWithCredential(ctx, scope, r, strings.Repeat("a", 64), version.ID)
	if e != nil {
		t.Fatal(e)
	}
	a := &resolutionAdapter{issuanceFake: issuanceFake{request: r, lost: true}}
	a.snapshot = providers.Snapshot{Charge: a.charge(), Status: "active"}
	a.snapshot.Charge.ID = uuid.NewString()
	// Persist uncertainty before simulating a lost provider acknowledgement.
	if _, e = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, a); e == nil {
		t.Fatal("expected lost response")
	}
	return d, scope, r, item, user, a
}
func resolutionFactory(a *resolutionAdapter) AdapterFactory {
	return func(context.Context, providers.Create, string, IssuanceOptions) (ConfiguredAdapter, func(), error) {
		return a, func() {}, nil
	}
}
func TestProviderResolutionAuthenticatedEvidenceAndReplay(t *testing.T) {
	d, scope, r, item, user, a := resolutionFixture(t)
	ctx := context.Background()
	b := ResolutionInput{uuid.NewString(), "Conferência autenticada de laboratório"}
	resolve := func() error {
		_, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "resolve", b, resolutionFactory(a))
		return e
	}
	a.lookupError = errors.New("404 is not evidence")
	if e := resolve(); e == nil {
		t.Fatal("absence released reservation")
	}
	a.lookupError = nil
	a.snapshot.Charge.Money.Cents++
	if e := resolve(); e == nil {
		t.Fatal("wrong money accepted")
	}
	a.snapshot.Charge.Money = r.Money
	a.snapshot.Status = "paid"
	if e := resolve(); e == nil {
		t.Fatal("paid without receipts accepted")
	}
	a.snapshot.Payments = []providers.Payment{{ID: uuid.NewString(), AmountCents: r.Money.Cents, PaidAt: time.Now().UTC().Format(time.RFC3339Nano), Currency: "BRL", Method: "pix"}}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := resolve(); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	// ACK loss: replay must not consult again or post another payment.
	reads := a.reads.Load()
	if e := resolve(); e != nil {
		t.Fatal(e)
	}
	if a.reads.Load() != reads || a.writes.Load() != 1 {
		t.Fatal("replay performed remote mutation/lookup")
	}
	var good bool
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select i.status='paid' and (select count(*) from payments where invoice_id=i.id)=1 and (select count(*) from provider_resolution_evidence where issuance_id=$2)=1 and i.provider_issuance_id=$2::uuid from invoices i where i.id=$1`, r.InvoiceID, item.ID).Scan(&good)
	}); e != nil || !good {
		t.Fatalf("resolution not atomic %v", e)
	}
	changed := b
	changed.Reason = "Outra justificativa com mesma intenção"
	if _, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "resolve", changed, resolutionFactory(a)); e == nil {
		t.Fatal("mutated intention accepted")
	}
	if _, e := ResolveProviderResult(ctx, d, tenancy.Scope{TenantID: scope.TenantID, PopIDs: []string{uuid.NewString()}}, r.Scope.ConnectionID, item.ID, user, "resolve", b, resolutionFactory(a)); e == nil {
		t.Fatal("POP scope allowed")
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `delete from provider_resolution_evidence where issuance_id=$1`, item.ID)
	}); e == nil {
		t.Fatal("evidence deleted")
	}
}
func TestProviderReissueProofConcurrencyAndLateReceipt(t *testing.T) {
	d, scope, r, item, user, a := resolutionFixture(t)
	ctx := context.Background()
	// Resolve the original charge first; a fresh removed proof is required again for reissue.
	if _, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "resolve", ResolutionInput{uuid.NewString(), "Confirmar identidade da cobrança antiga"}, resolutionFactory(a)); e != nil {
		t.Fatal(e)
	}
	b := ResolutionInput{uuid.NewString(), "Reemitir após confirmação de remoção"}
	call := func() (string, error) {
		o, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "reissue", b, resolutionFactory(a))
		if e != nil {
			return "", e
		}
		return o.Get("successor_id").(string), nil
	}
	if _, e := call(); e == nil {
		t.Fatal("active charge was replaced")
	}
	a.snapshot.Status = "removed"
	var wg sync.WaitGroup
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, e := call()
			if e != nil {
				t.Error(e)
			} else {
				ids <- id
			}
		}()
	}
	wg.Wait()
	close(ids)
	var next string
	for id := range ids {
		if next != "" && id != next {
			t.Fatal("multiple successors")
		}
		next = id
	}
	if next == "" {
		t.Fatal("no successor")
	}
	if _, e := call(); e != nil {
		t.Fatal("lost ACK cannot replay", e)
	}
	var good bool
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select i.provider_issuance_id=$2::uuid and i.gateway_charge_id is null and i.status='open' and (select count(*) from provider_issuance where invoice_id=i.id)=2 and i.amount_cents=12345 from invoices i where i.id=$1`, r.InvoiceID, next).Scan(&good)
	}); e != nil || !good {
		t.Fatalf("successor altered debt %v", e)
	}
	// A late cash receipt belongs to the same debt, even while successor is unbound.
	a.snapshot.Payments = []providers.Payment{{ID: uuid.NewString(), AmountCents: 1000, PaidAt: time.Now().UTC().Format(time.RFC3339Nano), Currency: "BRL", Method: "pix"}}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := lockIssuanceInvoice(ctx, tx, item.ID); e != nil {
			return e
		}
		return applyProviderSnapshot(ctx, tx, scope.TenantID, item.ID, r, a.snapshot)
	}); e != nil {
		t.Fatal("late receipt lost", e)
	}
	var successorRequest providers.Create
	successorRequest = r
	successorRequest.IntentKey = b.IntentID
	sender := &issuanceFake{request: successorRequest}
	if _, e := (SandboxIssuance{DB: d}).Run(ctx, scope, next, sender); e == nil || sender.writes.Load() != 0 {
		t.Fatal("replacement sent despite late receipt", e)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status='reconciling' and (select count(*) from payments where invoice_id=i.id)=1 from invoices i where id=$1`, r.InvoiceID).Scan(&good)
	}); e != nil || !good {
		t.Fatalf("late receipt not held %v", e)
	}

	// Late refunds also remain in the ledger while the successor is unbound.
	a.snapshot.Refunds = []providers.Refund{{ID: uuid.NewString(), ReturnID: uuid.NewString(), PaymentID: a.snapshot.Payments[0].ID, AmountCents: 500, SettledAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	for i := 0; i < 2; i++ {
		if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if e := lockIssuanceInvoice(ctx, tx, item.ID); e != nil {
				return e
			}
			return applyProviderSnapshot(ctx, tx, scope.TenantID, item.ID, r, a.snapshot)
		}); e != nil {
			t.Fatal("late refund lost", e)
		}
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status='reconciling' and (select count(*) from payments where invoice_id=i.id)=2 and (select sum(case when kind='reversal' then -amount_cents else amount_cents end) from payments where invoice_id=i.id)=500 from invoices i where id=$1`, r.InvoiceID).Scan(&good)
	}); e != nil || !good {
		t.Fatal("late cash/refund balance incorrect", e)
	}
}

func TestProviderReissueNewGenerationAndTenantIsolation(t *testing.T) {
	d, scope, r, item, user, a := resolutionFixture(t)
	ctx := context.Background()
	a.snapshot.Status = "removed"
	if _, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "resolve", ResolutionInput{uuid.NewString(), "Confirmar remoção autenticada original"}, resolutionFactory(a)); e != nil {
		t.Fatal(e)
	}
	// Wrong tenant must not even reach a provider transport.
	var other string
	if e := d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id from nexo_go_directory() where tenant_id<>$1 limit 1`, scope.TenantID).Scan(&other)
	}); e != nil {
		t.Fatal(e)
	}
	before := a.reads.Load()
	if _, e := ResolveProviderResult(ctx, d, tenancy.Scope{TenantID: other}, r.Scope.ConnectionID, item.ID, user, "reissue", ResolutionInput{uuid.NewString(), "Tentativa sintética de acesso cruzado"}, resolutionFactory(a)); e == nil || a.reads.Load() != before {
		t.Fatal("cross-tenant reached transport")
	}
	b := ResolutionInput{uuid.NewString(), "Substituir cobrança removida sem recebimento"}
	out, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "reissue", b, resolutionFactory(a))
	if e != nil {
		t.Fatal(e)
	}
	next := out.Get("successor_id").(string)
	r2 := r
	r2.IntentKey = b.IntentID
	nextAdapter := &resolutionAdapter{issuanceFake: issuanceFake{request: r2}}
	nextAdapter.snapshot = providers.Snapshot{Charge: nextAdapter.charge(), Status: "active"}
	nextAdapter.snapshot.Charge.ID = uuid.NewString()
	// Simulate response loss on a real single send, then authenticate lookup recovery.
	nextAdapter.lost = true
	if _, e = (SandboxIssuance{DB: d}).Run(ctx, scope, next, nextAdapter); e == nil {
		t.Fatal("expected response loss")
	}
	if _, e = (SandboxIssuance{DB: d}).Run(ctx, scope, next, nextAdapter); e != nil || nextAdapter.writes.Load() != 1 {
		t.Fatal("recovery issued duplicate", e)
	}
	// An old removed snapshot without new receipts cannot rehold the new debt.
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := lockIssuanceInvoice(ctx, tx, item.ID); e != nil {
			return e
		}
		return applyProviderSnapshot(ctx, tx, scope.TenantID, item.ID, r, a.snapshot)
	}); e != nil {
		t.Fatal(e)
	}
	nextAdapter.snapshot.Status = "paid"
	nextAdapter.snapshot.Payments = []providers.Payment{{ID: uuid.NewString(), AmountCents: r.Money.Cents, PaidAt: time.Now().UTC().Format(time.RFC3339Nano), Currency: "BRL", Method: "pix"}}
	if _, e = ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, next, user, "resolve", ResolutionInput{uuid.NewString(), "Liquidar nova geração pela prova autenticada"}, resolutionFactory(nextAdapter)); e != nil {
		t.Fatal(e)
	}
	var good bool
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status='paid' and provider_issuance_id=$2::uuid and amount_cents=12345 and (select count(*) from payments where invoice_id=i.id)=1 from invoices i where id=$1`, r.InvoiceID, next).Scan(&good)
	}); e != nil || !good {
		t.Fatal("new charge did not settle same debt", e)
	}

	var payment string
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select id from payments where invoice_id=$1`, r.InvoiceID).Scan(&payment)
	}); e != nil {
		t.Fatal(e)
	}
	refund := ProviderOperationInput{IntentID: uuid.NewString(), Kind: "refund", PaymentID: payment, AmountCents: 100, Reason: "Devolver somente recebimento da geração comprovada"}
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		_, _, e := PrepareProviderOperation(ctx, tx, item.ID, r.Scope.ConnectionID, user, refund)
		return e
	}); e == nil {
		t.Fatal("new receipt refunded against old generation")
	}
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		_, _, e := PrepareProviderOperation(ctx, tx, next, r.Scope.ConnectionID, user, refund)
		return e
	}); e != nil {
		t.Fatal("proven generation refund blocked", e)
	}
}

func TestProviderNoticeRetentionPreservesDedupeAndAudit(t *testing.T) {
	d, scope, r, item, user, a := resolutionFixture(t)
	ctx := context.Background()
	a.snapshot.Status = "active"
	if _, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "resolve", ResolutionInput{uuid.NewString(), "Autenticar cobrança para retenção de aviso"}, resolutionFactory(a)); e != nil {
		t.Fatal(e)
	}
	var n int64
	var oldHash = strings.Repeat("b", 64)
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.Exec(ctx, `insert into provider_notices(tenant_id,financial_connection_id,payload_hash,charge_id,payment_id,payload,status,created_at,processed_at) values(app_tenant(),$1,$2,$3,'synthetic-receipt','{"synthetic":true}','processed',now()-interval '91 days',now()-interval '90 days'),(app_tenant(),$1,$4,$3,'pending-receipt','{"synthetic":true}','review',now()-interval '91 days',now()-interval '90 days')`, r.Scope.ConnectionID, oldHash, a.snapshot.Charge.ID, strings.Repeat("c", 64)); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select redact_provider_notice_payloads(30,1000)`).Scan(&n)
	}); e != nil || n < 1 {
		t.Fatal("retention did not run", e, n)
	}
	var good bool
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select n.payload='{}'::jsonb and n.payload_redacted_at is not null and n.payload_hash=$2 and n.status='processed' and exists(select 1 from provider_notices pending where pending.financial_connection_id=n.financial_connection_id and pending.status='review' and pending.payload_redacted_at is null) and exists(select 1 from audit_events where action='finance.notice.payload_redact') and not exists(select 1 from payments where invoice_id=$3) from provider_notices n where n.financial_connection_id=$1 and n.payload_hash=$2`, r.Scope.ConnectionID, oldHash, r.InvoiceID).Scan(&good); e != nil {
			return e
		}
		var count int64
		if e := tx.QueryRow(ctx, `select redact_provider_notice_payloads(30,1000)`).Scan(&count); e != nil {
			return e
		}
		if count != 0 {
			return errors.New("repeated retention redacted again")
		}
		rows, e := tx.Objects(ctx, `insert into provider_notices(tenant_id,financial_connection_id,payload_hash,charge_id,payment_id,payload,status) values(app_tenant(),$1,$2,$3,'synthetic-receipt','{"synthetic":true}','pending') on conflict(financial_connection_id,payload_hash) do nothing returning id`, r.Scope.ConnectionID, oldHash, a.snapshot.Charge.ID)
		if e != nil {
			return e
		}
		if len(rows) != 0 {
			return errors.New("redaction lost dedupe")
		}
		return nil
	}); e != nil || !good {
		t.Fatal("retention damaged proof/dedupe", e)
	}
	if e := d.WithScope(ctx, tenancy.Scope{TenantID: scope.TenantID, PopIDs: []string{uuid.NewString()}}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select redact_provider_notice_payloads(30,1000)`).Scan(&n)
	}); e == nil {
		t.Fatal("POP redaction allowed")
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update provider_notices set payload='{}'::jsonb where financial_connection_id=$1`, r.Scope.ConnectionID)
	}); e == nil {
		t.Fatal("direct redaction granted")
	}
}

func TestProviderResolutionPartialAndUnresolvedReservation(t *testing.T) {
	d, scope, r, item, user, a := resolutionFixture(t)
	ctx := context.Background()
	// An unrestricted finance actor may carry an empty POP slice; that is not a restricted POP.
	full := scope
	full.PopIDs = []string{}
	a.snapshot.Payments = []providers.Payment{{ID: uuid.NewString(), AmountCents: 1000, PaidAt: time.Now().UTC().Format(time.RFC3339Nano), Currency: "BRL", Method: "pix"}}
	if _, e := ResolveProviderResult(ctx, d, full, r.Scope.ConnectionID, item.ID, user, "resolve", ResolutionInput{uuid.NewString(), "Conferir recebimento parcial comprovado"}, resolutionFactory(a)); e != nil {
		t.Fatal(e)
	}
	var good bool
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status='open' and amount_cents=12345 and (select sum(amount_cents) from payments where invoice_id=i.id)=1000 and not exists(select 1 from payment_effects where invoice_id=i.id) from invoices i where id=$1`, r.InvoiceID).Scan(&good)
	}); e != nil || !good {
		t.Fatal("partial proof settled nominal debt", e)
	}
	a.snapshot.Status = "removed"
	a.snapshot.Payments = nil
	if _, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "reissue", ResolutionInput{uuid.NewString(), "Pagamento parcial impede reemissão automática"}, resolutionFactory(a)); e == nil {
		t.Fatal("local receipt omitted from proof")
	}
	d2, s2, r2, i2, u2, a2 := resolutionFixture(t)
	if _, e := ResolveProviderResult(ctx, d2, s2, r2.Scope.ConnectionID, i2.ID, u2, "resolve", ResolutionInput{uuid.NewString(), "Confirmar antes de operação pendente"}, resolutionFactory(a2)); e != nil {
		t.Fatal(e)
	}
	if e := d2.WithScope(ctx, s2, func(tx *db.Tx) error {
		_, _, e := PrepareProviderOperation(ctx, tx, i2.ID, r2.Scope.ConnectionID, u2, ProviderOperationInput{IntentID: uuid.NewString(), Kind: "cancel", Reason: "Cancelamento pendente não pode ser ignorado"})
		return e
	}); e != nil {
		t.Fatal(e)
	}
	a2.snapshot.Status = "removed"
	if _, e := ResolveProviderResult(ctx, d2, s2, r2.Scope.ConnectionID, i2.ID, u2, "reissue", ResolutionInput{uuid.NewString(), "Não liberar enquanto há operação pendente"}, resolutionFactory(a2)); e == nil {
		t.Fatal("unresolved mutation reservation cleared")
	}
	if e := d2.WithScope(ctx, s2, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select provider_issuance_id=$2::uuid and (select count(*) from provider_issuance where invoice_id=i.id)=1 from invoices i where id=$1`, r2.InvoiceID, i2.ID).Scan(&good)
	}); e != nil || !good {
		t.Fatal("pending operation lost reservation", e)
	}
}

func TestBolixReplacementFreezesNewRecoveryWindow(t *testing.T) {
	d, scope := issuanceDatabase(t)
	r := issuanceFixture(t, d, scope)
	ctx := context.Background()
	var user string
	var version CredentialMetadata
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		var e error
		version, e = SaveFinancialCredentials(ctx, tx, r.Scope.ConnectionID, user, PixCredentials{Kind: "efi_charges", ClientID: "synthetic-charges-client", ClientSecret: "synthetic-charges-secret"})
		return e
	}); e != nil {
		t.Fatal(e)
	}
	customer := efi.BilletCustomer{Name: "Synthetic payer", CPF: "12345678909", Email: "synthetic@example.invalid"}
	customer.Address.Street = "Synthetic street"
	customer.Address.Number = "1"
	customer.Address.Neighborhood = "Synthetic"
	customer.Address.City = "Fortaleza"
	customer.Address.State = "CE"
	customer.Address.Zip = "60000000"
	options := IssuanceOptions{Product: "bolix", IssuedOn: "2026-09-01", Customer: customer}
	stored := StoredAdapterFactory(d, scope)
	original, closeOriginal, e := stored(ctx, r, version.ID, options)
	if e != nil {
		t.Fatal(e)
	}
	hash := original.ConfigurationHash()
	closeOriginal()
	item, e := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, r, hash, version.ID, options)
	if e != nil {
		t.Fatal(e)
	}
	fake := &resolutionAdapter{issuanceFake: issuanceFake{request: r, lost: true, config: hash}}
	fake.snapshot = providers.Snapshot{Charge: fake.charge(), Status: "removed"}
	fake.snapshot.Charge.ID = "987654321"
	if _, e = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, fake); e == nil {
		t.Fatal("expected uncertain original")
	}
	if _, e = ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "resolve", ResolutionInput{uuid.NewString(), "Confirmar remoção Bolix com prova vinculada"}, resolutionFactory(fake)); e != nil {
		t.Fatal(e)
	}
	b := ResolutionInput{uuid.NewString(), "Reemitir Bolix em nova data de recuperação"}
	factory := func(ctx context.Context, request providers.Create, version string, o IssuanceOptions) (ConfiguredAdapter, func(), error) {
		if request.IntentKey == r.IntentKey {
			return fake, func() {}, nil
		}
		if request.IntentKey != b.IntentID || request.DueDate != r.DueDate || request.Money != r.Money || o.Customer != options.Customer || o.IssuedOn == options.IssuedOn {
			return nil, func() {}, errors.New("replacement changed debt/customer or retained stale recovery window")
		}
		// Real adapter construction/hash, with synthetic credentials; no HTTP call.
		return stored(ctx, request, version, o)
	}
	out, e := ResolveProviderResult(ctx, d, scope, r.Scope.ConnectionID, item.ID, user, "reissue", b, factory)
	if e != nil {
		t.Fatal(e)
	}
	var good bool
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select child.state='prepared' and child.config_hash<>parent.config_hash and child.product_options->>'issued_on'=(now() at time zone 'America/Sao_Paulo')::date::text and parent.product_options->>'issued_on'='2026-09-01' and child.request->>'due_date'=parent.request->>'due_date' and child.credential_version_id=parent.credential_version_id from provider_issuance child join provider_issuance parent on parent.id=child.predecessor_id where child.id=$1`, out.Get("successor_id")).Scan(&good)
	}); e != nil || !good {
		t.Fatal("new Bolix recovery window not frozen", e)
	}
	r2 := r
	r2.IntentKey = b.IntentID
	if efi.TxID(r2) == efi.TxID(r) || fake.writes.Load() != 1 {
		t.Fatal("replacement reuses provider identity or sends again during preparation")
	}
}
