package efi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"nexoisp/api-go/internal/finance/providers"
)

type Debtor struct {
	Name       string `json:"nome"`
	CPF        string `json:"cpf,omitempty"`
	CNPJ       string `json:"cnpj,omitempty"`
	Street     string `json:"logradouro"`
	City       string `json:"cidade"`
	State      string `json:"uf"`
	PostalCode string `json:"cep"`
}

var cpfShape = regexp.MustCompile(`^[0-9]{11}$`)
var cnpjShape = regexp.MustCompile(`^[0-9]{14}$`)
var postalShape = regexp.MustCompile(`^[0-9]{8}$`)

func (d Debtor) Validate() error {
	if strings.TrimSpace(d.Name) == "" || len(d.Name) > 200 || len(d.Street) < 2 || len(d.Street) > 200 || len(d.City) < 2 || len(d.City) > 100 || !postalShape.MatchString(d.PostalCode) {
		return errors.New("incomplete debtor address/name")
	}
	if !strings.Contains("|AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO|", "|"+d.State+"|") {
		return errors.New("invalid debtor state")
	}
	if (d.CPF == "") == (d.CNPJ == "") || (d.CPF != "" && !cpfShape.MatchString(d.CPF)) || (d.CNPJ != "" && !cnpjShape.MatchString(d.CNPJ)) {
		return errors.New("provide one CPF or numeric CNPJ")
	}
	return nil
}

// Due is a separate CobV product: expiration seconds from immediate Cob must not
// be reused as a due date or validity-after-due policy. Tax validity is checked by
// the provider; this boundary enforces the currently supported numeric format.
type Due struct {
	base      *Immediate
	debtor    Debtor
	validDays int
}

var _ providers.Adapter = (*Due)(nil)

func NewDue(c *Client, r providers.Create, key string, debtor Debtor, validDays int) (*Due, error) {
	if debtor.Validate() != nil || validDays < 0 || validDays > 120 {
		return nil, errors.New("invalid CobV debtor/validity")
	}
	base, err := NewImmediate(c, r, key, 1)
	if err != nil {
		return nil, err
	}
	return &Due{base: base, debtor: debtor, validDays: validDays}, nil
}
func (a *Due) ConfigurationHash() string {
	raw, _ := json.Marshal(struct {
		Product, Key string
		Debtor       Debtor
		ValidDays    int
	}{"pix-cobv", a.base.key, a.debtor, a.validDays})
	h := sha256.Sum256(raw)
	return hex.EncodeToString(h[:])
}
func (a *Due) normalize(v pixCharge) (providers.Snapshot, error) {
	if v.Calendar.DueDate != a.base.request.DueDate || v.Calendar.ValidDays != a.validDays || v.Debtor.CPF != a.debtor.CPF || v.Debtor.CNPJ != a.debtor.CNPJ {
		return providers.Snapshot{}, failure(providers.Conflict, "CobV due date/debtor does not match frozen intention")
	}
	return a.base.normalized(v)
}
func (a *Due) CreateCharge(ctx context.Context, r providers.Create) (providers.Charge, error) {
	if r != a.base.request {
		return providers.Charge{}, failure(providers.Conflict, "CobV differs from frozen intention")
	}
	body := map[string]any{"calendario": map[string]any{"dataDeVencimento": r.DueDate, "validadeAposVencimento": a.validDays}, "devedor": a.debtor, "valor": map[string]string{"original": decimal(r.Money.Cents)}, "chave": a.base.key}
	var response pixCharge
	if err := a.base.client.request(ctx, http.MethodPut, "/v2/cobv/"+TxID(r), body, &response); err != nil {
		return providers.Charge{}, err
	}
	s, err := a.normalize(response)
	if err == nil {
		a.base.enrichArtifacts(ctx, response, &s)
	}
	return s.Charge, err
}
func (a *Due) Lookup(ctx context.Context, r providers.Reference) (providers.Snapshot, error) {
	if r.Scope != a.base.request.Scope || (r.ChargeID == "" && r.IntentKey == "") || (r.ChargeID != "" && r.ChargeID != TxID(a.base.request)) || (r.IntentKey != "" && r.IntentKey != a.base.request.IntentKey) {
		return providers.Snapshot{}, failure(providers.Conflict, "CobV lookup identity mismatch")
	}
	var response pixCharge
	if err := a.base.client.request(ctx, http.MethodGet, "/v2/cobv/"+TxID(a.base.request), nil, &response); err != nil {
		return providers.Snapshot{}, err
	}
	s, err := a.normalize(response)
	if err == nil {
		a.base.enrichArtifacts(ctx, response, &s)
	}
	return s, err
}
