package finance

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
)

func TestNoticeReviewReplayPreservesFinancialReservation(t *testing.T) {
	d, scope := issuanceDatabase(t)
	ctx := context.Background()
	r := issuanceFixture(t, d, scope)
	item, e := (SandboxIssuance{DB: d}).Prepare(ctx, scope, r, strings.Repeat("a", 64))
	if e != nil {
		t.Fatal(e)
	}
	id, intent, actor := uuid.NewString(), uuid.NewString(), ""
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select id from users where role='admin' order by id limit 1`).Scan(&actor); e != nil {
			return e
		}
		return tx.Exec(ctx, `insert into provider_notices(id,tenant_id,financial_connection_id,payload_hash,charge_id,payment_id,payload,status) values($1,app_tenant(),$2,$3,'synthetic-charge','synthetic-notice','{"untrusted":"never cash"}','review')`, id, r.Scope.ConnectionID, strings.Repeat("b", 64))
	}); e != nil {
		t.Fatal(e)
	}
	reason := "Conferência sintética sem reconhecer recebimento"
	review := func(intent, action, reason string) (map[string]any, error) {
		var result map[string]any
		e := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			var e error
			result, e = ReviewProviderNotice(ctx, tx, r.Scope.ConnectionID, id, actor, intent, action, reason)
			return e
		})
		return result, e
	}
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := review(intent, "ack", reason)
			if e != nil {
				failures <- e
			}
		}()
	}
	wg.Wait()
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	var audits, payments int
	var state, noticeState string
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select count(*) from audit_events where entity_type='provider_notice' and entity_id=$1`, id).Scan(&audits); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*) from payments where invoice_id=$1`, r.InvoiceID).Scan(&payments); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select state from provider_issuance where id=$1`, item.ID).Scan(&state); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `select status from provider_notices where id=$1`, id).Scan(&noticeState)
	}); e != nil || audits != 1 || payments != 0 || state != "prepared" || noticeState != "review" {
		t.Fatal(audits, payments, state, noticeState, e)
	}
	// Lost response after commit replays the recorded decision; it never acknowledges cash.
	response, e := review(intent, "ack", reason)
	if e != nil || response["replayed"] != true || response["funds_changed"] != false || response["provider_called"] != false {
		t.Fatal(response, e)
	}
	_, e = review(intent, "retry", reason)
	if v, ok := e.(*apierr.Error); !ok || v.Status != 409 {
		t.Fatal("intent drift", e)
	}
	// Acknowledgment must not release the outstanding remote-issuance reservation.
	e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update invoices set amount_cents=amount_cents+1 where id=$1`, r.InvoiceID)
	})
	assertReservationConflict(t, e)
	retry := uuid.NewString()
	response, e = review(retry, "retry", "Solicitar consulta sintética da cobrança original")
	if e != nil || response["result"] != "lookup_queued" {
		t.Fatal(response, e)
	}
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status from provider_notices where id=$1`, id).Scan(&noticeState)
	}); e != nil || noticeState != "unmatched" {
		t.Fatal(noticeState, e)
	}
	response, e = review(retry, "retry", "Solicitar consulta sintética da cobrança original")
	if e != nil || response["replayed"] != true {
		t.Fatal(response, e)
	}
	// Already processed notices cannot be reintroduced into the receipt workflow.
	if e = d.WithScope(ctx, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update provider_notices set status='processed' where id=$1`, id)
	}); e != nil {
		t.Fatal(e)
	}
	_, e = review(uuid.NewString(), "retry", reason)
	if v, ok := e.(*apierr.Error); !ok || v.Status != 409 {
		t.Fatal("processed notice reopened", e)
	}
	t.Log("eight concurrent acknowledgments, lost response replay, reason/action identity, preserved reservation, lookup-only retry and processed guard passed")
}
