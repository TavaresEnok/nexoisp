package efi

import (
	"context"
	"encoding/json"
	"net/http"
	"nexoisp/api-go/internal/finance/providers"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPixRefundLostWriteRecoversByReadback(t *testing.T) {
	var r providers.Create
	var writes atomic.Int64
	exists := false
	wrong := false
	pending := false
	payment := providers.Payment{ID: "E12345678202610261200abcdef123456", AmountCents: 12345, PaidAt: "2026-10-26T12:00:00Z", Method: "pix", Currency: "BRL"}
	c, _ := labClient(t, func(w http.ResponseWriter, req *http.Request) {
		switch {
		case req.URL.Path == "/oauth/token":
			oauth(w)
		case req.URL.Path == "/v2/pix/"+payment.ID:
			_ = json.NewEncoder(w).Encode(map[string]any{"endToEndId": payment.ID, "txid": TxID(r), "valor": "123.45", "horario": payment.PaidAt})
		case strings.Contains(req.URL.Path, "/devolucao/"):
			if req.Method == "PUT" {
				writes.Add(1)
				exists = true
				w.WriteHeader(500)
				return
			}
			if !exists {
				w.WriteHeader(404)
				return
			}
			amount := "40.00"
			if wrong {
				amount = "40.01"
			}
			status := "DEVOLVIDO"
			if pending {
				status = "EM_PROCESSAMENTO"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "abcdef123456", "rtrId": "D12345678202610261300abcdef123456", "valor": amount, "status": status, "horario": map[string]string{"solicitacao": "2026-10-26T12:59:00Z", "liquidacao": "2026-10-26T13:00:00Z"}})
		default:
			t.Error("unexpected endpoint", req.URL.Path)
			w.WriteHeader(404)
		}
	})
	r = fixture(c)
	a, err := NewImmediate(c, r, "synthetic-pix-key", 3600)
	if err != nil {
		t.Fatal(err)
	}
	op := providers.OperationRequest{Reference: providers.Reference{Scope: r.Scope, ChargeID: TxID(r), IntentKey: r.IntentKey}, Kind: "refund", ID: "abcdef123456", Payment: payment, AmountCents: 4000}
	if _, err = a.ExecuteOperation(context.Background(), op); err == nil {
		t.Fatal("lost write expected")
	}
	result, err := a.LookupOperation(context.Background(), op)
	if err != nil || result.State != "confirmed" || result.Refund == nil || result.Refund.AmountCents != 4000 || writes.Load() != 1 {
		t.Fatalf("refund recovery %#v %v writes=%d", result, err, writes.Load())
	}
	pending = true
	result, err = a.LookupOperation(context.Background(), op)
	if err != nil || result.State != "pending" || result.Refund != nil {
		t.Fatal("pending refund posted cash", err)
	}
	wrong = true
	if _, err = a.LookupOperation(context.Background(), op); err == nil {
		t.Fatal("different confirmed amount accepted")
	}
	if writes.Load() != 1 {
		t.Fatal("readback resent PUT")
	}
}
func TestCancellationProductsUseReadbackAndPreserveLateCash(t *testing.T) {
	for _, product := range []string{"pix_cob", "pix_cobv", "bolix"} {
		t.Run(product, func(t *testing.T) {
			var r providers.Create
			var writes atomic.Int64
			removed := false
			late := false
			handler := func(w http.ResponseWriter, req *http.Request) {
				if req.URL.Path == "/oauth/token" || req.URL.Path == "/v1/authorize" {
					oauth(w)
					return
				}
				if req.Method == "PATCH" || strings.HasSuffix(req.URL.Path, "/cancel") {
					writes.Add(1)
					removed = true
					if product == "bolix" {
						if req.Method != "PUT" {
							t.Error("wrong Bolix cancel method")
						}
						_ = json.NewEncoder(w).Encode(map[string]int{"code": 200})
						return
					}
				}
				if product == "bolix" {
					v := billetResponse(r)
					if removed {
						v["status"] = "canceled"
					}
					if late {
						v["status"] = "paid"
						v["paid_value"] = 12345
						v["paid_at"] = "2026-10-26T14:00:00Z"
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": v})
					return
				}
				if product == "pix_cobv" && !strings.HasPrefix(req.URL.Path, "/v2/cobv/") {
					t.Error("CobV used Cob endpoint")
				}
				v := response(r)
				if removed {
					v["status"] = "REMOVIDA_PELO_USUARIO_RECEBEDOR"
				}
				if product == "pix_cobv" {
					v["devedor"] = debtorFixture()
					v["calendario"] = map[string]any{"dataDeVencimento": r.DueDate, "validadeAposVencimento": 30}
				}
				_ = json.NewEncoder(w).Encode(v)
			}
			var c *Client
			if product == "bolix" {
				c = labCharges(t, handler)
			} else {
				c, _ = labClient(t, handler)
			}
			r = fixture(c)
			var adapter providers.Operations
			var lookup providers.Adapter
			switch product {
			case "pix_cob":
				a, e := NewImmediate(c, r, "synthetic-pix-key", 3600)
				if e != nil {
					t.Fatal(e)
				}
				adapter = a
				lookup = a
			case "pix_cobv":
				a, e := NewDue(c, r, "synthetic-pix-key", debtorFixture(), 30)
				if e != nil {
					t.Fatal(e)
				}
				adapter = a
				lookup = a
			case "bolix":
				a, e := NewBolix(c, r, billetCustomer(), "2026-10-26")
				if e != nil {
					t.Fatal(e)
				}
				adapter = a
				lookup = a
			}
			charge := TxID(r)
			if product == "bolix" {
				charge = "123456"
			}
			op := providers.OperationRequest{Reference: providers.Reference{Scope: r.Scope, ChargeID: charge, IntentKey: r.IntentKey}, Kind: "cancel", ID: "abcdef"}
			result, err := adapter.ExecuteOperation(context.Background(), op)
			if err != nil || result.State != "confirmed" || writes.Load() != 1 {
				t.Fatalf("cancel %#v %v writes=%d", result, err, writes.Load())
			}
			if _, err = adapter.LookupOperation(context.Background(), op); err != nil || writes.Load() != 1 {
				t.Fatal("lookup repeated cancellation", err)
			}
			if product == "bolix" {
				late = true
				s, e := lookup.Lookup(context.Background(), op.Reference)
				if e != nil || len(s.Payments) != 1 || s.Payments[0].AmountCents != 12345 {
					t.Fatal("late cash lost after cancellation", e)
				}
			}
		})
	}
}
