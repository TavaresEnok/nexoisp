package efi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"nexoisp/api-go/internal/finance/providers"
)

type BilletCustomer struct {
	Name      string `json:"name"`
	CPF       string `json:"cpf,omitempty"`
	Email     string `json:"email"`
	Juridical *struct {
		Name string `json:"corporate_name"`
		CNPJ string `json:"cnpj"`
	} `json:"juridical_person,omitempty"`
	Address struct {
		Street       string `json:"street"`
		Number       string `json:"number"`
		Neighborhood string `json:"neighborhood"`
		Zip          string `json:"zipcode"`
		City         string `json:"city"`
		State        string `json:"state"`
	} `json:"address"`
}

func (c BilletCustomer) Validate() error {
	d := Debtor{Name: c.Name, Street: c.Address.Street, City: c.Address.City, State: c.Address.State, PostalCode: c.Address.Zip, CPF: c.CPF}
	if c.Juridical != nil {
		d.CNPJ = c.Juridical.CNPJ
		if c.Juridical.Name == "" {
			return errors.New("missing legal customer name")
		}
	}
	if d.Validate() != nil || c.Address.Number == "" || c.Address.Neighborhood == "" || c.Email == "" || len(c.Email) > 254 {
		return errors.New("invalid banking billet customer")
	}
	return nil
}

type Bolix struct {
	client          *Client
	request         providers.Create
	customer        BilletCustomer
	issuedOn        string
	notificationURL string
}

var _ providers.Adapter = (*Bolix)(nil)

func NewBolix(c *Client, r providers.Create, customer BilletCustomer, issuedOn string) (*Bolix, error) {
	if c == nil || c.authPath != "/v1/authorize" || r.Validate() != nil || r.Scope != c.scope || customer.Validate() != nil {
		return nil, errors.New("invalid Bolix configuration")
	}
	if _, err := time.Parse("2006-01-02", issuedOn); err != nil {
		return nil, errors.New("invalid frozen issuance date")
	}
	return &Bolix{client: c, request: r, customer: customer, issuedOn: issuedOn}, nil
}
func (a *Bolix) ConfigurationHash() string {
	raw, _ := json.Marshal(struct {
		Product         string
		Customer        BilletCustomer
		IssuedOn        string
		NotificationURL string `json:",omitempty"`
	}{"bolix", a.customer, a.issuedOn, a.notificationURL})
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}

func (a *Bolix) SetNotificationURL(raw string) error {
	if raw != "" {
		u, e := url.Parse(raw)
		if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("invalid callback URL")
		}
	}
	a.notificationURL = raw
	return nil
}

var chargeNumber = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

type billetCharge struct {
	ID        json.Number    `json:"charge_id"`
	ListID    json.Number    `json:"id"`
	Status    string         `json:"status"`
	Total     int64          `json:"total"`
	PaidValue *int64         `json:"paid_value"`
	PaidAt    string         `json:"paid_at"`
	CustomID  string         `json:"custom_id"`
	Customer  BilletCustomer `json:"customer"`
	Payment   struct {
		Method    string `json:"payment_method"`
		PaidValue *int64 `json:"paid_value"`
		PaidAt    string `json:"paid_at"`
		Billet    struct {
			Expires string `json:"expire_at"`
			Barcode string `json:"barcode"`
			Link    string `json:"link"`
			Pix     struct {
				Code  string `json:"qrcode"`
				Image string `json:"qrcode_image"`
			} `json:"pix"`
		} `json:"banking_billet"`
	} `json:"payment"`
}
type billetEnvelope struct {
	Code int          `json:"code"`
	Data billetCharge `json:"data"`
}

func (a *Bolix) id(v billetCharge) string {
	if v.ID != "" {
		return v.ID.String()
	}
	return v.ListID.String()
}
func (a *Bolix) normalized(v billetCharge, knownID string) (providers.Snapshot, error) {
	id := a.id(v)
	if !chargeNumber.MatchString(id) || (knownID != "" && knownID != id) || v.Total != a.request.Money.Cents || v.CustomID != TxID(a.request) {
		return providers.Snapshot{}, failure(providers.Conflict, "Bolix identity/amount differs from frozen intention")
	}
	if v.Customer.CPF != a.customer.CPF || (a.customer.Juridical != nil && (v.Customer.Juridical == nil || v.Customer.Juridical.CNPJ != a.customer.Juridical.CNPJ)) {
		return providers.Snapshot{}, failure(providers.Conflict, "Bolix debtor mismatch")
	}
	expires := v.Payment.Billet.Expires
	if expires != a.request.DueDate {
		date, err := time.Parse(time.RFC3339Nano, expires)
		if err != nil || date.Format("2006-01-02") != a.request.DueDate {
			return providers.Snapshot{}, failure(providers.Conflict, "Bolix due date differs from frozen intention")
		}
	}
	snapshot := providers.Snapshot{Charge: providers.Charge{Scope: a.request.Scope, ID: id, IntentKey: a.request.IntentKey, InvoiceID: a.request.InvoiceID, Money: a.request.Money}}
	snapshot.Status = "active"
	switch v.Status {
	case "new", "waiting", "unpaid", "identified":
	case "canceled":
		snapshot.Status = "removed"
	case "paid":
		amount := v.PaidValue
		if amount == nil {
			amount = v.Payment.PaidValue
		}
		if amount == nil || (v.PaidValue != nil && v.Payment.PaidValue != nil && *v.PaidValue != *v.Payment.PaidValue) {
			return providers.Snapshot{}, failure(providers.Conflict, "Bolix paid value missing or contradictory")
		}
		stamp := v.PaidAt
		if stamp == "" {
			stamp = v.Payment.PaidAt
		}
		if v.PaidAt != "" && v.Payment.PaidAt != "" && v.PaidAt != v.Payment.PaidAt {
			return providers.Snapshot{}, failure(providers.Conflict, "Bolix payment timestamp contradictory")
		}
		payment := providers.Payment{ID: "bolix:" + id, AmountCents: *amount, PaidAt: stamp, Method: "bolix", Currency: "BRL"}
		if err := payment.Validate(); err != nil {
			return providers.Snapshot{}, failure(providers.Conflict, "Bolix confirmed receipt lacks valid cents/timestamp")
		}
		snapshot.Payments = []providers.Payment{payment}
		snapshot.Status = "paid"
	// settled is a provider-side manual write-off, not proof of bank receipt.
	default:
		return providers.Snapshot{}, failure(providers.Conflict, "Bolix state requires review")
	}
	if snapshot.Status == "active" {
		v := v.Payment.Billet
		snapshot.Charge.Artifacts = (providers.PaymentArtifacts{BoletoURL: v.Link, BoletoBarcode: v.Barcode, PixCopyPaste: v.Pix.Code, PixQRCode: v.Pix.Image}).Clean()
	}
	return snapshot, nil
}

// Bolix POST is NOT assumed idempotent. Dispatch once through the persisted
// journal. custom_id is a recovery filter, not proof of uniqueness at the PSP.
func (a *Bolix) CreateCharge(ctx context.Context, r providers.Create) (providers.Charge, error) {
	if r != a.request {
		return providers.Charge{}, failure(providers.Conflict, "Bolix intention changed")
	}
	body := map[string]any{"items": []any{map[string]any{"name": "NexoISP " + r.InvoiceID, "value": r.Money.Cents, "amount": 1}}, "metadata": map[string]string{"custom_id": TxID(r)}, "payment": map[string]any{"banking_billet": map[string]any{"expire_at": r.DueDate, "customer": a.customer}}}
	if a.notificationURL != "" {
		body["metadata"].(map[string]string)["notification_url"] = a.notificationURL
	}
	var issued billetEnvelope
	if err := a.client.request(ctx, http.MethodPost, "/v1/charge/one-step", body, &issued); err != nil {
		return providers.Charge{}, err
	}
	id := a.id(issued.Data)
	if issued.Code != 200 || !chargeNumber.MatchString(id) {
		return providers.Charge{}, failure(providers.Unknown, "Bolix response missing charge identity; recover by custom ID")
	}
	// One-step responses omit data needed for identity validation. Read back the
	// actual charge; failure leaves the durable journal uncertain, never re-POST.
	s, err := a.Lookup(ctx, providers.Reference{Scope: r.Scope, ChargeID: id, IntentKey: r.IntentKey})
	return s.Charge, err
}
func (a *Bolix) Lookup(ctx context.Context, r providers.Reference) (providers.Snapshot, error) {
	if r.Scope != a.request.Scope || (r.IntentKey != "" && r.IntentKey != a.request.IntentKey) || (r.ChargeID == "" && r.IntentKey == "") {
		return providers.Snapshot{}, failure(providers.Conflict, "Bolix lookup reference mismatch")
	}
	id := r.ChargeID
	if id == "" {
		issued, _ := time.Parse("2006-01-02", a.issuedOn)
		params := url.Values{"charge_type": {"banking_billet"}, "custom_id": {TxID(a.request)}, "begin_date": {issued.AddDate(0, 0, -1).Format("2006-01-02")}, "end_date": {issued.AddDate(0, 0, 1).Format("2006-01-02")}, "limit": {"2"}, "page": {"1"}}
		var list struct {
			Code int            `json:"code"`
			Data []billetCharge `json:"data"`
		}
		if err := a.client.request(ctx, http.MethodGet, "/v1/charges?"+params.Encode(), nil, &list); err != nil {
			return providers.Snapshot{}, err
		}
		if list.Code != 200 || len(list.Data) == 0 {
			return providers.Snapshot{}, failure(providers.Unavailable, "Bolix custom ID not found; eventual consistency does not allow another POST")
		}
		if len(list.Data) != 1 || list.Data[0].CustomID != TxID(a.request) {
			return providers.Snapshot{}, failure(providers.Conflict, "Bolix custom ID is ambiguous")
		}
		id = a.id(list.Data[0])
	}
	if !chargeNumber.MatchString(id) {
		return providers.Snapshot{}, failure(providers.Conflict, "invalid Bolix charge ID")
	}
	var detail billetEnvelope
	if err := a.client.request(ctx, http.MethodGet, "/v1/charge/"+id, nil, &detail); err != nil {
		return providers.Snapshot{}, err
	}
	if detail.Code != 200 {
		return providers.Snapshot{}, failure(providers.Unavailable, "invalid Bolix lookup response")
	}
	return a.normalized(detail.Data, id)
}
