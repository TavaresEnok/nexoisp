package efi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"sync"
	"testing"

	"nexoisp/api-go/internal/finance/providers"
)

func TestBilletLateChargesConvertsPolicyWithinLegalLimits(t *testing.T) {
	for _, c := range []struct {
		fine, interest     float64
		wantFine, wantRate int
	}{
		{0, 0, 0, 0},
		{2, 1, 200, 33},
		{1.5, 0.5, 150, 16},
		{0.01, 0.03, 1, 1},
		{2.00, 0.99, 200, 33},
	} {
		fine, interest, err := BilletLateCharges(c.fine, c.interest)
		if err != nil || fine != c.wantFine || interest != c.wantRate {
			t.Fatalf("%v/%v: got %d/%d %v", c.fine, c.interest, fine, interest, err)
		}
		// A taxa diária enviada nunca ultrapassa o percentual mensal da política.
		if float64(interest)*30/1000 > c.interest+1e-9 {
			t.Fatalf("juros diários %d excedem %v%% ao mês", interest, c.interest)
		}
	}
	for _, c := range [][2]float64{{2.01, 0}, {0, 1.01}, {20, 20}, {-1, 0}, {0, -0.5}, {math.NaN(), 0}} {
		if _, _, err := BilletLateCharges(c[0], c[1]); err == nil {
			t.Fatalf("limite legal ignorado: %v", c)
		}
	}
}

func TestBolixSendsFineAndInterestConfigurations(t *testing.T) {
	var mu sync.Mutex
	var posted []map[string]any
	var r providers.Create
	c := labCharges(t, func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/v1/authorize":
			oauth(w)
		case "/v1/charge/one-step":
			raw, _ := io.ReadAll(req.Body)
			var body map[string]any
			if err := json.Unmarshal(raw, &body); err != nil {
				t.Error(err)
			}
			mu.Lock()
			posted = append(posted, body)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": map[string]any{"charge_id": 123456, "total": r.Money.Cents, "status": "waiting"}})
		case "/v1/charge/123456":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": billetResponse(r)})
		default:
			t.Error("unexpected request", req.URL.Path)
			w.WriteHeader(404)
		}
	})
	r = fixture(c)
	issue := func(fine, interest int) map[string]any {
		t.Helper()
		a, err := NewBolix(c, r, billetCustomer(), "2026-10-26")
		if err != nil {
			t.Fatal(err)
		}
		if err = a.SetLateCharges(fine, interest); err != nil {
			t.Fatal(err)
		}
		if _, err = a.CreateCharge(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		billet := posted[len(posted)-1]["payment"].(map[string]any)["banking_billet"].(map[string]any)
		if billet["expire_at"] != r.DueDate {
			t.Fatalf("vencimento perdido: %v", billet)
		}
		return billet
	}
	billet := issue(200, 33)
	cfg, ok := billet["configurations"].(map[string]any)
	if !ok || cfg["fine"] != float64(200) || cfg["interest"] != float64(33) || len(cfg) != 2 {
		t.Fatalf("configurations ausente ou incorreta: %v", billet)
	}
	billet = issue(150, 0)
	cfg, ok = billet["configurations"].(map[string]any)
	if !ok || cfg["fine"] != float64(150) || cfg["interest"] != float64(0) {
		t.Fatalf("multa sem juros: %v", billet)
	}
	billet = issue(0, 0)
	if _, exists := billet["configurations"]; exists {
		t.Fatalf("política sem encargos enviou configurations: %v", billet)
	}
}

func TestBolixRejectsLateChargesAboveLegalLimitsAndFreezesThem(t *testing.T) {
	c := labCharges(t, func(w http.ResponseWriter, req *http.Request) { t.Error("unexpected network", req.URL.Path) })
	r := fixture(c)
	a, err := NewBolix(c, r, billetCustomer(), "2026-10-26")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range [][2]int{{201, 0}, {0, 34}, {-1, 0}, {0, -1}, {1000, 330}} {
		if a.SetLateCharges(v[0], v[1]) == nil {
			t.Fatalf("limite legal aceito: %v", v)
		}
	}
	// Intenções preparadas antes de multa/juros mantêm a mesma impressão digital.
	legacy, _ := json.Marshal(struct {
		Product         string
		Customer        BilletCustomer
		IssuedOn        string
		NotificationURL string `json:",omitempty"`
	}{"bolix", billetCustomer(), "2026-10-26", ""})
	sum := sha256.Sum256(legacy)
	if a.ConfigurationHash() != hex.EncodeToString(sum[:]) {
		t.Fatal("hash de intenção sem encargos mudou")
	}
	plain := a.ConfigurationHash()
	if err = a.SetLateCharges(200, 33); err != nil {
		t.Fatal(err)
	}
	if a.ConfigurationHash() == plain {
		t.Fatal("multa e juros não fazem parte da configuração congelada")
	}
}
