package finance

import (
	"context"
	"errors"
	"nexoisp/api-go/internal/db"
	"os"
	"strconv"
)

// Disabled until an operator chooses a policy. Only bodies of conclusively
// processed notices are redacted: durable fingerprints and audit remain intact.
func RetainProviderNotices(ctx context.Context, tx *db.Tx) error {
	raw := os.Getenv("NEXO_PROVIDER_NOTICE_PAYLOAD_KEEP_DAYS")
	if raw == "" || raw == "0" {
		return nil
	}
	days, e := strconv.Atoi(raw)
	if e != nil || days < 30 || days > 3650 {
		return errors.New("NEXO_PROVIDER_NOTICE_PAYLOAD_KEEP_DAYS must be 0 or 30..3650")
	}
	var n int64
	return tx.QueryRow(ctx, `select redact_provider_notice_payloads($1,1000)`, days).Scan(&n)
}
