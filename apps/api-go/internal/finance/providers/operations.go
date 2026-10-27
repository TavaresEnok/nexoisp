package providers

import (
	"context"
	"errors"
	"time"
)

// Refund is a confirmed debit, never merely an accepted request or a callback.
type Refund struct {
	ID          string `json:"id"`
	ReturnID    string `json:"return_id"`
	PaymentID   string `json:"payment_id"`
	AmountCents int64  `json:"amount_cents"`
	SettledAt   string `json:"settled_at"`
}

func (r Refund) Validate() error {
	if r.ID == "" || len(r.ID) > 64 || r.ReturnID == "" || len(r.ReturnID) > 64 || r.PaymentID == "" || len(r.PaymentID) > 256 {
		return errors.New("invalid refund identity")
	}
	if err := (Money{Cents: r.AmountCents, Currency: "BRL"}).Validate(); err != nil {
		return err
	}
	_, err := time.Parse(time.RFC3339Nano, r.SettledAt)
	return err
}

type OperationRequest struct {
	Reference   Reference
	Kind, ID    string
	Payment     Payment
	AmountCents int64
}
type OperationResult struct {
	State  string // pending, confirmed, rejected
	Refund *Refund
}

// These capabilities are optional; registration of a provider does not imply
// support for refund/cancel. Workers persist uncertainty before calling Execute.
type Operations interface {
	ExecuteOperation(context.Context, OperationRequest) (OperationResult, error)
	LookupOperation(context.Context, OperationRequest) (OperationResult, error)
}
