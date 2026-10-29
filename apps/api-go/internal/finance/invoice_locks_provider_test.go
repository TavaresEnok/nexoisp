package finance

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
)

var errProviderLockRollback = errors.New("rollback provider lock test")

func TestProviderOperationAndRefundLockOrder(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := openProviderLockDatabase(t)
	ctx := context.Background()
	item, base := providerLockIssue(t, d, scope)
	user := providerLockUser(t, d, scope)
	invoice := item.Request.InvoiceID
	other := providerLockOtherInvoice(t, d, scope, invoice)

	t.Run("prepare waits on advisory before the invoice row", func(t *testing.T) {
		input := ProviderOperationInput{IntentID: uuid.NewString(), Kind: "cancel", Reason: "Preparação espera o consultivo da fatura"}
		cancelWhenProviderWaiting(t, d, scope, invoice, func(runCtx context.Context) error {
			return d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				_, _, err := PrepareProviderOperation(runCtx, tx, item.ID, item.Request.Scope.ConnectionID, user, input)
				if err != nil {
					return err
				}
				return errProviderLockRollback
			})
		})
		if n := providerCount(t, d, scope, `select count(*) from provider_operations where issuance_id=$1 and intent_id=$2`, item.ID, input.IntentID); n != 0 {
			t.Fatalf("preparação cancelada gravou %d operações", n)
		}
		var first, remote string
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			row, created, err := PrepareProviderOperation(ctx, tx, item.ID, item.Request.Scope.ConnectionID, user, input)
			if err != nil || !created {
				return fmt.Errorf("preparação após a espera: created=%v err=%v", created, err)
			}
			first = row.Get("id").(string)
			return tx.QueryRow(ctx, `select remote_id from provider_operations where id=$1`, first).Scan(&remote)
		}); err != nil {
			t.Fatal(err)
		}
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			row, created, err := PrepareProviderOperation(ctx, tx, item.ID, item.Request.Scope.ConnectionID, user, input)
			if err != nil || created || row.Get("id") != first {
				return fmt.Errorf("replay id=%v created=%v err=%v", row.Get("id"), created, err)
			}
			var again string
			if err = tx.QueryRow(ctx, `select remote_id from provider_operations where id=$1`, first).Scan(&again); err != nil {
				return err
			}
			if again != remote || len(remote) != 32 {
				return fmt.Errorf("identidade remota %q -> %q", remote, again)
			}
			return errProviderLockRollback
		}); !errors.Is(err, errProviderLockRollback) {
			t.Fatal(err)
		}
		if n := providerCount(t, d, scope, `select count(*) from provider_operations where id=$1`, first); n != 0 {
			t.Fatal("replay da preparação não foi desfeito")
		}
	})

	t.Run("inverse overlap does not deadlock", func(t *testing.T) {
		input := ProviderOperationInput{IntentID: uuid.NewString(), Kind: "cancel", Reason: "Sobreposição inversa da preparação"}
		runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		ready := make(chan struct{})
		start := make(chan struct{})
		errCh := make(chan error, 2)
		go func() {
			errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				if err := signalProvider(runCtx, ready, start); err != nil {
					return err
				}
				if _, _, err := PrepareProviderOperation(runCtx, tx, item.ID, item.Request.Scope.ConnectionID, user, input); err != nil {
					return err
				}
				return errProviderLockRollback
			})
		}()
		go func() {
			errCh <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				if err := signalProvider(runCtx, ready, start); err != nil {
					return err
				}
				if err := LockInvoices(runCtx, tx, "", other, invoice); err != nil {
					return err
				}
				return errProviderLockRollback
			})
		}()
		for range 2 {
			select {
			case <-ready:
			case err := <-errCh:
				t.Fatal(err)
			case <-runCtx.Done():
				t.Fatal(runCtx.Err())
			}
		}
		close(start)
		for range 2 {
			if err := <-errCh; !errors.Is(err, errProviderLockRollback) {
				t.Fatalf("sobreposição da operação: %v", err)
			}
		}
	})

	opID := prepareOperation(t, d, scope, item, ProviderOperationInput{IntentID: uuid.NewString(), Kind: "cancel", Reason: "Cancelamento sintético sob o protocolo de locks"})
	remote := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, opID)
	factoryOf := func(gate *lockGate) AdapterFactory {
		return func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
			if r.InvoiceID != invoice {
				return nil, func() {}, errors.New("unrelated fixture")
			}
			return gate, func() {}, nil
		}
	}

	t.Run("execution and write gate wait before transport", func(t *testing.T) {
		for _, allowWrites := range []bool{false, true} {
			calls := atomic.Int32{}
			fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}}
			gate := &lockGate{operationFake: fake, execGate: func(providers.OperationRequest) error {
				calls.Add(1)
				return errors.New("transporte não pode começar enquanto o consultivo estiver ocupado")
			}}
			cancelWhenProviderWaiting(t, d, scope, invoice, func(runCtx context.Context) error {
				return RunProviderOperation(runCtx, d, scope, opID, factoryOf(gate), allowWrites)
			})
			if calls.Load() != 0 {
				t.Fatalf("allowWrites=%v transportou durante a espera", allowWrites)
			}
			if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "prepared" {
				t.Fatalf("allowWrites=%v estado %s", allowWrites, state)
			}
		}
		if got := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, opID); got != remote {
			t.Fatalf("identidade remota %s -> %s", remote, got)
		}
	})

	t.Run("lost transport recovers once without holding the invoice", func(t *testing.T) {
		fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}}
		gate := &lockGate{operationFake: fake, execGate: func(providers.OperationRequest) error {
			if err := providerInvoiceNowait(d, scope, invoice); err != nil {
				return fmt.Errorf("transporte segurou a fatura: %w", err)
			}
			if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "uncertain" {
				return fmt.Errorf("transporte antes do commit da incerteza: %s", state)
			}
			return &providers.Failure{Kind: providers.Unknown, Cause: errors.New("synthetic response lost after remote effect")}
		}}
		if err := RunProviderOperation(ctx, d, scope, opID, factoryOf(gate), true); err == nil {
			t.Fatal("resposta perdida deveria falhar")
		}
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "uncertain" {
			t.Fatalf("estado após perda: %s", state)
		}
		if providerCanceled(t, d, scope, invoice) {
			t.Fatal("perda de resposta cancelou a cobrança")
		}
		if got := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, opID); got != remote {
			t.Fatalf("identidade remota %s -> %s", remote, got)
		}
	})

	t.Run("retry lookup waits then keeps the remote identity", func(t *testing.T) {
		cancelWhenProviderWaiting(t, d, scope, invoice, func(runCtx context.Context) error {
			return d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				return RequeueProviderOperationLookup(runCtx, tx, "", item.ID, opID)
			})
		})
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "uncertain" {
			t.Fatalf("retentativa cancelada alterou o estado para %s", state)
		}
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update provider_operations set state='review' where id=$1 and state='uncertain'`, opID)
		}); err != nil {
			t.Fatal(err)
		}
		cancelWhenProviderWaiting(t, d, scope, invoice, func(runCtx context.Context) error {
			return d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				return RequeueProviderOperationLookup(runCtx, tx, scope.TenantID, item.ID, opID)
			})
		})
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "review" {
			t.Fatalf("retentativa em revisão cancelada deixou %s", state)
		}
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return RequeueProviderOperationLookup(ctx, tx, "", item.ID, opID)
		}); err != nil {
			t.Fatal(err)
		}
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "uncertain" {
			t.Fatalf("retentativa confirmada deixou %s", state)
		}
		if got := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, opID); got != remote {
			t.Fatalf("identidade remota %s -> %s", remote, got)
		}
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return RequeueProviderOperationLookup(ctx, tx, "", item.ID, uuid.NewString())
		})
		var api *apierr.Error
		if !errors.As(err, &api) || api.Status != 404 {
			t.Fatalf("operação ausente: %v", err)
		}
	})

	t.Run("post-transport waits on advisory and a late return does not repeat", func(t *testing.T) {
		fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}}
		started := make(chan struct{})
		releaseLook := make(chan struct{})
		var once sync.Once
		probe := make(chan error, 1)
		gate := &lockGate{operationFake: fake, lookGate: func(providers.OperationRequest) (providers.OperationResult, error) {
			once.Do(func() { close(started) })
			if err := providerInvoiceNowait(d, scope, invoice); err != nil {
				probe <- fmt.Errorf("consulta segurou a fatura: %w", err)
			} else if state, err := providerQuery(d, scope, `select state from provider_operations where id=$1`, opID); err != nil {
				probe <- err
			} else if state != "uncertain" {
				probe <- fmt.Errorf("consulta viu %s", state)
			} else {
				probe <- nil
			}
			<-releaseLook
			return providers.OperationResult{State: "confirmed"}, nil
		}}
		runCtx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			done <- RunProviderOperation(runCtx, d, scope, opID, factoryOf(gate), false)
		}()
		select {
		case <-started:
		case err := <-done:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("a consulta não começou")
		}
		if err := <-probe; err != nil {
			t.Fatal(err)
		}
		release, held, holderDone := holdProviderAdvisory(t, d, scope, invoice)
		defer release()
		waitProviderHeld(t, held, holderDone)
		close(releaseLook)
		waitAdvisoryBeforeRow(t, d, scope, invoice)
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) && !providerLockWait(err) {
				t.Fatalf("fase posterior: %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("o cancelamento não desbloqueou a fase posterior")
		}
		release()
		if err := <-holderDone; !errors.Is(err, errProviderLockRollback) {
			t.Fatal(err)
		}
		if providerCanceled(t, d, scope, invoice) {
			t.Fatal("fase posterior cancelada gravou o efeito")
		}
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "uncertain" {
			t.Fatalf("fase posterior cancelada deixou %s", state)
		}
		confirm := &lockGate{operationFake: fake, lookGate: func(providers.OperationRequest) (providers.OperationResult, error) {
			return providers.OperationResult{State: "confirmed"}, nil
		}}
		if err := RunProviderOperation(ctx, d, scope, opID, factoryOf(confirm), false); err != nil {
			t.Fatal(err)
		}
		if err := RunProviderOperation(ctx, d, scope, opID, factoryOf(confirm), true); err != nil {
			t.Fatal(err)
		}
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, opID); state != "confirmed" {
			t.Fatalf("retorno tardio deixou %s", state)
		}
		if !providerCanceled(t, d, scope, invoice) {
			t.Fatal("cancelamento confirmado não marcou a cobrança")
		}
		if got := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, opID); got != remote {
			t.Fatalf("identidade remota %s -> %s", remote, got)
		}
	})

	refundItem, refundBase := providerLockIssue(t, d, scope)
	refundInvoice := refundItem.Request.InvoiceID
	gatewayID := uuid.NewString()
	receipt := providers.Payment{ID: gatewayID, AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}
	var paymentID string
	if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if _, _, err := Payment(ctx, tx, refundInvoice, "efi", refundItem.Request.Scope.ConnectionID, paymentObject(receipt), "reconciliation"); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select id::text from payments where invoice_id=$1 and kind='payment'`, refundInvoice).Scan(&paymentID)
	}); err != nil {
		t.Fatal(err)
	}
	direct := providers.Refund{ID: "lock-refund", ReturnID: "lock-return", PaymentID: gatewayID, AmountCents: 3000, SettledAt: "2026-10-26T13:00:00Z"}

	t.Run("refund waits on advisory before the reversal", func(t *testing.T) {
		cancelWhenProviderWaiting(t, d, scope, refundInvoice, func(runCtx context.Context) error {
			return d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				_, err := ApplyProviderRefund(runCtx, tx, refundInvoice, refundItem.Request.Scope.ConnectionID, direct)
				return err
			})
		})
		if n := providerCount(t, d, scope, `select count(*) from payments where invoice_id=$1 and kind='reversal'`, refundInvoice); n != 0 {
			t.Fatalf("devolução cancelada gravou %d estornos", n)
		}
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if _, err := ApplyProviderRefund(ctx, tx, refundInvoice, refundItem.Request.Scope.ConnectionID, direct); err != nil {
				return err
			}
			_, err := ApplyProviderRefund(ctx, tx, refundInvoice, refundItem.Request.Scope.ConnectionID, direct)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if n := providerCount(t, d, scope, `select count(*) from payments where invoice_id=$1 and provider_refund_id=$2`, refundInvoice, direct.ID); n != 1 {
			t.Fatalf("replay da devolução gravou %d linhas", n)
		}
	})

	refundOp := prepareOperation(t, d, scope, refundItem, ProviderOperationInput{IntentID: uuid.NewString(), Kind: "refund", PaymentID: paymentID, AmountCents: 4000, Reason: "Devolução sintética sob o protocolo de locks"})
	refundRemote := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, refundOp)

	t.Run("refund retry rejects prepared and the run posts once", func(t *testing.T) {
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			return RequeueProviderOperationLookup(ctx, tx, "", refundItem.ID, refundOp)
		})
		var api *apierr.Error
		if !errors.As(err, &api) || api.Status != 409 {
			t.Fatalf("retentativa de preparada: %v", err)
		}
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, refundOp); state != "prepared" {
			t.Fatalf("retentativa recusada deixou %s", state)
		}
		fake := &operationFake{pipelineFake: refundBase, results: map[string]providers.OperationResult{}}
		posted := make(chan struct{})
		gate := &lockGate{operationFake: fake, execGate: func(op providers.OperationRequest) error {
			if err := providerInvoiceNowait(d, scope, refundInvoice); err != nil {
				return fmt.Errorf("transporte da devolução segurou a fatura: %w", err)
			}
			if op.ID != refundRemote {
				return fmt.Errorf("identidade remota transportada %s", op.ID)
			}
			close(posted)
			return &providers.Failure{Kind: providers.Unknown, Cause: errors.New("synthetic refund response lost")}
		}}
		factory := func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
			if r.InvoiceID != refundInvoice {
				return nil, func() {}, errors.New("unrelated fixture")
			}
			return gate, func() {}, nil
		}
		if err = RunProviderOperation(ctx, d, scope, refundOp, factory, true); err == nil {
			t.Fatal("resposta perdida da devolução deveria falhar")
		}
		select {
		case <-posted:
		default:
			t.Fatal("transporte da devolução não correu")
		}
		if n := providerCount(t, d, scope, `select count(*) from payments where invoice_id=$1 and kind='reversal' and provider_refund_id is not null and provider_refund_id<>$2`, refundInvoice, direct.ID); n != 0 {
			t.Fatalf("perda de resposta lançou %d devoluções", n)
		}
		cancelWhenProviderWaiting(t, d, scope, refundInvoice, func(runCtx context.Context) error {
			return RunProviderOperation(runCtx, d, scope, refundOp, factory, false)
		})
		confirmed := providers.OperationResult{State: "confirmed", Refund: &providers.Refund{ID: refundRemote, ReturnID: "D" + refundRemote, PaymentID: gatewayID, AmountCents: 4000, SettledAt: "2026-10-26T13:00:00Z"}}
		gate.lookGate = func(providers.OperationRequest) (providers.OperationResult, error) { return confirmed, nil }
		gate.execGate = func(providers.OperationRequest) error { return errors.New("consulta não pode reenviar a devolução") }
		if err = RunProviderOperation(ctx, d, scope, refundOp, factory, false); err != nil {
			t.Fatal(err)
		}
		if err = RunProviderOperation(ctx, d, scope, refundOp, factory, true); err != nil {
			t.Fatal(err)
		}
		if n := providerCount(t, d, scope, `select count(*) from payments where invoice_id=$1 and provider_refund_id=$2`, refundInvoice, refundRemote); n != 1 {
			t.Fatalf("retorno tardio da devolução gravou %d linhas", n)
		}
		if got := providerText(t, d, scope, `select remote_id from provider_operations where id=$1`, refundOp); got != refundRemote {
			t.Fatalf("identidade remota %s -> %s", refundRemote, got)
		}
		if state := providerText(t, d, scope, `select state from provider_operations where id=$1`, refundOp); state != "confirmed" {
			t.Fatalf("devolução ficou %s", state)
		}
	})
}

type lockGate struct {
	*operationFake
	execGate func(providers.OperationRequest) error
	lookGate func(providers.OperationRequest) (providers.OperationResult, error)
}

func (g *lockGate) ExecuteOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	if g.execGate != nil {
		if err := g.execGate(op); err != nil {
			return providers.OperationResult{}, err
		}
	}
	return g.operationFake.ExecuteOperation(ctx, op)
}

func (g *lockGate) LookupOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	if g.lookGate != nil {
		return g.lookGate(op)
	}
	return g.operationFake.LookupOperation(ctx, op)
}

func openProviderLockDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL ausente; este skip não aprova concorrência, RLS nem rollback")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var name, tenant string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database()`).Scan(&name); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatal(err)
	}
	if name != "nexo_test" {
		t.Fatalf("banco %s recusado; só o laboratório descartável nexo_test pode executar o teste de locks", name)
	}
	return d, tenancy.Scope{TenantID: tenant}
}

func providerLockIssue(t *testing.T, d *db.DB, scope tenancy.Scope) (Issuance, *pipelineFake) {
	t.Helper()
	item, base := preparePipeline(t, d, scope)
	if _, err := (SandboxIssuance{DB: d}).Run(context.Background(), scope, item.ID, base); err != nil {
		t.Fatal(err)
	}
	return item, base
}

func providerLockUser(t *testing.T, d *db.DB, scope tenancy.Scope) string {
	t.Helper()
	var user string
	if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select id::text from users order by id limit 1`).Scan(&user)
	}); err != nil {
		t.Fatal(err)
	}
	return user
}

func providerLockOtherInvoice(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string) string {
	t.Helper()
	var id string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
select tenant_id, contract_id, subscriber_id, 'manual', '2026-12-20', 1900 from invoices where id=$1::uuid returning id::text`, invoice).Scan(&id)
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func holdProviderAdvisory(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string) (func(), <-chan struct{}, <-chan error) {
	t.Helper()
	releaseCh := make(chan struct{})
	held := make(chan struct{})
	done := make(chan error, 1)
	var once sync.Once
	release := func() { once.Do(func() { close(releaseCh) }) }
	go func() {
		done <- d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			if err := tx.Exec(context.Background(), `select pg_advisory_xact_lock(hashtextextended($1,$2))`, scope.TenantID+":invoice:"+invoice, invoiceAdvisorySalt); err != nil {
				return err
			}
			close(held)
			<-releaseCh
			return errProviderLockRollback
		})
	}()
	return release, held, done
}

func waitProviderHeld(t *testing.T, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("advisory não adquirido")
	}
}

func cancelWhenProviderWaiting(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string, run func(context.Context) error) {
	t.Helper()
	release, held, holderDone := holdProviderAdvisory(t, d, scope, invoice)
	defer release()
	waitProviderHeld(t, held, holderDone)
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(runCtx) }()
	waitAdvisoryBeforeRow(t, d, scope, invoice)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) && !providerLockWait(err) {
			t.Fatalf("espera do advisory: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("o cancelamento não desbloqueou a espera")
	}
	release()
	if err := <-holderDone; !errors.Is(err, errProviderLockRollback) {
		t.Fatal(err)
	}
}

func waitAdvisoryBeforeRow(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	key := scope.TenantID + ":invoice:" + invoice
	for {
		if time.Now().After(deadline) {
			t.Fatal("a transação não pediu o advisory")
		}
		var n int
		err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			return tx.QueryRow(context.Background(), `select count(*) from pg_locks
where locktype = 'advisory' and not granted and objsubid = 1
  and database = (select oid from pg_database where datname = current_database())
  and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, $2)`, key, invoiceAdvisorySalt).Scan(&n)
		})
		if err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			if err = providerInvoiceNowait(d, scope, invoice); err != nil {
				t.Fatalf("row lock de invoice antes do advisory: %v", err)
			}
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func providerInvoiceNowait(d *db.DB, scope tenancy.Scope, id string) error {
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if _, err := tx.Objects(context.Background(), `select id::text as id from invoices where id=$1::uuid for update nowait`, id); err != nil {
			return err
		}
		return errProviderLockRollback
	})
	if errors.Is(err, errProviderLockRollback) {
		return nil
	}
	return err
}

func providerLockWait(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return true
	}
	var pg *pgconn.PgError
	return errors.As(err, &pg) && (pg.Code == "55P03" || pg.Code == "57014")
}

func signalProvider(ctx context.Context, ready, start chan struct{}) error {
	select {
	case ready <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-start:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func providerQuery(d *db.DB, scope tenancy.Scope, sql string, args ...any) (string, error) {
	var value string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), sql, args...).Scan(&value)
	})
	return value, err
}

func providerText(t *testing.T, d *db.DB, scope tenancy.Scope, sql string, args ...any) string {
	t.Helper()
	value, err := providerQuery(d, scope, sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func providerCount(t *testing.T, d *db.DB, scope tenancy.Scope, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), sql, args...).Scan(&n)
	}); err != nil {
		t.Fatal(err)
	}
	return n
}

func providerCanceled(t *testing.T, d *db.DB, scope tenancy.Scope, invoice string) bool {
	t.Helper()
	var marked bool
	if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select provider_canceled_at is not null from invoices where id=$1::uuid`, invoice).Scan(&marked)
	}); err != nil {
		t.Fatal(err)
	}
	return marked
}
