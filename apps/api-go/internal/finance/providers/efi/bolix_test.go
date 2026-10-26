package efi

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"nexoisp/api-go/internal/finance/providers"
	"sync/atomic"
	"testing"
)

func labCharges(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	s := httptest.NewTLSServer(handler)
	t.Cleanup(s.Close)
	cfg, _ := labConfig(t)
	c, err := NewChargesSandbox(cfg.Scope, cfg.ClientID, cfg.ClientSecret, 0)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	c.http.Transport.(*http.Transport).TLSClientConfig.RootCAs = roots
	c.base = s.URL
	t.Cleanup(c.Close)
	return c
}
func billetCustomer() BilletCustomer {
	c := BilletCustomer{Name: "Synthetic payer", CPF: "12345678909", Email: "synthetic@example.invalid"}
	c.Address.Street = "Synthetic street"
	c.Address.Number = "1"
	c.Address.Neighborhood = "Synthetic"
	c.Address.City = "Fortaleza"
	c.Address.State = "CE"
	c.Address.Zip = "60000000"
	return c
}
func billetResponse(r providers.Create) map[string]any {
	return map[string]any{"charge_id": 123456, "total": r.Money.Cents, "status": "waiting", "custom_id": TxID(r), "customer": billetCustomer(), "payment": map[string]any{"payment_method": "banking_billet", "banking_billet": map[string]string{"expire_at": r.DueDate}}}
}
func TestBolixUncertainPostRecoversByScopedCustomID(t *testing.T) {
	var r providers.Create
	var writes atomic.Int64
	ambiguous := false
	c := labCharges(t, func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/v1/authorize":
			oauth(w)
		case "/v1/charge/one-step":
			writes.Add(1)
			w.WriteHeader(500)
		case "/v1/charges":
			if req.URL.Query().Get("custom_id") != TxID(r) || req.URL.Query().Get("begin_date") == "" || req.URL.Query().Get("end_date") == "" {
				t.Error("recovery query lacks frozen identity/window")
			}
			rows := []any{billetResponse(r)}
			if ambiguous {
				rows = append(rows, billetResponse(r))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": rows})
		case "/v1/charge/123456":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": billetResponse(r)})
		default:
			t.Error("unexpected request", req.URL.Path)
			w.WriteHeader(404)
		}
	})
	r = fixture(c)
	a, err := NewBolix(c, r, billetCustomer(), "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.CreateCharge(context.Background(), r); err == nil {
		t.Fatal("lost response not uncertain")
	}
	resumed, _ := NewBolix(c, r, billetCustomer(), "2026-10-26")
	s, err := resumed.Lookup(context.Background(), providers.Reference{Scope: r.Scope, IntentKey: r.IntentKey})
	if err != nil || s.Charge.ID != "123456" || writes.Load() != 1 {
		t.Fatalf("recovery %v writes %d", err, writes.Load())
	}
	ambiguous = true
	if _, err = resumed.Lookup(context.Background(), providers.Reference{Scope: r.Scope, IntentKey: r.IntentKey}); err == nil {
		t.Fatal("ambiguous custom ID picked arbitrarily")
	}
	if writes.Load() != 1 {
		t.Fatal("lookup sent another POST")
	}
}
func TestBolixReceiptUsesPaidValueAndRejectsManualWriteOff(t *testing.T) {
	c := labCharges(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected network") })
	r := fixture(c)
	a, _ := NewBolix(c, r, billetCustomer(), "2026-10-26")
	raw, _ := json.Marshal(billetResponse(r))
	var v billetCharge
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	paid := int64(13000)
	v.Status = "paid"
	v.PaidValue = &paid
	v.PaidAt = "2026-10-26T12:00:00Z"
	s, err := a.normalized(v, "123456")
	if err != nil || len(s.Payments) != 1 || s.Payments[0].AmountCents != 13000 || s.Charge.Money.Cents != 12345 {
		t.Fatalf("nominal/paid mixed %v", err)
	}
	v.Status = "settled"
	if _, err = a.normalized(v, "123456"); err == nil {
		t.Fatal("manual PSP write-off invented cash")
	}
	v.Status = "paid"
	v.PaidAt = "2026-10-26"
	if _, err = a.normalized(v, "123456"); err == nil {
		t.Fatal("missing timestamp timezone accepted")
	}
	v.PaidAt = "2026-10-26T12:00:00Z"
	v.PaidValue = nil
	if _, err = a.normalized(v, "123456"); err == nil {
		t.Fatal("paid nominal inferred without paid value")
	}
	cfg, _ := labConfig(t)
	cfg.Scope.Environment = "production"
	if _, err = NewChargesSandbox(cfg.Scope, cfg.ClientID, cfg.ClientSecret, 0); err == nil {
		t.Fatal("production API enabled")
	}
}
