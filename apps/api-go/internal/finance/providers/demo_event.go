package providers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

type Event struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"`
	ChargeID string   `json:"charge_id"`
	Payment  *Payment `json:"payment,omitempty"`
}

// DecodeDemo is called only AFTER authenticating raw bytes + connection. It is
// not a signature verifier or a codec for Efí/Asaas/Inter or any other real PSP.
// Missing currency is BRL solely for the existing demo contract.
func DecodeDemo(raw []byte) (Event, error) {
	var ev Event
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&ev); err != nil {
		return ev, errors.New("invalid event JSON or integer cents")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ev, errors.New("trailing event JSON")
	}
	if ev.ID == "" || len(ev.ID) > 256 || ev.Type == "" || ev.ChargeID == "" || len(ev.ChargeID) > 256 {
		return ev, errors.New("invalid event identity")
	}
	if ev.Type == "payment.confirmed" {
		if ev.Payment == nil {
			return ev, errors.New("confirmed payment missing")
		}
		if ev.Payment.Currency == "" {
			ev.Payment.Currency = "BRL"
		}
		if err := ev.Payment.Validate(); err != nil {
			return ev, err
		}
	}
	return ev, nil
}
