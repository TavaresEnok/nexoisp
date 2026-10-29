package finance

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
)

const importedIssuanceRefusal = "título importado de outra origem: a cobrança permanece na instituição original; nova cobrança não é emitida"

// issuanceTransport observes the real Run/lookup boundary. A row lock from
// another connection must succeed: the provider call happens only after the
// issuance transaction has committed and released the invoice.
type issuanceTransport struct {
	issuanceFake
	database *db.DB
	scope    tenancy.Scope
	issuance string
	chargeID string
	want     string
	checkRow bool
	snapshot providers.Snapshot
	custom   bool
	kinds    []string
}

func (a *issuanceTransport) charge() providers.Charge {
	return providers.Charge{Scope: a.request.Scope, ID: a.chargeID, IntentKey: a.request.IntentKey, InvoiceID: a.request.InvoiceID, Money: a.request.Money}
}

func (a *issuanceTransport) observe(ctx context.Context, kind string) error {
	if a.checkRow {
		if err := tryLockInvoiceRow(a.database, a.scope, a.request.InvoiceID); err != nil {
			return fmt.Errorf("%s ocorreu com a transação da emissão ainda segurando a fatura: %w", kind, err)
		}
	}
	var state string
	if err := a.database.WithScope(ctx, a.scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select state from provider_issuance where id=$1`, a.issuance).Scan(&state)
	}); err != nil {
		return err
	}
	if a.want != "" && state != a.want {
		return fmt.Errorf("%s viu estado %s, esperado %s", kind, state, a.want)
	}
	a.kinds = append(a.kinds, kind+":"+state)
	return nil
}

func (a *issuanceTransport) CreateCharge(ctx context.Context, _ providers.Create) (providers.Charge, error) {
	if err := a.observe(ctx, "create"); err != nil {
		return providers.Charge{}, err
	}
	a.writes.Add(1)
	if a.lost {
		return providers.Charge{}, errors.New("response lost after provider commit")
	}
	return a.charge(), nil
}

func (a *issuanceTransport) Lookup(ctx context.Context, _ providers.Reference) (providers.Snapshot, error) {
	if err := a.observe(ctx, "lookup"); err != nil {
		return providers.Snapshot{}, err
	}
	a.reads.Add(1)
	if a.lookupError != nil {
		return providers.Snapshot{}, a.lookupError
	}
	if a.custom {
		return a.snapshot, nil
	}
	return providers.Snapshot{Charge: a.charge()}, nil
}

func tryLockInvoiceRow(d *db.DB, scope tenancy.Scope, invoice string) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := tx.Exec(ctx, `select set_config('lock_timeout', '300ms', true)`); err != nil {
			return err
		}
		var id string
		return tx.QueryRow(ctx, `select id::text from invoices where id=$1::uuid for update`, invoice).Scan(&id)
	})
}

func mustAPI(t *testing.T, err error, status int, message string) {
	t.Helper()
	var api *apierr.Error
	if !errors.As(err, &api) || api.Status != status || api.Message != message {
		t.Fatalf("esperado %d %q, obteve %v", status, message, err)
	}
}

func lockScalar(t *testing.T, d *db.DB, scope tenancy.Scope, dest any, query string, args ...any) {
	t.Helper()
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), query, args...).Scan(dest)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func lockCount(t *testing.T, d *db.DB, scope tenancy.Scope, query string, args ...any) int {
	t.Helper()
	var n int
	lockScalar(t, d, scope, &n, query, args...)
	return n
}

func setConnectionStatus(t *testing.T, d *db.DB, scope tenancy.Scope, connection, status string) {
	t.Helper()
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.Exec(context.Background(), `update financial_connections set status=$2 where id=$1`, connection, status)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func saveLockCredential(t *testing.T, d *db.DB, scope tenancy.Scope, connection string) (string, string) {
	t.Helper()
	var user string
	var meta CredentialMetadata
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(context.Background(), `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		var e error
		meta, e = SavePixCredentials(context.Background(), tx, connection, user, syntheticPixCredentials(t))
		if e != nil {
			return e
		}
		return tx.Exec(context.Background(), `update financial_connections set status='active' where id=$1`, connection)
	})
	if err != nil {
		t.Fatal(err)
	}
	return user, meta.ID
}

func lockRequest(t *testing.T, d *db.DB, scope tenancy.Scope, contract string, cents int) providers.Create {
	t.Helper()
	invoice := insertLockInvoice(t, d, scope, contract, cents)
	return efiRequest(t, d, scope, invoice, int64(cents), "2026-12-20")
}

func issuanceHash() string { return strings.Repeat("a", 64) }

func parkOtherReceipts(t *testing.T, d *db.DB, scope tenancy.Scope, keep string) {
	t.Helper()
	var ids []string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `with moved as (
			update provider_issuance set receipt_next_at=now()+interval '7 days'
			where id<>$1::uuid and receipt_next_at<=now()
			returning id
		) select coalesce(array_agg(id::text), '{}') from moved`, keep).Scan(&ids)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if len(ids) == 0 {
			return
		}
		if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			return tx.Exec(context.Background(), `update provider_issuance set receipt_next_at=now() where id::text=any($1::text[])`, ids)
		}); err != nil {
			t.Error(err)
		}
	})
}

func blockOnAdvisory(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string, fn func(context.Context) error) {
	t.Helper()
	release, held, holderDone := holdAdvisories(t, d, scope, []string{invoice})
	defer release()
	waitAcquired(t, held, holderDone)
	runCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- fn(runCtx) }()
	err := finishWhileRowsFree(t, d, scope, []string{invoice}, done)
	if !lockWait(err) {
		t.Fatalf("chamada não esperou o advisory sem travar a linha: %v", err)
	}
	release()
	if err := <-holderDone; !errors.Is(err, errLockTestRollback) {
		t.Fatal(err)
	}
}

func TestIssuancePrepareOptionsContracts(t *testing.T) {
	d, scope, contract := openLockDatabase(t)
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	ctx := context.Background()
	hash := issuanceHash()
	options := IssuanceOptions{Product: "pix_cob", Expiration: 1800}

	t.Run("imported origin never reaches Run", func(t *testing.T) {
		var legacy, native, connection string
		account := uuid.NewString()
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if e := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,external_source,external_id) select tenant_id,id,subscriber_id,'manual','2026-12-20',14141,'erp-anterior',$2 from contracts where id=$1 returning id::text`, contract, uuid.NewString()).Scan(&legacy); e != nil {
				return e
			}
			if e := tx.QueryRow(ctx, `insert into invoices(tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,company_id) select tenant_id,contract_id,subscriber_id,kind,due_date,amount_cents,company_id from invoices where id=$1 returning id::text`, legacy).Scan(&native); e != nil {
				return e
			}
			return tx.QueryRow(ctx, `insert into financial_connections(tenant_id,company_id,provider,environment,account_ref,name) select tenant_id,company_id,'efi','sandbox',$2,'lock issuance import' from invoices where id=$1::uuid returning id::text`, legacy, account).Scan(&connection)
		})
		if err != nil {
			t.Fatal(err)
		}
		base := providers.Scope{TenantID: scope.TenantID, ConnectionID: connection, Provider: "efi", Environment: "sandbox", AccountRef: account}
		imported := providers.Create{Scope: base, IntentKey: uuid.NewString(), InvoiceID: legacy, Money: providers.Money{Cents: 14141, Currency: "BRL"}, DueDate: "2026-12-20"}
		probe := &issuanceTransport{issuanceFake: issuanceFake{request: imported, config: hash}, database: d, scope: scope, chargeID: uuid.NewString()}
		_, err = (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, imported, hash, "", options)
		mustAPI(t, err, 409, importedIssuanceRefusal)
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, uuid.NewString(), probe); err == nil || probe.writes.Load() != 0 || probe.reads.Load() != 0 {
			t.Fatalf("Run transportou título importado sem intenção: %v writes=%d reads=%d", err, probe.writes.Load(), probe.reads.Load())
		}
		if lockCount(t, d, scope, `select count(*) from provider_issuance where invoice_id=$1`, legacy) != 0 {
			t.Fatal("origem importada ganhou emissão")
		}
		var intact bool
		lockScalar(t, d, scope, &intact, `select status='open' and gateway_charge_id is null and provider_issuance_id is null and external_source='erp-anterior' from invoices where id=$1`, legacy)
		if !intact {
			t.Fatal("título importado foi alterado")
		}
		nativeRequest := imported
		nativeRequest.InvoiceID = native
		nativeRequest.IntentKey = uuid.NewString()
		item, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, nativeRequest, hash, "", options)
		if err != nil || item.State != "prepared" {
			t.Fatalf("título nativo vizinho não foi preparado: %v %+v", err, item)
		}
	})

	t.Run("account tenant version and replay", func(t *testing.T) {
		request := lockRequest(t, d, scope, contract, 15151)
		_, version := saveLockCredential(t, d, scope, request.Scope.ConnectionID)
		var held bool
		service := SandboxIssuance{DB: d, OnPrepared: func(context.Context, *db.Tx, Issuance) error {
			err := tryLockInvoiceRow(d, scope, request.InvoiceID)
			if err == nil {
				return errors.New("prepareOptions não segurou a fatura durante a transação")
			}
			if !lockWait(err) {
				return err
			}
			held = true
			return nil
		}}
		badAccount := request
		badAccount.Scope.AccountRef = request.Scope.AccountRef + "-outra"
		badAccount.IntentKey = uuid.NewString()
		if _, err := service.prepareOptions(ctx, scope, badAccount, hash, version, options); err == nil {
			t.Fatal("conta divergente foi aceita")
		} else {
			mustAPI(t, err, 409, "fatura ou conexão indisponível para emissão")
		}
		badTenant := request
		badTenant.Scope.TenantID = uuid.NewString()
		badTenant.IntentKey = uuid.NewString()
		if _, err := service.prepareOptions(ctx, scope, badTenant, hash, version, options); err == nil || err.Error() != "invalid sandbox issuance" {
			t.Fatalf("tenant divergente: %v", err)
		}
		setConnectionStatus(t, d, scope, request.Scope.ConnectionID, "disabled")
		if _, err := service.prepareOptions(ctx, scope, request, hash, version, options); err == nil {
			t.Fatal("conexão desabilitada foi aceita")
		} else {
			mustAPI(t, err, 409, "fatura ou conexão indisponível para emissão")
		}
		setConnectionStatus(t, d, scope, request.Scope.ConnectionID, "active")
		if lockCount(t, d, scope, `select count(*) from provider_issuance where invoice_id=$1`, request.InvoiceID) != 0 {
			t.Fatal("recusa gravou emissão")
		}
		item, err := service.prepareOptions(ctx, scope, request, hash, version, options)
		if err != nil || !held || item.State != "prepared" || item.CredentialID != version || item.ConfigHash != hash {
			t.Fatalf("prepareOptions %+v held=%v err=%v", item, held, err)
		}
		var product, expiration, storedVersion string
		err = d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select product, product_options->>'expiration_seconds', coalesce(credential_version_id::text,'') from provider_issuance where id=$1`, item.ID).Scan(&product, &expiration, &storedVersion)
		})
		if err != nil || product != "pix_cob" || expiration != "1800" || storedVersion != version {
			t.Fatalf("opções/versão product=%s expiration=%s version=%s err=%v", product, expiration, storedVersion, err)
		}
		replay, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, request, hash, version, IssuanceOptions{Product: "pix_cob", Expiration: 60})
		if err != nil || replay.ID != item.ID || replay.State != "prepared" {
			t.Fatalf("replay alterou a intenção: %+v %v", replay, err)
		}
		lockScalar(t, d, scope, &expiration, `select product_options->>'expiration_seconds' from provider_issuance where id=$1`, item.ID)
		if expiration != "1800" || lockCount(t, d, scope, `select count(*) from provider_issuance where invoice_id=$1`, request.InvoiceID) != 1 {
			t.Fatalf("replay regravou opções ou duplicou a emissão expiration=%s", expiration)
		}
		if _, err = (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, request, hash, uuid.NewString(), options); err == nil {
			t.Fatal("outra versão de credencial substituiu a intenção")
		} else {
			mustAPI(t, err, 409, "fatura já possui outra intenção de emissão")
		}
	})

	t.Run("advisory before invoice row", func(t *testing.T) {
		request := lockRequest(t, d, scope, contract, 16161)
		var calls int
		blockOnAdvisory(t, d, scope, request.InvoiceID, func(ctx context.Context) error {
			_, err := (SandboxIssuance{DB: d, OnPrepared: func(context.Context, *db.Tx, Issuance) error {
				calls++
				return nil
			}}).prepareOptions(ctx, scope, request, hash, "", options)
			return err
		})
		if calls != 0 || lockCount(t, d, scope, `select count(*) from provider_issuance where invoice_id=$1`, request.InvoiceID) != 0 {
			t.Fatal("prepareOptions passou do advisory ou gravou a emissão")
		}
		item, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, request, hash, "", options)
		if err != nil || item.State != "prepared" {
			t.Fatalf("prepareOptions não retomou após o advisory: %v %+v", err, item)
		}
	})
}

func TestIssuanceTwoPhaseRunRecoverySnapshotResolution(t *testing.T) {
	d, scope, contract := openLockDatabase(t)
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	ctx := context.Background()
	hash := issuanceHash()
	options := IssuanceOptions{Product: "pix_cob", Expiration: 1800}
	var other string
	if err := d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() where tenant_id<>$1::uuid limit 1`, scope.TenantID).Scan(&other)
	}); err != nil {
		t.Fatal(err)
	}

	t.Run("two phases replay and account tenant version", func(t *testing.T) {
		request := lockRequest(t, d, scope, contract, 17171)
		_, version := saveLockCredential(t, d, scope, request.Scope.ConnectionID)
		item, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, request, hash, version, options)
		if err != nil {
			t.Fatal(err)
		}
		probe := &issuanceTransport{
			issuanceFake: issuanceFake{request: request, config: hash},
			database:     d, scope: scope, issuance: item.ID, chargeID: uuid.NewString(),
			want: "uncertain", checkRow: true,
		}
		wrong := &issuanceTransport{issuanceFake: issuanceFake{request: request, config: strings.Repeat("b", 64)}, database: d, scope: scope, issuance: item.ID, chargeID: uuid.NewString()}
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, wrong); err == nil || wrong.writes.Load() != 0 || wrong.reads.Load() != 0 || !strings.Contains(err.Error(), "issuance scope/configuration mismatch") {
			t.Fatalf("versão de configuração chegou ao transporte: %v", err)
		}
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, tenancy.Scope{TenantID: other}, item.ID, probe); err == nil || probe.writes.Load() != 0 || probe.reads.Load() != 0 {
			t.Fatalf("outro tenant transportou: %v writes=%d", err, probe.writes.Load())
		}
		setConnectionStatus(t, d, scope, request.Scope.ConnectionID, "disabled")
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe); err == nil || probe.writes.Load() != 0 || !strings.Contains(err.Error(), "invoice changed or already billed") {
			t.Fatalf("conta desabilitada transportou: %v", err)
		}
		setConnectionStatus(t, d, scope, request.Scope.ConnectionID, "active")
		var state string
		lockScalar(t, d, scope, &state, `select state from provider_issuance where id=$1`, item.ID)
		if state != "prepared" {
			t.Fatalf("recusa alterou o estado %s", state)
		}
		blockOnAdvisory(t, d, scope, request.InvoiceID, func(ctx context.Context) error {
			_, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe)
			return err
		})
		if probe.writes.Load() != 0 || probe.reads.Load() != 0 {
			t.Fatal("Run transportou antes de obter o advisory")
		}
		lockScalar(t, d, scope, &state, `select state from provider_issuance where id=$1`, item.ID)
		if state != "prepared" {
			t.Fatalf("espera do advisory commitou %s", state)
		}
		charge, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe)
		if err != nil || charge.ID != probe.chargeID || probe.writes.Load() != 1 || len(probe.kinds) != 1 || probe.kinds[0] != "create:uncertain" {
			t.Fatalf("fase única ou transporte interno: charge=%s writes=%d kinds=%v err=%v", charge.ID, probe.writes.Load(), probe.kinds, err)
		}
		lockScalar(t, d, scope, &state, `select state from provider_issuance where id=$1`, item.ID)
		if state != "issued" {
			t.Fatalf("confirmação não commitou %s", state)
		}
		replayed, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe)
		if err != nil || replayed.ID != charge.ID || probe.writes.Load() != 1 || probe.reads.Load() != 0 || len(probe.kinds) != 1 {
			t.Fatalf("replay reenviou a cobrança: %+v writes=%d reads=%d err=%v", replayed, probe.writes.Load(), probe.reads.Load(), err)
		}
	})

	t.Run("recovery lookup stays outside the transaction", func(t *testing.T) {
		request := lockRequest(t, d, scope, contract, 18181)
		_, version := saveLockCredential(t, d, scope, request.Scope.ConnectionID)
		item, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, request, hash, version, options)
		if err != nil {
			t.Fatal(err)
		}
		probe := &issuanceTransport{
			issuanceFake: issuanceFake{request: request, config: hash, lost: true},
			database:     d, scope: scope, issuance: item.ID, chargeID: uuid.NewString(),
			want: "uncertain", checkRow: true,
		}
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe); err == nil || probe.writes.Load() != 1 || probe.kinds[0] != "create:uncertain" {
			t.Fatalf("perda de resposta não ficou incerta fora da transação: %v kinds=%v", err, probe.kinds)
		}
		var uncertain bool
		lockScalar(t, d, scope, &uncertain, `select state='uncertain' and charge_id is null from provider_issuance where id=$1`, item.ID)
		if !uncertain {
			t.Fatal("fase 1 não permaneceu incerta")
		}
		probe.lost = false
		charge, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe)
		if err != nil || charge.ID != probe.chargeID || probe.writes.Load() != 1 || probe.reads.Load() != 1 || probe.kinds[1] != "lookup:uncertain" {
			t.Fatalf("recuperação reenviou ou consultou dentro da transação: %v kinds=%v writes=%d reads=%d", err, probe.kinds, probe.writes.Load(), probe.reads.Load())
		}
		again, err := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe)
		if err != nil || again.ID != charge.ID || probe.writes.Load() != 1 || probe.reads.Load() != 1 {
			t.Fatalf("replay da recuperação transportou: %v writes=%d reads=%d", err, probe.writes.Load(), probe.reads.Load())
		}
	})

	t.Run("snapshot resolution and reentry", func(t *testing.T) {
		request := lockRequest(t, d, scope, contract, 19191)
		_, version := saveLockCredential(t, d, scope, request.Scope.ConnectionID)
		item, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, request, hash, version, options)
		if err != nil {
			t.Fatal(err)
		}
		paidAt := time.Now().UTC().Format(time.RFC3339Nano)
		probe := &issuanceTransport{
			issuanceFake: issuanceFake{request: request, config: hash},
			database:     d, scope: scope, issuance: item.ID, chargeID: uuid.NewString(),
			want: "uncertain", checkRow: true,
		}
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, probe); err != nil {
			t.Fatal(err)
		}
		probe.want = "issued"
		probe.custom = true
		probe.snapshot = providers.Snapshot{
			Charge: probe.charge(), Status: "active",
			Payments: []providers.Payment{{ID: uuid.NewString(), AmountCents: request.Money.Cents, PaidAt: paidAt, Method: "pix", Currency: "BRL"}},
		}
		factory := func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
			if r.InvoiceID != request.InvoiceID {
				return nil, func() {}, errors.New("emissão sintética de outro teste")
			}
			return probe, func() {}, nil
		}
		parkOtherReceipts(t, d, scope, item.ID)
		probe.checkRow = false
		before := probe.reads.Load()
		blockOnAdvisory(t, d, scope, request.InvoiceID, func(ctx context.Context) error {
			return ReconcileProviderReceipts(ctx, d, scope, factory)
		})
		if probe.reads.Load() <= before {
			t.Fatal("snapshot não consultou antes do lock")
		}
		if lockCount(t, d, scope, `select count(*) from payments where invoice_id=$1`, request.InvoiceID) != 0 {
			t.Fatal("snapshot aplicou recebimento sem o advisory")
		}
		reentry, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		err = d.WithScope(reentry, scope, func(tx *db.Tx) error {
			if e := LockInvoices(reentry, tx, "", request.InvoiceID); e != nil {
				return e
			}
			if e := lockIssuanceInvoice(reentry, tx, item.ID); e != nil {
				return e
			}
			if e := lockIssuanceInvoice(reentry, tx, item.ID); e != nil {
				return e
			}
			return applyProviderSnapshot(reentry, tx, scope.TenantID, item.ID, request, probe.snapshot)
		})
		if err != nil {
			t.Fatal(err)
		}
		if lockCount(t, d, scope, `select count(*) from payments where invoice_id=$1`, request.InvoiceID) != 1 {
			t.Fatal("reentrada após o advisory não aplicou o snapshot")
		}
		err = d.WithScope(reentry, scope, func(tx *db.Tx) error {
			if e := lockIssuanceInvoice(reentry, tx, item.ID); e != nil {
				return e
			}
			return applyProviderSnapshot(reentry, tx, scope.TenantID, item.ID, request, probe.snapshot)
		})
		if err != nil || lockCount(t, d, scope, `select count(*) from payments where invoice_id=$1`, request.InvoiceID) != 1 {
			t.Fatalf("replay do snapshot duplicou recebimento: %v", err)
		}
		probe.checkRow = true
		if err = ReconcileProviderReceipts(ctx, d, scope, factory); err != nil {
			t.Fatal(err)
		}
		if probe.reads.Load() <= before+1 || lockCount(t, d, scope, `select count(*) from payments where invoice_id=$1`, request.InvoiceID) != 1 {
			t.Fatalf("conciliação não passou pelo helper fora da transação reads=%d", probe.reads.Load())
		}

		resolutionRequest := lockRequest(t, d, scope, contract, 20202)
		resolutionUser, resolutionVersion := saveLockCredential(t, d, scope, resolutionRequest.Scope.ConnectionID)
		resolutionItem, err := (SandboxIssuance{DB: d}).prepareOptions(ctx, scope, resolutionRequest, hash, resolutionVersion, options)
		if err != nil {
			t.Fatal(err)
		}
		resolutionProbe := &issuanceTransport{
			issuanceFake: issuanceFake{request: resolutionRequest, config: hash, lost: true},
			database:     d, scope: scope, issuance: resolutionItem.ID, chargeID: uuid.NewString(),
			want: "uncertain", checkRow: true,
		}
		if _, err = (SandboxIssuance{DB: d}).Run(ctx, scope, resolutionItem.ID, resolutionProbe); err == nil || resolutionProbe.writes.Load() != 1 {
			t.Fatalf("resolução não partiu de incerteza: %v", err)
		}
		resolutionProbe.lost = false
		resolutionProbe.custom = true
		resolutionProbe.snapshot = providers.Snapshot{Charge: resolutionProbe.charge(), Status: "active"}
		resolutionProbe.checkRow = false
		resolutionFactory := func(context.Context, providers.Create, string, IssuanceOptions) (ConfiguredAdapter, func(), error) {
			return resolutionProbe, func() {}, nil
		}
		input := ResolutionInput{IntentID: uuid.NewString(), Reason: "Consulta autenticada sem transporte na transação"}
		reads := resolutionProbe.reads.Load()
		blockOnAdvisory(t, d, scope, resolutionRequest.InvoiceID, func(ctx context.Context) error {
			_, err := ResolveProviderResult(ctx, d, scope, resolutionRequest.Scope.ConnectionID, resolutionItem.ID, resolutionUser, "resolve", input, resolutionFactory)
			return err
		})
		if resolutionProbe.reads.Load() <= reads || resolutionProbe.writes.Load() != 1 {
			t.Fatal("resolução transportou de novo ou não consultou fora da transação")
		}
		if lockCount(t, d, scope, `select count(*) from provider_resolution_evidence where issuance_id=$1`, resolutionItem.ID) != 0 {
			t.Fatal("resolução gravou evidência sem o advisory")
		}
		resolutionProbe.checkRow = true
		if _, err = ResolveProviderResult(ctx, d, scope, resolutionRequest.Scope.ConnectionID, resolutionItem.ID, resolutionUser, "resolve", input, resolutionFactory); err != nil {
			t.Fatal(err)
		}
		var resolved bool
		lockScalar(t, d, scope, &resolved, `select state='issued' and charge_id=$2 and (select count(*) from provider_resolution_evidence where issuance_id=$1)=1 from provider_issuance where id=$1`, resolutionItem.ID, resolutionProbe.chargeID)
		if !resolved || resolutionProbe.writes.Load() != 1 {
			t.Fatalf("resolução não confirmou a mesma cobrança writes=%d", resolutionProbe.writes.Load())
		}
		reads = resolutionProbe.reads.Load()
		if _, err = ResolveProviderResult(ctx, d, scope, resolutionRequest.Scope.ConnectionID, resolutionItem.ID, resolutionUser, "resolve", input, resolutionFactory); err != nil || resolutionProbe.reads.Load() != reads || resolutionProbe.writes.Load() != 1 {
			t.Fatalf("replay da resolução voltou ao transporte: %v reads=%d", err, resolutionProbe.reads.Load())
		}
	})
}
