package providers

// HTTP PSP simulator exists ONLY in test compilation. No URLs, failure knobs,
// simulator provider or generic HTTP client are selectable in the application.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type labClient struct {
	url    string
	client *http.Client
}

var _ Adapter = (*labClient)(nil)

func (c labClient) CreateCharge(ctx context.Context, r Create) (Charge, error) {
	if err := r.Validate(); err != nil {
		return Charge{}, err
	}
	raw, _ := json.Marshal(r)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/charges", strings.NewReader(string(raw)))
	req.Header.Set("Idempotency-Key", r.IntentKey)
	response, err := c.client.Do(req)
	if err != nil {
		return Charge{}, &Failure{Kind: Unknown, Cause: err}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 {
		kind := Unknown
		if response.StatusCode == 400 {
			kind = Rejected
		}
		if response.StatusCode == 409 {
			kind = Conflict
		}
		return Charge{}, &Failure{Kind: kind, RetryAfter: time.Second, Cause: fmt.Errorf("HTTP %d", response.StatusCode)}
	}
	var charge Charge
	if err = json.NewDecoder(response.Body).Decode(&charge); err != nil {
		return charge, &Failure{Kind: Unknown, Cause: err}
	}
	if err = ValidateIssued(r, charge); err != nil {
		return charge, &Failure{Kind: Unknown, Cause: err}
	}
	return charge, nil
}
func (c labClient) Lookup(ctx context.Context, r Reference) (Snapshot, error) {
	raw, _ := json.Marshal(r)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/lookup", strings.NewReader(string(raw)))
	response, err := c.client.Do(req)
	if err != nil {
		return Snapshot{}, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 {
		return Snapshot{}, &Failure{Kind: Unavailable, Cause: errors.New("lookup unavailable")}
	}
	var snapshot Snapshot
	if err = json.NewDecoder(response.Body).Decode(&snapshot); err != nil {
		return snapshot, err
	}
	return snapshot, ValidateSnapshot(r, snapshot)
}
func requestFixture() Create {
	return Create{Scope: Scope{ConnectionID: "conn-A", TenantID: "tenant-A", Provider: "test-only", Environment: "sandbox", AccountRef: "account-A"}, IntentKey: "persisted-intent-A", InvoiceID: "invoice-A", Money: Money{10000, "BRL"}, DueDate: "2026-11-10"}
}

type simulator struct {
	mu               sync.Mutex
	mode             string
	charges          map[string]Charge
	writes           int
	entered, release chan struct{}
}

func (s *simulator) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.URL.Path == "/lookup" {
		var ref Reference
		if json.NewDecoder(r.Body).Decode(&ref) != nil {
			w.WriteHeader(400)
			return
		}
		charge, ok := s.charges[ref.Scope.ConnectionID+":"+ref.IntentKey]
		if !ok {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(Snapshot{Charge: charge})
		return
	}
	var req Create
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		w.WriteHeader(400)
		return
	}
	if req.Validate() != nil || req.IntentKey != r.Header.Get("Idempotency-Key") {
		w.WriteHeader(400)
		return
	}
	if s.mode == "429" {
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(429)
		return
	}
	if s.mode == "timeout-before" {
		close(s.entered)
		<-s.release
		return
	}
	key := req.Scope.ConnectionID + ":" + req.IntentKey
	charge, ok := s.charges[key]
	if ok && ValidateIssued(req, charge) != nil {
		w.WriteHeader(409)
		return
	}
	if !ok {
		charge = Charge{Scope: req.Scope, ID: "charge-" + req.Scope.ConnectionID, IntentKey: req.IntentKey, InvoiceID: req.InvoiceID, Money: req.Money}
		s.charges[key] = charge
		s.writes++
	}
	switch s.mode {
	case "timeout-after":
		close(s.entered)
		<-s.release
		return
	case "500-after":
		w.WriteHeader(500)
		return
	case "wrong-account":
		charge.Scope.AccountRef = "wrong-account"
	case "wrong-environment":
		charge.Scope.Environment = "production"
	case "truncated":
		_, _ = io.WriteString(w, `{"id":`)
		return
	}
	_ = json.NewEncoder(w).Encode(charge)
}
func TestUnknownWriteRecoveryUsesPersistedIntention(t *testing.T) {
	for _, mode := range []string{"timeout-before", "timeout-after", "500-after", "429", "wrong-account", "wrong-environment", "truncated"} {
		t.Run(mode, func(t *testing.T) {
			sim := &simulator{mode: mode, charges: map[string]Charge{}, entered: make(chan struct{}), release: make(chan struct{})}
			server := httptest.NewServer(sim)
			defer server.Close()
			adapter := labClient{server.URL, server.Client()}
			request := requestFixture()
			path := filepath.Join(t.TempDir(), "intent.json")
			encoded, _ := json.Marshal(request)
			if err := os.WriteFile(path, encoded, 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			if strings.HasPrefix(mode, "timeout-") {
				ctx, cancel := context.WithCancel(context.Background())
				done := make(chan error, 1)
				go func() { _, err := adapter.CreateCharge(ctx, request); done <- err }()
				<-sim.entered
				cancel()
				err = <-done
				close(sim.release)
			} else {
				_, err = adapter.CreateCharge(context.Background(), request)
			}
			if err == nil || Recovery(err) != "lookup_same_intention" {
				t.Fatalf("must remain unknown, not fail/succeed definitively: %v", err)
			}
			// Reconstruct the client from a persisted request, simulating client restart.
			recovered, _ := os.ReadFile(path)
			var original Create
			if json.Unmarshal(recovered, &original) != nil {
				t.Fatal("persisted request invalid")
			}
			sim.mu.Lock()
			sim.mode = "normal"
			sim.mu.Unlock()
			restarted := labClient{server.URL, server.Client()}
			ref := Reference{Scope: original.Scope, IntentKey: original.IntentKey}
			snapshot, lookupErr := restarted.Lookup(context.Background(), ref)
			if mode == "timeout-before" || mode == "429" {
				if lookupErr == nil {
					t.Fatal("provider must have no effect")
				}
				if _, err = restarted.CreateCharge(context.Background(), original); err != nil {
					t.Fatal(err)
				}
			} else if lookupErr != nil || ValidateIssued(original, snapshot.Charge) != nil {
				t.Fatalf("effect not recovered: %v", lookupErr)
			}
			// Repeated issuance with the SAME request is idempotent in this contract.
			if _, err = restarted.CreateCharge(context.Background(), original); err != nil {
				t.Fatal(err)
			}
			sim.mu.Lock()
			count := sim.writes
			sim.mu.Unlock()
			if count != 1 {
				t.Fatalf("writes=%d", count)
			}
		})
	}
}
func TestConcurrentCreateAndScopeIsolation(t *testing.T) {
	sim := &simulator{charges: map[string]Charge{}}
	server := httptest.NewServer(sim)
	defer server.Close()
	adapter := labClient{server.URL, server.Client()}
	request := requestFixture()
	var wg sync.WaitGroup
	errors := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := adapter.CreateCharge(context.Background(), request); errors <- err }()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	conflict := request
	conflict.Money.Cents++
	if _, err := adapter.CreateCharge(context.Background(), conflict); err == nil || Recovery(err) != "operator_review" {
		t.Fatalf("divergent intention accepted: %v", err)
	}
	other := request
	other.Scope.ConnectionID = "conn-B"
	other.Scope.TenantID = "tenant-B"
	if _, err := adapter.CreateCharge(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	sim.mu.Lock()
	count := sim.writes
	sim.mu.Unlock()
	if count != 2 {
		t.Fatalf("scoped writes=%d", count)
	}
}
func TestDemoRegistryFailsClosed(t *testing.T) {
	s := requestFixture().Scope
	for _, provider := range []string{"test-only", "efi", "sejaefi", "asaas", "inter", "sicredi", "mercado_pago", "pagbank", "stripe", "kobana", "shipay", "tuna"} {
		s.Provider = provider
		if Executable(s, true) {
			t.Fatal("real/fake provider enabled", provider)
		}
	}
	s.Provider = "demo"
	if Executable(s, false) {
		t.Fatal("demo without explicit mode")
	}
	s.Environment = "production"
	if Executable(s, true) {
		t.Fatal("production demo enabled")
	}
	s.Environment = "sandbox"
	if !Executable(s, true) {
		t.Fatal("valid demo rejected")
	}
}
func TestNormalizedEventRejectsInvalidMoneyAndTime(t *testing.T) {
	for _, payment := range []string{`{"id":"p","amount_cents":1.5,"paid_at":"2026-10-26T00:00:00Z"}`, `{"id":"p","amount_cents":"100","paid_at":"2026-10-26T00:00:00Z"}`, `{"id":"p","amount_cents":2147483648,"paid_at":"2026-10-26T00:00:00Z"}`, `{"id":"p","amount_cents":100,"paid_at":"yesterday"}`, `{"id":"p","amount_cents":100,"paid_at":"2026-10-26T00:00:00Z","currency":"USD"}`} {
		raw := []byte(`{"id":"e","type":"payment.confirmed","charge_id":"c","payment":` + payment + `}`)
		if _, err := DecodeDemo(raw); err == nil {
			t.Fatal("invalid payment accepted", payment)
		}
	}
}
