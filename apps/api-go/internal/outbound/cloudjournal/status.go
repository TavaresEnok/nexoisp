// Observação de status do journal. Não envia, não move dinheiro e não interpreta protocolo de provedor.
package cloudjournal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"unicode/utf16"
	"unicode/utf8"

	"nexoisp/api-go/internal/db"
)

const (
	statusBodyMax = 4096
	statusRawMax  = 64
	statusIDMax   = 128
)

var (
	errStatusOversize = errors.New("cloudjournal: corpo acima de 4096 bytes")
	errStatusUnproved = errors.New("cloudjournal: autenticador não provado")
	errStatusVerify   = errors.New("cloudjournal: assinatura recusada")
	errStatusDecoder  = errors.New("cloudjournal: decoder de status não provado")
	errStatusDecode   = errors.New("cloudjournal: status não decodificado")
	errStatusShape    = errors.New("cloudjournal: observação fora do limite")
	errStatusScope    = errors.New("cloudjournal: app_tenant incompatível")
	errStatusAccount  = errors.New("cloudjournal: conta inativa ou invisível")
	errStatusUnknown  = errors.New("cloudjournal: id de provedor sem submitted nesta conta")
	errStatusPersist  = errors.New("cloudjournal: observação não gravada")
	errStatusTx       = errors.New("cloudjournal: transação ausente")
)

var (
	statusUUID  = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	statusToken = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`)
)

// StatusDecoder é dependência por instância. DecodeStatus devolve o id já submetido
// e um texto curto. Não é parser de corpo, cabeçalho ou algoritmo de assinatura.
type StatusDecoder interface {
	DecoderProven() bool
	DecodeStatus(body []byte) (providerID, rawStatus string, err error)
}

// UnprovedAuthenticator é o autenticador de produção. Proven permanece falso
// e Verify recusa. Este tipo não implementa StatusDecoder.
type UnprovedAuthenticator struct{}

func (UnprovedAuthenticator) Proven() bool { return false }

func (UnprovedAuthenticator) Verify(map[string]string, []byte) error {
	return errStatusUnproved
}

// AcceptStatus grava uma observação append-only quando a conta do tenant está
// ativa e o id já pertence a um attempt submitted dessa mesma conta.
// Corpo, assinatura ou decoder não provados recusam antes de qualquer escrita.
// MoneyWrites e Sends permanecem zero.
func AcceptStatus(ctx context.Context, tx *db.Tx, tenant, accountID string, headers map[string]string, body []byte, auth Authenticator) (StatusEffect, error) {
	if len(body) == 0 {
		return statusNeutral(false, false), errStatusShape
	}
	if len(body) > statusBodyMax {
		return statusNeutral(false, false), errStatusOversize
	}
	if auth == nil || !auth.Proven() {
		return statusNeutral(false, false), errStatusUnproved
	}
	if err := auth.Verify(headers, body); err != nil {
		return statusNeutral(false, false), errStatusVerify
	}
	decoder, ok := auth.(StatusDecoder)
	if !ok || !decoder.DecoderProven() {
		return statusNeutral(false, false), errStatusDecoder
	}
	providerID, rawStatus, err := decoder.DecodeStatus(body)
	if err != nil {
		return statusNeutral(false, false), errStatusDecode
	}
	if err = statusObservation(providerID, rawStatus, body); err != nil {
		return statusNeutral(false, false), err
	}
	if tx == nil {
		return statusNeutral(false, false), errStatusTx
	}
	if err = statusScope(ctx, tx, tenant, accountID); err != nil {
		return statusNeutral(false, false), err
	}
	visible, err := statusAccountActive(ctx, tx, tenant, accountID)
	if err != nil {
		return statusNeutral(false, false), err
	}
	if !visible {
		return statusNeutral(false, false), errStatusAccount
	}
	found, err := statusSubmitted(ctx, tx, tenant, accountID, providerID)
	if err != nil {
		return statusNeutral(false, false), err
	}
	if !found {
		return statusNeutral(false, false), errStatusUnknown
	}
	sum := sha256.Sum256(body)
	inserted, err := tx.Affected(ctx, `
insert into cloud_notice_status (tenant_id, cloud_account_id, provider_message_id, body_hash, raw_status)
values ($1::uuid, $2::uuid, $3, $4, $5)
on conflict (tenant_id, cloud_account_id, body_hash) do nothing`,
		tenant, accountID, providerID, hex.EncodeToString(sum[:]), rawStatus)
	if err != nil {
		return statusNeutral(false, false), errStatusPersist
	}
	if inserted == 0 {
		return statusNeutral(false, true), nil
	}
	return statusNeutral(true, false), nil
}

func statusNeutral(applied, duplicate bool) StatusEffect {
	return StatusEffect{Applied: applied, Duplicate: duplicate, MoneyWrites: 0, Sends: 0}
}

func statusObservation(providerID, rawStatus string, body []byte) error {
	if providerID == "" || utf8.RuneCountInString(providerID) > statusIDMax || !statusIDText(providerID) {
		return errStatusShape
	}
	if !statusToken.MatchString(rawStatus) || utf16Len(rawStatus) > statusRawMax {
		return errStatusShape
	}
	payload := string(body)
	if payload == providerID || payload == rawStatus {
		return errStatusShape
	}
	return nil
}

func statusIDText(value string) bool {
	for _, r := range value {
		switch {
		case r < 0x20 || r == 0x7f:
			return false
		case r == '{' || r == '}' || r == '"' || r == '\\' || r == '<' || r == '>' || r == '\'':
			return false
		}
	}
	return true
}

func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func statusScope(ctx context.Context, tx *db.Tx, tenant, accountID string) error {
	if !statusUUID.MatchString(tenant) || !statusUUID.MatchString(accountID) {
		return errStatusScope
	}
	var match bool
	var subscriber string
	if err := tx.QueryRow(ctx, `select coalesce(app_tenant() = $1::uuid, false), coalesce(app_subscriber()::text, '')`, tenant).Scan(&match, &subscriber); err != nil {
		return errStatusScope
	}
	if !match || subscriber != "" {
		return errStatusScope
	}
	return nil
}

func statusAccountActive(ctx context.Context, tx *db.Tx, tenant, accountID string) (bool, error) {
	var active bool
	var n int
	err := tx.QueryRow(ctx, `
select coalesce(bool_or(active), false), count(*)::int
from (
    select active
    from cloud_accounts
    where id = $1::uuid
      and tenant_id = $2::uuid
      and tenant_id = app_tenant()
      and app_subscriber() is null
    for share
) as account_row`, accountID, tenant).Scan(&active, &n)
	if err != nil {
		return false, errStatusPersist
	}
	return n == 1 && active, nil
}

func statusSubmitted(ctx context.Context, tx *db.Tx, tenant, accountID, providerID string) (bool, error) {
	var n int
	err := tx.QueryRow(ctx, `
select count(*)::int
from (
    select 1
    from cloud_notice_attempts
    where tenant_id = $1::uuid
      and tenant_id = app_tenant()
      and cloud_account_id = $2::uuid
      and provider_message_id = $3
      and state = 'submitted'
      and app_subscriber() is null
    for share
) as submitted_attempt`, tenant, accountID, providerID).Scan(&n)
	if err != nil {
		return false, errStatusPersist
	}
	return n == 1, nil
}
