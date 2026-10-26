package efi

import (
	"context"
	"encoding/json"
	"net/http"
	"nexoisp/api-go/internal/finance/providers"
	"testing"
)

func debtorFixture() Debtor {
	return Debtor{Name: "Synthetic taxpayer", CPF: "12345678909", Street: "Synthetic street 1", City: "Fortaleza", State: "CE", PostalCode: "60000000"}
}
func TestCobVSeparatesDueDateFromExpiration(t *testing.T) {
	var req providers.Create
	debtor := debtorFixture()
	c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			oauth(w)
			return
		}
		if r.URL.Path != "/v2/cobv/"+TxID(req) {
			t.Error("wrong CobV endpoint")
		}
		if r.Method == "PUT" {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			calendar := body["calendario"].(map[string]any)
			if calendar["dataDeVencimento"] != req.DueDate || calendar["expiracao"] != nil {
				t.Error("due date converted into expiration")
			}
		}
		v := response(req)
		v["calendario"] = map[string]any{"dataDeVencimento": req.DueDate, "validadeAposVencimento": 30}
		v["devedor"] = debtor
		_ = json.NewEncoder(w).Encode(v)
	})
	req = fixture(c)
	a, err := NewDue(c, req, "synthetic-pix-key", debtor, 30)
	if err != nil {
		t.Fatal(err)
	}
	charge, err := a.CreateCharge(context.Background(), req)
	if err != nil || charge.ID != TxID(req) {
		t.Fatal(err)
	}
	if _, err = a.Lookup(context.Background(), providers.Reference{Scope: req.Scope, IntentKey: req.IntentKey}); err != nil {
		t.Fatal(err)
	}
	immediate, _ := NewImmediate(c, req, "synthetic-pix-key", 3600)
	if immediate.ConfigurationHash() == a.ConfigurationHash() {
		t.Fatal("different products share configuration identity")
	}
	v := pixCharge{TxID: TxID(req), Key: "synthetic-pix-key", Debtor: debtor}
	v.Value.Original = "123.45"
	v.Status = "ATIVA"
	v.Calendar.DueDate = "2026-12-15"
	v.Calendar.ValidDays = 30
	if _, err = a.normalize(v); err == nil {
		t.Fatal("changed due date accepted")
	}
	for _, bad := range []Debtor{{}, {Name: "No address", CPF: "12345678909"}, {Name: "Two documents", CPF: "12345678909", CNPJ: "11222333000181"}} {
		if _, err = NewDue(c, req, "synthetic-pix-key", bad, 30); err == nil {
			t.Fatal("invalid debtor accepted")
		}
	}
}
