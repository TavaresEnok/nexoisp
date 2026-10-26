package efi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/finance/providers"
)

// Immediate is bound to ONE frozen, persisted charge intention. DueDate remains
// invoice metadata; it is not silently converted into CobV or Pix expiration.
// The caller must commit the intention and uncertain state before network I/O.
type Immediate struct {
	client     *Client
	request    providers.Create
	key        string
	expiration int
}

var _ providers.Adapter = (*Immediate)(nil)

func NewImmediate(c *Client, r providers.Create, pixKey string, expirationSeconds int) (*Immediate, error) {
	if c == nil || c.authPath != "/oauth/token" || r.Validate() != nil || r.Scope != c.scope || pixKey == "" || expirationSeconds < 1 || expirationSeconds > 31536000 {
		return nil, errors.New("invalid immediate charge configuration")
	}
	return &Immediate{client: c, request: r, key: pixKey, expiration: expirationSeconds}, nil
}

// TxID separates accounts and intentions without using customer data; 32
// hexadecimal characters meet Pix txid's alphanumeric length restriction.
func TxID(r providers.Create) string {
	h := sha256.Sum256([]byte(r.Scope.TenantID + "\x00" + r.Scope.ConnectionID + "\x00" + r.Scope.Environment + "\x00" + r.Scope.AccountRef + "\x00" + r.IntentKey))
	return hex.EncodeToString(h[:16])
}
func decimal(cents int64) string { return fmt.Sprintf("%d.%02d", cents/100, cents%100) }

var moneyPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,7})\.[0-9]{2}$`)

func cents(value string) (int64, error) {
	if !moneyPattern.MatchString(value) {
		return 0, errors.New("invalid decimal amount")
	}
	n, err := strconv.ParseInt(strings.ReplaceAll(value, ".", ""), 10, 64)
	if err != nil || (providers.Money{Cents: n, Currency: "BRL"}).Validate() != nil {
		return 0, errors.New("amount outside supported range")
	}
	return n, nil
}

type pixCharge struct {
	Calendar struct {
		DueDate   string `json:"dataDeVencimento"`
		ValidDays int    `json:"validadeAposVencimento"`
	} `json:"calendario"`
	Debtor Debtor `json:"devedor"`
	TxID   string `json:"txid"`
	Status string `json:"status"`
	Key    string `json:"chave"`
	Value  struct {
		Original string `json:"original"`
	} `json:"valor"`
	Pix []struct {
		ID      string `json:"endToEndId"`
		TxID    string `json:"txid"`
		Value   string `json:"valor"`
		Time    string `json:"horario"`
		Returns []struct {
			Status string `json:"status"`
		} `json:"devolucoes"`
	} `json:"pix"`
}

func (a *Immediate) normalized(v pixCharge) (providers.Snapshot, error) {
	var s providers.Snapshot
	amount, err := cents(v.Value.Original)
	if err != nil || v.TxID != TxID(a.request) || v.Key != a.key || amount != a.request.Money.Cents {
		return s, failure(providers.Conflict, "charge identity, key or amount mismatch")
	}
	// Removed or unknown states require explicit review, never a cash assumption.
	if v.Status != "ATIVA" && v.Status != "CONCLUIDA" {
		return s, failure(providers.Conflict, "charge state requires review")
	}
	s.Charge = providers.Charge{Scope: a.request.Scope, ID: v.TxID, IntentKey: a.request.IntentKey, InvoiceID: a.request.InvoiceID, Money: a.request.Money}
	for _, p := range v.Pix {
		n, err := cents(p.Value)
		if err != nil || p.TxID != v.TxID {
			return s, failure(providers.Conflict, "payment identity or amount mismatch")
		}
		if len(p.Returns) > 0 {
			return s, failure(providers.Conflict, "refund history requires explicit reconciliation")
		}
		payment := providers.Payment{ID: p.ID, AmountCents: n, PaidAt: p.Time, Method: "pix", Currency: "BRL"}
		if err = payment.Validate(); err != nil {
			return s, failure(providers.Conflict, "invalid payment metadata")
		}
		s.Payments = append(s.Payments, payment)
	}
	if v.Status == "CONCLUIDA" && len(s.Payments) == 0 {
		return s, failure(providers.Unavailable, "completed charge without confirmed payment details")
	}
	return s, providers.ValidateSnapshot(providers.Reference{Scope: a.request.Scope, IntentKey: a.request.IntentKey, ChargeID: TxID(a.request)}, s)
}
func (a *Immediate) CreateCharge(ctx context.Context, r providers.Create) (providers.Charge, error) {
	if r != a.request {
		return providers.Charge{}, failure(providers.Conflict, "charge differs from frozen intention")
	}
	body := map[string]any{"calendario": map[string]any{"expiracao": a.expiration}, "valor": map[string]string{"original": decimal(r.Money.Cents)}, "chave": a.key}
	var response pixCharge
	if err := a.client.request(ctx, http.MethodPut, "/v2/cob/"+TxID(r), body, &response); err != nil {
		return providers.Charge{}, err
	}
	s, err := a.normalized(response)
	if err != nil {
		return providers.Charge{}, err
	}
	return s.Charge, providers.ValidateIssued(r, s.Charge)
}
func (a *Immediate) Lookup(ctx context.Context, r providers.Reference) (providers.Snapshot, error) {
	if r.Scope != a.request.Scope || (r.IntentKey == "" && r.ChargeID == "") || (r.IntentKey != "" && r.IntentKey != a.request.IntentKey) || (r.ChargeID != "" && r.ChargeID != TxID(a.request)) {
		return providers.Snapshot{}, failure(providers.Conflict, "lookup differs from frozen intention")
	}
	var response pixCharge
	if err := a.client.request(ctx, http.MethodGet, "/v2/cob/"+TxID(a.request), nil, &response); err != nil {
		return providers.Snapshot{}, err
	}
	return a.normalized(response)
}

// ConfigurationHash freezes payment semantics, not OAuth credentials/certificate;
// credential rotation must preserve lookup of the old intention.
func (a *Immediate) ConfigurationHash() string {
	raw, _ := json.Marshal(struct {
		Product, Key string
		Expiration   int
	}{"pix-cob", a.key, a.expiration})
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
