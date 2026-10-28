package leitura

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/jsonx"
)

func TestTelemetryQuery(t *testing.T) {
	for _, raw := range []string{"before=1", "nas=x", "state=open", "format=csv", "tenant=other", "limit=1"} {
		q, _ := url.ParseQuery(raw)
		e := rejectTelemetryQuery(q)
		if e == nil || e.Error() != "filtro desconhecido" {
			t.Errorf("accepted %s: %v", raw, e)
		}
	}
	q, _ := url.ParseQuery("x=1&x=2")
	if e := rejectTelemetryQuery(q); e == nil || e.Error() != "filtro repetido" {
		t.Fatal(e)
	}
	if e := rejectTelemetryQuery(url.Values{}); e != nil {
		t.Fatal(e)
	}
}

func TestTelemetryItemsKeepsDatabaseMetadataWithoutNAS(t *testing.T) {
	metaAt := strings.Index(radiusTelemetrySQL, ") meta")
	devicesAt := strings.Index(radiusTelemetrySQL, "from devices d")
	if metaAt < 0 || devicesAt < metaAt || !strings.Contains(radiusTelemetrySQL, "now() as generated_at") {
		t.Fatal("generated_at must survive a tenant with no radius_nas rows")
	}
	empty := jsonx.Object{
		{Name: "device_id", Value: nil},
		{Name: "name", Value: nil},
		{Name: "open_sessions", Value: nil},
		{Name: "generated_at", Value: "2026-10-28T12:00:00.000Z"},
		{Name: "last_usage_applied_at", Value: "2026-10-28T12:34:56.000Z"},
	}
	items, generated, applied := telemetryItems([]jsonx.Object{empty})
	if len(items) != 0 || generated != "2026-10-28T12:00:00.000Z" || applied != "2026-10-28T12:34:56.000Z" {
		t.Fatalf("empty nas: items=%v generated=%v applied=%v", items, generated, applied)
	}
	nas := jsonx.Object{
		{Name: "device_id", Value: "dev"},
		{Name: "name", Value: "NAS"},
		{Name: "open_sessions", Value: int32(2)},
		{Name: "generated_at", Value: "2026-10-28T12:00:00.000Z"},
		{Name: "last_usage_applied_at", Value: nil},
	}
	items, generated, applied = telemetryItems([]jsonx.Object{nas})
	if len(items) != 1 || items[0].Get("device_id") != "dev" || items[0].Get("generated_at") != nil || items[0].Get("last_usage_applied_at") != nil || items[0].Get("open_sessions") != int32(2) {
		t.Fatalf("nas item: %+v", items)
	}
	if generated != "2026-10-28T12:00:00.000Z" || applied != nil {
		t.Fatalf("meta: %v %v", generated, applied)
	}
}

func TestTelemetryScope(t *testing.T) {
	for _, actor := range []*auth.Ctx{nil, {}, {TenantID: "tenant", Support: true}, {TenantID: "tenant", SubscriberID: "subscriber"}, {TenantID: "tenant", PopIDs: []string{}}, {TenantID: "tenant", PopIDs: []string{"pop"}}} {
		if e := accountingScope(auth.With(context.Background(), actor)); e == nil {
			t.Fatalf("accepted restricted actor: %+v", actor)
		}
	}
	if e := accountingScope(auth.With(context.Background(), &auth.Ctx{TenantID: "tenant"})); e != nil {
		t.Fatal(e)
	}
}
