package efi

import (
	"context"
	"net/http"
	"nexoisp/api-go/internal/finance/providers"
	"regexp"
	"time"
)

type pixRefund struct {
	ID       string `json:"id"`
	ReturnID string `json:"rtrId"`
	Value    string `json:"valor"`
	Status   string `json:"status"`
	Time     struct {
		Requested string `json:"solicitacao"`
		Settled   string `json:"liquidacao"`
	} `json:"horario"`
}

var safeRemoteID = regexp.MustCompile(`^[a-zA-Z0-9]{1,64}$`)

func (r pixRefund) normalize(payment string) (providers.OperationResult, error) {
	n, err := cents(r.Value)
	if err != nil || !safeRemoteID.MatchString(r.ID) {
		return providers.OperationResult{}, failure(providers.Conflict, "invalid refund identity or amount")
	}
	switch r.Status {
	case "EM_PROCESSAMENTO":
		return providers.OperationResult{State: "pending"}, nil
	case "NAO_REALIZADO":
		return providers.OperationResult{State: "rejected"}, nil
	case "DEVOLVIDO":
		refund := providers.Refund{ID: r.ID, ReturnID: r.ReturnID, PaymentID: payment, AmountCents: n, SettledAt: r.Time.Settled}
		if refund.Validate() != nil {
			return providers.OperationResult{}, failure(providers.Conflict, "confirmed refund lacks settlement identity/time")
		}
		return providers.OperationResult{State: "confirmed", Refund: &refund}, nil
	default:
		return providers.OperationResult{}, failure(providers.Conflict, "unknown refund state")
	}
}
func cancelResult(snapshot providers.Snapshot) (providers.OperationResult, error) {
	if len(snapshot.Payments) > 0 || len(snapshot.Refunds) > 0 {
		return providers.OperationResult{}, failure(providers.Conflict, "received charge cannot be canceled as unpaid")
	}
	if snapshot.Status == "removed" {
		return providers.OperationResult{State: "confirmed"}, nil
	}
	if snapshot.Status == "active" {
		return providers.OperationResult{State: "pending"}, nil
	}
	return providers.OperationResult{}, failure(providers.Conflict, "charge state prevents cancellation")
}
func (a *Immediate) refund(ctx context.Context, op providers.OperationRequest, write bool) (providers.OperationResult, error) {
	if op.Reference.Scope != a.request.Scope || op.Reference.ChargeID != TxID(a.request) || op.Reference.IntentKey != a.request.IntentKey || !safeRemoteID.MatchString(op.ID) || !safeRemoteID.MatchString(op.Payment.ID) || op.Payment.Validate() != nil || op.AmountCents <= 0 || op.AmountCents > op.Payment.AmountCents {
		return providers.OperationResult{}, failure(providers.Conflict, "refund differs from frozen payment")
	}
	var original struct {
		ID    string `json:"endToEndId"`
		TxID  string `json:"txid"`
		Value string `json:"valor"`
		Time  string `json:"horario"`
	}
	if err := a.client.request(ctx, http.MethodGet, "/v2/pix/"+op.Payment.ID, nil, &original); err != nil {
		return providers.OperationResult{}, err
	}
	n, err := cents(original.Value)
	stamp, e := time.Parse(time.RFC3339Nano, original.Time)
	frozen, f := time.Parse(time.RFC3339Nano, op.Payment.PaidAt)
	if err != nil || e != nil || f != nil || original.ID != op.Payment.ID || original.TxID != op.Reference.ChargeID || n != op.Payment.AmountCents || !stamp.Equal(frozen) {
		return providers.OperationResult{}, failure(providers.Conflict, "authoritative Pix differs from original receipt")
	}
	path := "/v2/pix/" + op.Payment.ID + "/devolucao/" + op.ID
	if write {
		var accepted pixRefund
		if err = a.client.request(ctx, http.MethodPut, path, map[string]string{"valor": decimal(op.AmountCents)}, &accepted); err != nil {
			return providers.OperationResult{}, err
		}
	}
	// Even an accepted write is confirmed only by readback. No retry of the PUT.
	var result pixRefund
	if err = a.client.request(ctx, http.MethodGet, path, nil, &result); err != nil {
		return providers.OperationResult{}, err
	}
	n, err = cents(result.Value)
	if err != nil || result.ID != op.ID || n != op.AmountCents {
		return providers.OperationResult{}, failure(providers.Conflict, "refund readback differs from durable intention")
	}
	return result.normalize(op.Payment.ID)
}
func (a *Immediate) ExecuteOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	return a.executeOperation(ctx, op, "/v2/cob/", a.Lookup)
}
func (a *Immediate) LookupOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	if op.Kind == "refund" {
		return a.refund(ctx, op, false)
	}
	if op.Kind != "cancel" {
		return providers.OperationResult{}, failure(providers.Rejected, "unsupported operation")
	}
	s, err := a.Lookup(ctx, op.Reference)
	if err != nil {
		return providers.OperationResult{}, err
	}
	return cancelResult(s)
}
func (a *Immediate) executeOperation(ctx context.Context, op providers.OperationRequest, path string, lookup func(context.Context, providers.Reference) (providers.Snapshot, error)) (providers.OperationResult, error) {
	if op.Kind == "refund" {
		return a.refund(ctx, op, true)
	}
	if op.Kind != "cancel" {
		return providers.OperationResult{}, failure(providers.Rejected, "unsupported operation")
	}
	s, err := lookup(ctx, op.Reference)
	if err != nil {
		return providers.OperationResult{}, err
	}
	result, err := cancelResult(s)
	if err != nil || result.State == "confirmed" {
		return result, err
	}
	var response pixCharge
	if err = a.client.request(ctx, http.MethodPatch, path+TxID(a.request), map[string]string{"status": "REMOVIDA_PELO_USUARIO_RECEBEDOR"}, &response); err != nil {
		return providers.OperationResult{}, err
	}
	s, err = lookup(ctx, op.Reference)
	if err != nil {
		return providers.OperationResult{}, err
	}
	return cancelResult(s)
}
func (a *Due) ExecuteOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	return a.base.executeOperation(ctx, op, "/v2/cobv/", a.Lookup)
}
func (a *Due) LookupOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	if op.Kind == "refund" {
		return a.base.refund(ctx, op, false)
	}
	if op.Kind != "cancel" {
		return providers.OperationResult{}, failure(providers.Rejected, "unsupported operation")
	}
	s, err := a.Lookup(ctx, op.Reference)
	if err != nil {
		return providers.OperationResult{}, err
	}
	return cancelResult(s)
}
func (a *Bolix) ExecuteOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	if op.Kind != "cancel" {
		return providers.OperationResult{}, failure(providers.Rejected, "Bolix refund is not supported by this contract")
	}
	s, err := a.Lookup(ctx, op.Reference)
	if err != nil {
		return providers.OperationResult{}, err
	}
	result, err := cancelResult(s)
	if err != nil || result.State == "confirmed" {
		return result, err
	}
	var response struct {
		Code int `json:"code"`
	}
	if err = a.client.request(ctx, http.MethodPut, "/v1/charge/"+s.Charge.ID+"/cancel", nil, &response); err != nil {
		return providers.OperationResult{}, err
	}
	if response.Code != 200 {
		return providers.OperationResult{}, failure(providers.Unknown, "cancel acknowledgment invalid; lookup required")
	}
	return a.LookupOperation(ctx, op)
}
func (a *Bolix) LookupOperation(ctx context.Context, op providers.OperationRequest) (providers.OperationResult, error) {
	if op.Kind != "cancel" {
		return providers.OperationResult{}, failure(providers.Rejected, "unsupported Bolix operation")
	}
	s, err := a.Lookup(ctx, op.Reference)
	if err != nil {
		return providers.OperationResult{}, err
	}
	return cancelResult(s)
}
