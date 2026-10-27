// Package providers defines normalized boundaries. Provider-specific network,
// authentication and status rules must be implemented explicitly, never inferred
// from the demo protocol. This package does not enable any real PSP.
package providers

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const MaxCents int64 = 2147483647 // current database representation

type Scope struct {
	ConnectionID string `json:"connection_id"`
	TenantID     string `json:"tenant_id"`
	Provider     string `json:"provider"`
	Environment  string `json:"environment"`
	AccountRef   string `json:"account_ref"`
}

func (s Scope) Validate() error {
	if s.ConnectionID == "" || s.TenantID == "" || s.Provider == "" || s.AccountRef == "" || (s.Environment != "sandbox" && s.Environment != "production") {
		return errors.New("incomplete provider scope")
	}
	return nil
}

// Executable is the single current registry gate, not a provider name normalizer.
// Lab transports live in _test.go and cannot be registered by configuration.
func Executable(s Scope, demoEnabled bool) bool {
	return s.Validate() == nil && demoEnabled && s.Provider == "demo" && s.Environment == "sandbox"
}

type Money struct {
	Cents    int64  `json:"amount_cents"`
	Currency string `json:"currency"`
}

func (m Money) Validate() error {
	if m.Cents <= 0 || m.Cents > MaxCents || m.Currency != "BRL" {
		return errors.New("invalid BRL integer cents")
	}
	return nil
}

type Create struct {
	Scope     Scope  `json:"scope"`
	IntentKey string `json:"intent_key"`
	InvoiceID string `json:"invoice_id"`
	Money     Money  `json:"money"`
	DueDate   string `json:"due_date"`
}

func (r Create) Validate() error {
	if err := r.Scope.Validate(); err != nil {
		return err
	}
	if err := r.Money.Validate(); err != nil {
		return err
	}
	if r.IntentKey == "" || r.InvoiceID == "" {
		return errors.New("durable charge intention and invoice required")
	}
	if _, err := time.Parse("2006-01-02", r.DueDate); err != nil {
		return errors.New("invalid due date")
	}
	return nil
}

type Reference struct {
	Scope     Scope  `json:"scope"`
	ChargeID  string `json:"charge_id,omitempty"`
	IntentKey string `json:"intent_key,omitempty"`
}
type Charge struct {
	Scope     Scope  `json:"scope"`
	ID        string `json:"id"`
	IntentKey string `json:"intent_key"`
	InvoiceID string `json:"invoice_id"`
	Money     Money  `json:"money"`
}

func ValidateIssued(r Create, c Charge) error {
	if err := r.Validate(); err != nil {
		return err
	}
	if c.ID == "" || c.Scope != r.Scope || c.IntentKey != r.IntentKey || c.InvoiceID != r.InvoiceID || c.Money != r.Money {
		return errors.New("provider response does not match charge intention")
	}
	return nil
}

type Payment struct {
	ID          string `json:"id"`
	AmountCents int64  `json:"amount_cents"`
	PaidAt      string `json:"paid_at"`
	Method      string `json:"method,omitempty"`
	Currency    string `json:"currency,omitempty"`
}

func (p Payment) Validate() error {
	if p.ID == "" || len(p.ID) > 256 {
		return errors.New("invalid payment ID")
	}
	if err := (Money{p.AmountCents, p.Currency}).Validate(); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, p.PaidAt); err != nil {
		return errors.New("invalid payment timestamp")
	}
	return nil
}

type Snapshot struct {
	Charge         Charge    `json:"charge"`
	Payments       []Payment `json:"payments"`
	Refunds        []Refund  `json:"refunds,omitempty"`
	Status         string    `json:"status,omitempty"` // active, paid, removed; empty for legacy adapters
	ReviewRequired bool      `json:"review_required,omitempty"`
}

func ValidateSnapshot(r Reference, s Snapshot) error {
	if err := r.Scope.Validate(); err != nil {
		return err
	}
	if (r.ChargeID == "" && r.IntentKey == "") || s.Charge.ID == "" || s.Charge.Scope != r.Scope || (r.ChargeID != "" && r.ChargeID != s.Charge.ID) || (r.IntentKey != "" && r.IntentKey != s.Charge.IntentKey) {
		return errors.New("provider lookup scope/reference mismatch")
	}
	if err := s.Charge.Money.Validate(); err != nil {
		return err
	}
	seen := map[string]Payment{}
	for _, p := range s.Payments {
		if err := p.Validate(); err != nil {
			return err
		}
		if previous, ok := seen[p.ID]; ok && previous != p {
			return errors.New("conflicting payment in provider snapshot")
		}
		seen[p.ID] = p
	}
	refunds := map[string]Refund{}
	returns := map[string]string{}
	totals := map[string]int64{}
	for _, refund := range s.Refunds {
		if err := refund.Validate(); err != nil {
			return err
		}
		original, ok := seen[refund.PaymentID]
		if !ok {
			return errors.New("refund without original receipt in snapshot")
		}
		settled, _ := time.Parse(time.RFC3339Nano, refund.SettledAt)
		received, _ := time.Parse(time.RFC3339Nano, original.PaidAt)
		if settled.Before(received) {
			return errors.New("refund precedes original receipt")
		}
		if prior, ok := refunds[refund.ID]; ok {
			if prior != refund {
				return errors.New("conflicting refund identity")
			}
			continue
		}
		if id, ok := returns[refund.ReturnID]; ok && id != refund.ID {
			return errors.New("return identity reused")
		}
		refunds[refund.ID] = refund
		returns[refund.ReturnID] = refund.ID
		totals[refund.PaymentID] += refund.AmountCents
		if totals[refund.PaymentID] > original.AmountCents {
			return errors.New("refund total exceeds received cash")
		}
	}
	if s.Status != "" && s.Status != "active" && s.Status != "paid" && s.Status != "removed" {
		return errors.New("unknown normalized charge state")
	}
	return nil
}

// Create must use a stable persisted intention scoped to the account. A timeout
// is not proof of failure: Lookup by the SAME intention precedes any write retry.
// Adapter methods must not post ledger entries or initiate technical operations.
type Adapter interface {
	CreateCharge(context.Context, Create) (Charge, error)
	Lookup(context.Context, Reference) (Snapshot, error)
}
type FailureKind string

const (
	Rejected    FailureKind = "rejected"
	Conflict    FailureKind = "conflict"
	Unknown     FailureKind = "unknown"
	Unavailable FailureKind = "unavailable"
)

type Failure struct {
	Kind       FailureKind
	RetryAfter time.Duration
	Cause      error
}

func (e *Failure) Error() string { return fmt.Sprintf("provider %s: %v", e.Kind, e.Cause) }
func (e *Failure) Unwrap() error { return e.Cause }

// Unknown/unavailable includes uncertain writes, 429/5xx and transport errors.
// This is recovery guidance, never an instruction to blindly resend a POST.
func Recovery(err error) string {
	var failure *Failure
	if errors.As(err, &failure) && (failure.Kind == Rejected || failure.Kind == Conflict) {
		return "operator_review"
	}
	return "lookup_same_intention"
}
