package leitura

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
)

func TestImportRevertEligibilityRequest(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	for _, raw := range []string{"before=1", "kind=invoices", "tenant=other", "limit=1"} {
		q, _ := url.ParseQuery(raw)
		err := parseImportRevertEligibilityRequest(id, q)
		if err == nil || err.Error() != "filtro desconhecido" {
			t.Errorf("accepted %s: %v", raw, err)
		}
	}
	q, _ := url.ParseQuery("x=1&x=2")
	if err := parseImportRevertEligibilityRequest(id, q); err == nil || err.Error() != "filtro repetido" {
		t.Fatal(err)
	}
	for _, raw := range []string{"", "bad", "123", "not-a-uuid", "11111111-1111-1111-1111-11111111111"} {
		err := parseImportRevertEligibilityRequest(raw, url.Values{})
		var httpErr *apierr.Error
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 {
			t.Errorf("accepted id %q: %v", raw, err)
		}
	}
	if err := parseImportRevertEligibilityRequest(id, url.Values{}); err != nil {
		t.Fatal(err)
	}
}

func TestImportRevertEligibilityScope(t *testing.T) {
	for _, actor := range []*auth.Ctx{nil, {}, {TenantID: "tenant", Support: true}, {TenantID: "tenant", SubscriberID: "subscriber"}, {TenantID: "tenant", PopIDs: []string{}}, {TenantID: "tenant", PopIDs: []string{"pop"}}} {
		err := importRevertEligibilityScope(auth.With(context.Background(), actor))
		var httpErr *apierr.Error
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 403 {
			t.Fatalf("accepted restricted actor: %+v (%v)", actor, err)
		}
	}
	if err := importRevertEligibilityScope(auth.With(context.Background(), &auth.Ctx{TenantID: "tenant"})); err != nil {
		t.Fatal(err)
	}
}

func TestImportRevertEligibilitySQLDocumentsBlockers(t *testing.T) {
	for _, piece := range []string{
		"payments_after_import",
		"payments.id",
		"p.created_at > b.created_at",
		"invoice_movements_after_import",
		"m.recorded_at > b.created_at",
		"provider_issuance",
		"gateway_charge_id",
		"provider_issuance_id",
		"payment_effects",
		"pe.created_at > b.created_at",
		"'notices'",
		"notice_log",
		"network_operations",
		"resources_provisioned",
		"desired_version > 0",
		"contract_history_after_import",
		"h.at > b.created_at",
		"invoices_created_after_import",
		"i.created_at > b.created_at",
		"support_records",
		"dependent_batches",
		"b.kind in ('subscribers', 'contracts')",
		"b.kind = 'invoices'",
		"status = 'created'",
		"entity_id is not null",
		"limit 20",
		"'reverted', false",
		"nenhuma reversão foi executada",
		"now()",
		"where g.n > 0",
	} {
		if !strings.Contains(importRevertEligibilitySQL, piece) {
			t.Errorf("missing %s", piece)
		}
	}
	later := importRevertEligibilitySQL
	start := strings.Index(later, "later_invoice_ids as (")
	end := strings.Index(later, "support_ids as (")
	if start < 0 || end < start {
		t.Fatal("later_invoice_ids CTE not found")
	}
	later = later[start:end]
	if !strings.Contains(later, "b.kind in ('subscribers', 'contracts')") {
		t.Error("later invoices must not block an invoice batch")
	}
	start = strings.Index(importRevertEligibilitySQL, "dependent_ids as (")
	end = strings.Index(importRevertEligibilitySQL, "select json_build_object(")
	if start < 0 || end < start {
		t.Fatal("dependent_ids CTE not found")
	}
	dependent := importRevertEligibilitySQL[start:end]
	if strings.Contains(dependent, "b.kind in ('subscribers', 'contracts')") {
		t.Error("subscriber expansion must not apply to contract batches")
	}
	subAt := strings.Index(dependent, "b.kind = 'subscribers'")
	conAt := strings.Index(dependent, "b.kind = 'contracts'")
	if subAt < 0 || conAt < subAt {
		t.Fatal("dependent_ids must split subscribers from contracts")
	}
	subscribers := dependent[subAt:conAt]
	contracts := dependent[conAt:]
	if !strings.Contains(subscribers, "k.subscriber_id in (select id from batch_subscribers)") || !strings.Contains(subscribers, "i.subscriber_id in (select id from batch_subscribers)") {
		t.Error("subscriber batches must expand to contracts and invoices of those subscribers")
	}
	if strings.Contains(contracts, "subscriber_id") {
		t.Error("contract batches must not expand by subscriber_id or sibling contracts")
	}
	if !strings.Contains(contracts, "i.contract_id in (select id from batch_contracts)") {
		t.Error("contract batches must include invoices of the contracts this batch created")
	}
	if !strings.Contains(dependent, "o.status in ('created', 'updated', 'unchanged')") {
		t.Error("dependent batches must count created, updated and unchanged references")
	}
	if strings.Contains(dependent, "o.status = 'created'") {
		t.Error("dependent batches must not ignore a later reimport that updates the entity")
	}
}
