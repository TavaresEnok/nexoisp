package finance

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/tenancy"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type operationFake struct {
	*pipelineFake
	mutations atomic.Int64
	mu        sync.Mutex
	results   map[string]providers.OperationResult
	lost      bool
	pending   bool
}

type crashOperationAdapter struct {
	issuanceFake
	marker string
	after  bool
}

func (a *crashOperationAdapter) ExecuteOperation(_ context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	raw, _ := json.Marshal(map[string]any{"after_effect": a.after, "request": op})
	if e := os.WriteFile(a.marker+".tmp", raw, 0600); e != nil {
		return providers.OperationResult{}, e
	}
	if e := os.Rename(a.marker+".tmp", a.marker); e != nil {
		return providers.OperationResult{}, e
	}
	select {}
}
func (a *crashOperationAdapter) LookupOperation(context.Context, providers.OperationRequest) (providers.OperationResult, error) {
	return providers.OperationResult{}, errors.New("unexpected child lookup")
}
func TestProviderOperationProcessRecovery(t *testing.T) {
	if id := os.Getenv("NEXO_PROVIDER_OPERATION_CHILD"); id != "" {
		d, scope := issuanceDatabase(t)
		var hash string
		if e := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			return tx.QueryRow(context.Background(), `select j.config_hash from provider_operations o join provider_issuance j on j.id=o.issuance_id where o.id=$1`, id).Scan(&hash)
		}); e != nil {
			t.Fatal(e)
		}
		factory := func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
			return &crashOperationAdapter{issuanceFake: issuanceFake{request: r, config: hash}, marker: os.Getenv("NEXO_PROVIDER_OPERATION_MARKER"), after: os.Getenv("NEXO_PROVIDER_OPERATION_AFTER") == "1"}, func() {}, nil
		}
		e := RunProviderOperation(context.Background(), d, scope, id, factory, true)
		t.Fatalf("child returned unexpectedly %v", e)
	}
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	for _, after := range []bool{false, true} {
		name := "before_effect"
		if after {
			name = "after_effect"
		}
		t.Run(name, func(t *testing.T) {
			d, scope := issuanceDatabase(t)
			item, base := preparePipeline(t, d, scope)
			ctx := context.Background()
			if _, e := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, base); e != nil {
				t.Fatal(e)
			}
			id := prepareOperation(t, d, scope, item, ProviderOperationInput{IntentID: uuid.NewString(), Kind: "cancel", Reason: "Synthetic SIGKILL process recovery"})
			marker := filepath.Join(t.TempDir(), "effect.json")
			mode := "0"
			if after {
				mode = "1"
			}
			process := osexec.Command(os.Args[0], "-test.run=^TestProviderOperationProcessRecovery$")
			process.Env = append(os.Environ(), "NEXO_PROVIDER_OPERATION_CHILD="+id, "NEXO_PROVIDER_OPERATION_MARKER="+marker, "NEXO_PROVIDER_OPERATION_AFTER="+mode)
			if e := process.Start(); e != nil {
				t.Fatal(e)
			}
			t.Cleanup(func() { _ = process.Process.Kill() })
			deadline := time.Now().Add(15 * time.Second)
			for {
				if _, e := os.Stat(marker); e == nil {
					break
				}
				if time.Now().After(deadline) {
					_ = process.Process.Kill()
					_ = process.Wait()
					t.Fatal("child did not reach committed transport boundary")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if e := process.Process.Kill(); e != nil {
				t.Fatal(e)
			}
			if e := process.Wait(); e == nil {
				t.Fatal("expected SIGKILL")
			}
			var recorded struct {
				After   bool                       `json:"after_effect"`
				Request providers.OperationRequest `json:"request"`
			}
			raw, e := os.ReadFile(marker)
			if e != nil {
				t.Fatal(e)
			}
			if e = json.Unmarshal(raw, &recorded); e != nil {
				t.Fatal(e)
			}
			fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}}
			if recorded.After {
				fake.results[recorded.Request.ID] = providers.OperationResult{State: "confirmed"}
			}
			factory := func(context.Context, providers.Create, string, IssuanceOptions) (ConfiguredAdapter, func(), error) {
				return fake, func() {}, nil
			}
			e = RunProviderOperation(ctx, d, scope, id, factory, false)
			if after && e != nil {
				t.Fatal(e)
			}
			if !after && e == nil {
				t.Fatal("missing remote effect was invented")
			}
			if fake.mutations.Load() != 0 {
				t.Fatal("restart resent operation")
			}
			var state string
			if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
				return tx.QueryRow(ctx, `select state from provider_operations where id=$1`, id).Scan(&state)
			}); e != nil {
				t.Fatal(e)
			}
			want := "uncertain"
			if after {
				want = "confirmed"
			}
			if state != want {
				t.Errorf("state %s expected %s", state, want)
			}
		})
	}
}

func (f *operationFake) ExecuteOperation(_ context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	f.mutations.Add(1)
	r := providers.OperationResult{State: "confirmed"}
	if op.Kind == "refund" {
		r.Refund = &providers.Refund{ID: op.ID, ReturnID: "D" + op.ID, PaymentID: op.Payment.ID, AmountCents: op.AmountCents, SettledAt: "2026-10-26T13:00:00Z"}
	}
	if f.pending {
		r = providers.OperationResult{State: "pending"}
	}
	f.mu.Lock()
	f.results[op.ID] = r
	f.mu.Unlock()
	if f.lost {
		return providers.OperationResult{}, &providers.Failure{Kind: providers.Unknown, Cause: errors.New("synthetic response lost after remote effect")}
	}
	return r, nil
}

func TestPendingAndRejectedRefundDoNotPostCash(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	item, base := preparePipeline(t, d, scope)
	ctx := context.Background()
	if _, e := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, base); e != nil {
		t.Fatal(e)
	}
	p := providers.Payment{ID: uuid.NewString(), AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}
	var payment string
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if _, _, e := Payment(ctx, tx, item.Request.InvoiceID, "efi", item.Request.Scope.ConnectionID, paymentObject(p), "reconciliation"); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select id from payments where invoice_id=$1 and kind='payment'`, item.Request.InvoiceID).Scan(&payment)
	}); e != nil {
		t.Fatal(e)
	}
	input := ProviderOperationInput{IntentID: uuid.NewString(), Kind: "refund", PaymentID: payment, AmountCents: 12345, Reason: "Synthetic pending refund must not post cash"}
	id := prepareOperation(t, d, scope, item, input)
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update invoices set provider_canceled_at=now() where id=$1`, item.Request.InvoiceID)
	}); e == nil {
		t.Fatal("cancellation marker accepted without confirmed operation")
	}
	fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}, pending: true}
	factory := func(context.Context, providers.Create, string, IssuanceOptions) (ConfiguredAdapter, func(), error) {
		return fake, func() {}, nil
	}
	if e := RunProviderOperation(ctx, d, scope, id, factory, true); e != nil {
		t.Fatal(e)
	}
	var remote, state string
	var count int
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select state,remote_id from provider_operations where id=$1`, id).Scan(&state, &remote); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1 and kind='reversal'`, item.Request.InvoiceID).Scan(&count)
	}); e != nil {
		t.Fatal(e)
	}
	if state != "uncertain" || count != 0 {
		t.Fatal("accepted/pending refund was treated as confirmed")
	}
	fake.mu.Lock()
	fake.results[remote] = providers.OperationResult{State: "rejected"}
	fake.mu.Unlock()
	if e := RunProviderOperation(ctx, d, scope, id, factory, false); e != nil {
		t.Fatal(e)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select state from provider_operations where id=$1`, id).Scan(&state); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1 and kind='reversal'`, item.Request.InvoiceID).Scan(&count)
	}); e != nil {
		t.Fatal(e)
	}
	if state != "rejected" || count != 0 || fake.mutations.Load() != 1 {
		t.Fatal("rejected refund changed cash or resent request")
	}
	input.IntentID = uuid.NewString()
	if next := prepareOperation(t, d, scope, item, input); next == id {
		t.Fatal("legitimate new intention after authoritative rejection was not allowed")
	}
}
func (f *operationFake) LookupOperation(_ context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r, ok := f.results[op.ID]
	if !ok {
		return providers.OperationResult{}, &providers.Failure{Kind: providers.Unavailable}
	}
	return r, nil
}
func prepareOperation(t *testing.T, d *db.DB, scope tenancy.Scope, item Issuance, input ProviderOperationInput) string {
	t.Helper()
	var id string
	if err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		var user string
		if e := tx.QueryRow(context.Background(), `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		r, _, e := PrepareProviderOperation(context.Background(), tx, item.ID, item.Request.Scope.ConnectionID, user, input)
		if e == nil {
			id = r.Get("id").(string)
		}
		return e
	}); err != nil {
		t.Fatal(err)
	}
	return id
}
func TestProviderOperationLostResponseAndLookupOnlyRecovery(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	item, base := preparePipeline(t, d, scope)
	ctx := context.Background()
	if _, e := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, base); e != nil {
		t.Fatal(e)
	}
	fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}, lost: true}
	factory := func(_ context.Context, r providers.Create, _ string, _ IssuanceOptions) (ConfiguredAdapter, func(), error) {
		if r.InvoiceID != item.Request.InvoiceID {
			return nil, func() {}, errors.New("unrelated fixture")
		}
		return fake, func() {}, nil
	}
	input := ProviderOperationInput{IntentID: uuid.NewString(), Kind: "cancel", Reason: "Synthetic cancellation with lost acknowledgment"}
	id := prepareOperation(t, d, scope, item, input)
	if again := prepareOperation(t, d, scope, item, input); again != id {
		t.Fatal("prepare replay changed operation")
	}
	if e := RunProviderOperation(ctx, d, scope, id, factory, false); e != nil {
		t.Fatal(e)
	}
	if fake.mutations.Load() != 0 {
		t.Fatal("write gate consumed prepared operation")
	}
	if e := RunProviderOperation(ctx, d, scope, id, factory, true); e == nil {
		t.Fatal("lost acknowledgment expected")
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := RunProviderOperation(ctx, d, scope, id, factory, false); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if fake.mutations.Load() != 1 {
		t.Fatal("recovery resent cancellation")
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update provider_operations set state='prepared' where id=$1`, id)
	}); e == nil {
		t.Fatal("terminal operation returned to send state")
	}
	payment := providers.Payment{ID: uuid.NewString(), AmountCents: 12345, PaidAt: "2026-10-26T14:00:00Z", Method: "bolix", Currency: "BRL"}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		_, status, e := Payment(ctx, tx, item.Request.InvoiceID, "efi", item.Request.Scope.ConnectionID, paymentObject(payment), "reconciliation")
		if e == nil && status != "reconciling" {
			t.Error("late payment after cancellation did not enter review")
		}
		return e
	}); e != nil {
		t.Fatal(e)
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var status string
		var marked bool
		var effects int
		if e := tx.QueryRow(ctx, `select status,provider_canceled_at is not null from invoices where id=$1`, item.Request.InvoiceID).Scan(&status, &marked); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*) from payment_effects where invoice_id=$1`, item.Request.InvoiceID).Scan(&effects); e != nil {
			return e
		}
		if status != "reconciling" || !marked || effects != 0 {
			t.Errorf("cancellation/late cash status=%s marked=%v effects=%d", status, marked, effects)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}
func TestRefundOperationReservesCashAndAppendsOnlyAfterConfirmation(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("s", 32))))
	d, scope := issuanceDatabase(t)
	item, base := preparePipeline(t, d, scope)
	ctx := context.Background()
	if _, e := (SandboxIssuance{DB: d}).Run(ctx, scope, item.ID, base); e != nil {
		t.Fatal(e)
	}
	p := providers.Payment{ID: uuid.NewString(), AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}
	var payment string
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if _, _, e := Payment(ctx, tx, item.Request.InvoiceID, "efi", item.Request.Scope.ConnectionID, paymentObject(p), "reconciliation"); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select id from payments where invoice_id=$1 and kind='payment'`, item.Request.InvoiceID).Scan(&payment)
	}); e != nil {
		t.Fatal(e)
	}
	input := ProviderOperationInput{IntentID: uuid.NewString(), Kind: "refund", PaymentID: payment, AmountCents: 4000, Reason: "Synthetic partial refund intention"}
	id := prepareOperation(t, d, scope, item, input)
	second := input
	second.IntentID = uuid.NewString()
	secondID := prepareOperation(t, d, scope, item, second)
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var user string
		if e := tx.QueryRow(ctx, `select id from users order by id limit 1`).Scan(&user); e != nil {
			return e
		}
		bad := input
		bad.IntentID = uuid.NewString()
		bad.AmountCents = 5000
		_, _, e := PrepareProviderOperation(ctx, tx, item.ID, item.Request.Scope.ConnectionID, user, bad)
		return e
	}); e == nil {
		t.Fatal("pending reservations failed to cap refunds")
	}
	fake := &operationFake{pipelineFake: base, results: map[string]providers.OperationResult{}, lost: true}
	factory := func(context.Context, providers.Create, string, IssuanceOptions) (ConfiguredAdapter, func(), error) {
		return fake, func() {}, nil
	}
	if e := RunProviderOperation(ctx, d, scope, id, factory, true); e == nil {
		t.Fatal("lost refund response expected")
	}
	if e := RunProviderOperation(ctx, d, scope, id, factory, false); e != nil {
		t.Fatal(e)
	}
	if e := RunProviderOperation(ctx, d, scope, id, factory, true); e != nil {
		t.Fatal(e)
	}
	if fake.mutations.Load() != 1 {
		t.Fatal("refund re-sent after commit/replay")
	}
	if e := RunProviderOperation(ctx, d, scope, secondID, factory, false); e != nil {
		t.Fatal(e)
	}
	if fake.mutations.Load() != 1 {
		t.Fatal("lookup-only sent another legitimate intention")
	}
	if e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var n, total int
		if e := tx.QueryRow(ctx, `select count(*),coalesce(sum(amount_cents),0) from payments where invoice_id=$1 and kind='reversal'`, item.Request.InvoiceID).Scan(&n, &total); e != nil {
			return e
		}
		if n != 1 || total != 4000 {
			t.Errorf("cash posted without confirmed refund n=%d total=%d", n, total)
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
}
