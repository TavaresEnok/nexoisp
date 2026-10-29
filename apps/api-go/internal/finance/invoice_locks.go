package finance

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"

	"github.com/google/uuid"
)

// invoiceAdvisorySalt is the transaction advisory salt for invoice writers.
// Other salts in this process are 7411001, 7411002, 7411003 and 7411004.
const invoiceAdvisorySalt int64 = 7411005

// LockInvoices takes pg_advisory_xact_lock(hashtextextended(tenant:invoice:id, 7411005))
// for every id, in canonical UUID order, and only then locks the visible invoice
// rows in that same order. An empty tenant reads app_tenant() from the transaction.
//
// A nested call repeats those locks. They are reentrant in this transaction, so
// the repetition keeps the same order. Callers invoke this before any invoice
// FOR UPDATE or UPDATE. The helper does not read pg_locks and does not skip the
// advisory when a row lock might already be held.
func LockInvoices(ctx context.Context, tx *db.Tx, tenant string, ids ...string) error {
	ordered, err := canonicalInvoiceIDs(ids)
	if err != nil || len(ordered) == 0 {
		return err
	}
	tenant, err = lockTenant(ctx, tx, tenant)
	if err != nil {
		return err
	}
	for _, id := range ordered {
		if err = tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,$2))`, tenant+":invoice:"+id, invoiceAdvisorySalt); err != nil {
			return err
		}
	}
	_, err = tx.Objects(ctx, `select id from invoices where tenant_id = $1::uuid and id = any($2::uuid[]) order by id for update`, tenant, ordered)
	return err
}

func lockTenant(ctx context.Context, tx *db.Tx, tenant string) (string, error) {
	var scope *string
	if err := tx.QueryRow(ctx, `select app_tenant()::text`).Scan(&scope); err != nil {
		return "", err
	}
	var resolved string
	if scope != nil {
		parsed, err := uuid.Parse(*scope)
		if err != nil {
			return "", err
		}
		resolved = parsed.String()
	}
	if strings.TrimSpace(tenant) == "" {
		if resolved == "" {
			return "", fmt.Errorf("tenant ausente no escopo da transação")
		}
		return resolved, nil
	}
	parsed, err := uuid.Parse(tenant)
	if err != nil {
		return "", apierr.New(400, "tenant inválido")
	}
	tenant = parsed.String()
	if resolved != "" && tenant != resolved {
		return "", fmt.Errorf("tenant divergente do escopo da transação")
	}
	return tenant, nil
}

func canonicalInvoiceIDs(ids []string) ([]string, error) {
	seen := make(map[string]struct{}, len(ids))
	ordered := make([]string, 0, len(ids))
	for _, raw := range ids {
		parsed, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, apierr.New(400, "fatura inválida")
		}
		id := parsed.String()
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ordered = append(ordered, id)
	}
	slices.Sort(ordered)
	return ordered, nil
}
