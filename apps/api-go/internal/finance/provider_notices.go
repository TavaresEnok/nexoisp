package finance

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

type NoticeOutcome struct {
	Received   int `json:"received"`
	Duplicates int `json:"duplicates"`
	Unmatched  int `json:"unmatched"`
}

// Caller MUST authenticate the transport before calling. Notices only persist and
// schedule authoritative lookup: supplied amount, tenant and account never post cash.
func AcceptPixNotices(ctx context.Context, database *db.DB, connection string, raw []byte) (NoticeOutcome, error) {
	var outcome NoticeOutcome
	if len(raw) == 0 {
		c, e := LookupConnection(ctx, database, connection)
		if e != nil {
			return outcome, e
		}
		if c.Get("provider") != "efi" || c.Get("environment") != "sandbox" || (c.Get("status") != "active" && c.Get("status") != "disabled") {
			return outcome, apierr.New(404, "conexão Pix não disponível")
		}
		return outcome, nil
	}
	var body struct {
		Pix []json.RawMessage `json:"pix"`
	}
	if len(raw) > 512<<10 || json.Unmarshal(raw, &body) != nil || len(body.Pix) == 0 || len(body.Pix) > 100 {
		return outcome, apierr.New(400, "notificação Pix inválida")
	}
	type entry struct {
		charge, payment, hash string
		payload               []byte
	}
	entries := make([]entry, 0, len(body.Pix))
	for _, item := range body.Pix {
		decoder := json.NewDecoder(bytes.NewReader(item))
		decoder.UseNumber()
		var values map[string]any
		if decoder.Decode(&values) != nil || decoder.Decode(new(any)) != io.EOF {
			return outcome, apierr.New(400, "conteúdo Pix inválido")
		}
		txid, _ := values["txid"].(string)
		payment, _ := values["endToEndId"].(string)
		if txid == "" || len(txid) > 256 || payment == "" || len(payment) > 256 {
			return outcome, apierr.New(400, "identidade Pix ausente")
		}
		canonical, err := json.Marshal(values)
		if err != nil {
			return outcome, errors.New("notice canonical encoding failed")
		}
		entries = append(entries, entry{txid, payment, cryptox.SHA256(string(canonical)), canonical})
	}
	c, err := LookupConnection(ctx, database, connection)
	if err != nil {
		return outcome, err
	}
	if c.Get("provider") != "efi" || c.Get("environment") != "sandbox" || (c.Get("status") != "active" && c.Get("status") != "disabled") {
		return outcome, apierr.New(404, "conexão Pix não disponível")
	}
	scope := tenancy.Scope{TenantID: jsonx.String(c.Get("tenant_id"))}
	err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
		for _, e := range entries {
			var matched bool
			if err := tx.QueryRow(ctx, `select exists(select 1 from provider_issuance where financial_connection_id=$1 and charge_id=$2 and state='issued')`, connection, e.charge).Scan(&matched); err != nil {
				return err
			}
			state := "unmatched"
			if matched {
				state = "pending"
			}
			count, err := tx.Affected(ctx, `insert into provider_notices(tenant_id,financial_connection_id,payload_hash,charge_id,payment_id,payload,status) values($1,$2,$3,$4,$5,$6::jsonb,$7) on conflict(financial_connection_id,payload_hash) do nothing`, scope.TenantID, connection, e.hash, e.charge, e.payment, string(e.payload), state)
			if err != nil {
				return err
			}
			if count == 0 {
				outcome.Duplicates++
			} else {
				outcome.Received++
				if !matched {
					outcome.Unmatched++
				}
			}
			if matched {
				if err = tx.Exec(ctx, `update provider_issuance set receipt_next_at=now() where financial_connection_id=$1 and charge_id=$2 and state='issued'`, connection, e.charge); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return NoticeOutcome{}, err
	}
	return outcome, nil
}
func queueMatchedNotices(ctx context.Context, tx *db.Tx) error {
	if err := tx.Exec(ctx, `update provider_issuance j set receipt_next_at=now() where j.state='issued' and not j.receipt_review and exists(select 1 from provider_notices n where n.financial_connection_id=j.financial_connection_id and n.charge_id=j.charge_id and n.status='unmatched')`); err != nil {
		return err
	}
	return tx.Exec(ctx, `update provider_notices n set status='pending' where n.status='unmatched' and exists(select 1 from provider_issuance j where j.financial_connection_id=n.financial_connection_id and j.charge_id=n.charge_id and j.state='issued')`)
}
