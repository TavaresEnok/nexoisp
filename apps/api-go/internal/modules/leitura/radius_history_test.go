package leitura

import (
	"context"
	"net/url"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/jsonx"
	"strings"
	"testing"
)

func TestHistoryFilters(t *testing.T) {
	for _, raw := range []string{"before=0", "before=-1", "before=9223372036854775808", "nas=bad", "state=online", "format=x", "state=open&state=closed", "tenant=other"} {
		q, _ := url.ParseQuery(raw)
		if _, e := parseHistory(q); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	q, _ := url.ParseQuery("before=9007199254740993&state=closed&username=%3Dformula&format=csv")
	f, e := parseHistory(q)
	if e != nil || f.Before != 9007199254740993 || f.Username != "=formula" {
		t.Fatal(f, e)
	}
}
func TestHistoryCSVExactCountersAndEmptyHeader(t *testing.T) {
	empty, e := historyCSV(nil)
	if e != nil || !strings.Contains(string(empty), radiusHistoryColumns) {
		t.Fatal(string(empty), e)
	}
	rows := []jsonx.Object{{{Name: "username", Value: " \n=HYPERLINK(\"invalid\")"}, {Name: "bytes_in", Value: "9223372036854775807"}, {Name: "delegated_ipv6_prefix", Value: "2001:db8::/56"}}}
	b, e := historyCSV(rows)
	if e != nil || !strings.Contains(string(b), "9223372036854775807") || !strings.Contains(string(b), "' \n=") || !strings.Contains(string(b), "2001:db8::/56") {
		t.Fatal(string(b), e)
	}
}

func TestAccountingHistoryScope(t *testing.T) {
	for _, actor := range []*auth.Ctx{nil, {}, {TenantID: "tenant", Support: true}, {TenantID: "tenant", SubscriberID: "subscriber"}, {TenantID: "tenant", PopIDs: []string{}}, {TenantID: "tenant", PopIDs: []string{"pop"}}} {
		if e := accountingScope(auth.With(context.Background(), actor)); e == nil {
			t.Fatalf("accepted restricted actor: %+v", actor)
		}
	}
	if e := accountingScope(auth.With(context.Background(), &auth.Ctx{TenantID: "tenant"})); e != nil {
		t.Fatal(e)
	}
}
