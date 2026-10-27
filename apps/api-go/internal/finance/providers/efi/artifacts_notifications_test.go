package efi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"nexoisp/api-go/internal/finance/providers"
	"testing"
)

func TestAuthenticatedPixArtifactsDoNotGateFinancialLookup(t *testing.T) {
	var r providers.Create
	broken := false
	copy := "000201010212synthetic-laboratory-pix-artifact"
	svg := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><path fill="#fff" d="M0 0h45v45H0z"/></svg>`))
	c, _ := labClient(t, func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/oauth/token":
			oauth(w)
		case "/v2/loc/23/qrcode":
			if broken {
				w.WriteHeader(500)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"qrcode": copy, "imagemQrcode": svg})
		default:
			v := response(r)
			v["loc"] = map[string]int{"id": 23}
			v["pixCopiaECola"] = copy
			_ = json.NewEncoder(w).Encode(v)
		}
	})
	r = fixture(c)
	a, _ := NewImmediate(c, r, "synthetic-pix-key", 3600)
	charge, err := a.CreateCharge(context.Background(), r)
	if err != nil || charge.Artifacts == nil || charge.Artifacts.PixQRCode != svg {
		t.Fatalf("authenticated artifacts: %v %+v", err, charge.Artifacts)
	}
	broken = true
	s, err := a.Lookup(context.Background(), providers.Reference{Scope: r.Scope, ChargeID: TxID(r)})
	if err != nil || s.Charge.Artifacts == nil || s.Charge.Artifacts.PixCopyPaste != copy || s.Charge.Artifacts.PixQRCode != "" {
		t.Fatal("optional QR failure blocked/replaced authoritative lookup", err)
	}
}

func TestBolixArtifactsAndChargeTokenLookup(t *testing.T) {
	var r providers.Create
	c := labCharges(t, func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/v1/authorize" {
			oauth(w)
			return
		}
		if req.URL.Path != "/v1/notification/synthetic-notification-token" {
			t.Error("unscoped token lookup", req.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": []any{map[string]any{"type": "charge", "custom_id": TxID(r), "identifiers": map[string]int{"charge_id": 123456}}}})
	})
	r = fixture(c)
	items, err := c.ChargeNotifications(context.Background(), "synthetic-notification-token")
	if err != nil || len(items) != 1 || items[0].ChargeID != "123456" || items[0].CustomID != TxID(r) {
		t.Fatal(items, err)
	}
	a, _ := NewBolix(c, r, billetCustomer(), "2026-10-27")
	raw, _ := json.Marshal(billetResponse(r))
	var v billetCharge
	_ = json.Unmarshal(raw, &v)
	v.Payment.Billet.Link = "https://visualizacao.gerencianet.com.br/emissao/synthetic"
	v.Payment.Billet.Barcode = "00000.00000 00000.000000 00000.000000 0 00000000000000"
	s, err := a.normalized(v, "123456")
	if err != nil || s.Charge.Artifacts == nil || s.Charge.Artifacts.BoletoURL != v.Payment.Billet.Link {
		t.Fatal("missing authenticated billet", err)
	}
}

func TestPixCallbackRegistrationReadbackAndExplicitReplacement(t *testing.T) {
	current := ""
	writes := 0
	c, _ := labClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			oauth(w)
			return
		}
		if r.Method == http.MethodPut {
			writes++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			current = body["webhookUrl"]
			w.WriteHeader(201)
			return
		}
		if current == "" {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"chave": "synthetic-key", "webhookUrl": current})
	})
	ctx := context.Background()
	desired := "https://callback.example.invalid/callbacks/efi/synthetic"
	if err := c.RegisterPixWebhook(ctx, "synthetic-key", desired, false); err != nil {
		t.Fatal(err)
	}
	if err := c.RegisterPixWebhook(ctx, "synthetic-key", desired, false); err != nil || writes != 1 {
		t.Fatal("idempotent registration rewrote config", err)
	}
	current = "https://other.example.invalid/existing"
	if err := c.RegisterPixWebhook(ctx, "synthetic-key", desired, false); err == nil || writes != 1 {
		t.Fatal("existing webhook silently replaced")
	}
	if err := c.RegisterPixWebhook(ctx, "synthetic-key", desired, true); err != nil || writes != 2 {
		t.Fatal("explicit replacement failed", err)
	}
}
