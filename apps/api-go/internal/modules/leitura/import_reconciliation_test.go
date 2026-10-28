package leitura

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
)

func TestImportReconciliationRequest(t *testing.T) {
	id := "11111111-1111-1111-1111-111111111111"
	for _, raw := range []string{"before=1", "kind=invoices", "tenant=other", "limit=1"} {
		q, _ := url.ParseQuery(raw)
		err := parseImportReconciliationRequest(id, q)
		if err == nil || err.Error() != "filtro desconhecido" {
			t.Errorf("accepted %s: %v", raw, err)
		}
	}
	q, _ := url.ParseQuery("x=1&x=2")
	if err := parseImportReconciliationRequest(id, q); err == nil || err.Error() != "filtro repetido" {
		t.Fatal(err)
	}
	for _, raw := range []string{"", "bad", "123", "not-a-uuid", "11111111-1111-1111-1111-11111111111"} {
		err := parseImportReconciliationRequest(raw, url.Values{})
		var httpErr *apierr.Error
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 {
			t.Errorf("accepted id %q: %v", raw, err)
		}
	}
	if err := parseImportReconciliationRequest(id, url.Values{}); err != nil {
		t.Fatal(err)
	}
}

func asAPIErr(err error, target **apierr.Error) bool {
	httpErr, ok := err.(*apierr.Error)
	if ok {
		*target = httpErr
	}
	return ok
}

func TestImportReconciliationScope(t *testing.T) {
	for _, actor := range []*auth.Ctx{nil, {}, {TenantID: "tenant", Support: true}, {TenantID: "tenant", SubscriberID: "subscriber"}, {TenantID: "tenant", PopIDs: []string{}}, {TenantID: "tenant", PopIDs: []string{"pop"}}} {
		err := importReconciliationScope(auth.With(context.Background(), actor))
		var httpErr *apierr.Error
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 403 {
			t.Fatalf("accepted restricted actor: %+v (%v)", actor, err)
		}
	}
	if err := importReconciliationScope(auth.With(context.Background(), &auth.Ctx{TenantID: "tenant"})); err != nil {
		t.Fatal(err)
	}
}

func TestImportReconciliationSQLDocumentsEntityAndMoney(t *testing.T) {
	for _, piece := range []string{
		"k.subscriber_id",
		"b.kind = 'subscribers'",
		"b.kind = 'contracts'",
		"k.id in (select entity_id from created_entities)",
		"desired_version = 0",
		"secret_enc is not null",
		"::bigint::text",
		"provider_issuance_id",
		"gateway_charge_id",
		"provider_issuance",
		"p.created_at > b.created_at",
		"canceled_at > b.created_at",
		"legacy_issuance_violations",
		"open_residual_cents",
		"limit 500",
		"now()",
		"'import_rows'",
		"estado atual do Nexo; não comprova saldo na instituição de origem",
	} {
		if !strings.Contains(importReconciliationSQL, piece) {
			t.Errorf("missing %s", piece)
		}
	}
}
