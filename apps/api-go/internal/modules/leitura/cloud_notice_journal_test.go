package leitura

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/tenancy"
)

func cloudJournalActor(tenant string) *auth.Ctx {
	return &auth.Ctx{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant}}
}

func cloudJournalRequest(id, rawQuery string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/notice-log/"+id+"/cloud-journal", nil)
	req.URL.RawQuery = rawQuery
	route := chi.NewRouteContext()
	route.URLParams.Add("id", id)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
}

func TestCloudNoticeJournalScope(t *testing.T) {
	tenant := "11111111-1111-4111-8111-111111111111"
	other := "22222222-2222-4222-8222-222222222222"
	operator, err := tenancy.OperatorScope("auditoria_negativa")
	if err != nil {
		t.Fatal(err)
	}
	denied := []*auth.Ctx{
		nil,
		{},
		{TenantID: tenant},
		{Scope: tenancy.Scope{TenantID: tenant}},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: other}},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant}, Support: true},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant}, SubscriberID: "subscriber"},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant, SubscriberID: "subscriber"}},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant}, PopIDs: []string{}},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant}, PopIDs: []string{"pop"}},
		{TenantID: tenant, Scope: tenancy.Scope{TenantID: tenant, PopIDs: []string{"pop"}}},
		{TenantID: tenant, Scope: operator},
	}
	for _, actor := range denied {
		err := cloudNoticeJournalScope(auth.With(context.Background(), actor))
		var httpErr *apierr.Error
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 403 {
			t.Fatalf("accepted restricted actor %+v: %v", actor, err)
		}
	}
	if err := cloudNoticeJournalScope(auth.With(context.Background(), cloudJournalActor(tenant))); err != nil {
		t.Fatal(err)
	}
}

func TestCloudNoticeJournalNilContext(t *testing.T) {
	res, err := (Service{}).cloudNoticeJournal(nil, nil)
	var httpErr *apierr.Error
	if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 403 || res.Value != nil || res.Raw != nil || res.CSV != nil {
		t.Fatalf("nil ctx: %+v %v", res, err)
	}
}

func TestCloudNoticeJournalQueryAndID(t *testing.T) {
	tenant := "11111111-1111-4111-8111-111111111111"
	ctx := auth.With(context.Background(), cloudJournalActor(tenant))
	s := Service{}
	for _, raw := range []string{"limit=1", "tenant=other", "before=1"} {
		res, err := s.cloudNoticeJournal(ctx, cloudJournalRequest("1", raw))
		var httpErr *apierr.Error
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 || httpErr.Message != "filtro desconhecido" || res.Value != nil {
			t.Fatalf("accepted %s: %+v %v", raw, res, err)
		}
	}
	res, err := s.cloudNoticeJournal(ctx, cloudJournalRequest("1", "x=1&x=2"))
	var httpErr *apierr.Error
	if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 || httpErr.Message != "filtro repetido" || res.Value != nil {
		t.Fatalf("repeated: %+v %v", res, err)
	}
	for _, raw := range []string{"x=%ZZ", "%ZZ=1", "x=1;x=2", "%", "a=%GG", "ok=1&bad=%ZZ", "x=1&x=2;y=3"} {
		res, err := s.cloudNoticeJournal(ctx, cloudJournalRequest("1", raw))
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 || httpErr.Message != "filtro inválido" || res.Value != nil || res.Raw != nil || res.CSV != nil {
			t.Fatalf("malformed %q reached past query parse: %+v %v", raw, res, err)
		}
	}
	for _, id := range []string{"", "0", "01", "-1", "+1", "1.0", "1e2", "9223372036854775808", "9999999999999999999"} {
		res, err := s.cloudNoticeJournal(ctx, cloudJournalRequest(id, ""))
		if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 || httpErr.Message != "identificador inválido" || res.Value != nil {
			t.Fatalf("accepted id %q: %+v %v", id, res, err)
		}
	}
	if _, err := parseCloudNoticeLogID("9223372036854775807"); err != nil {
		t.Fatal(err)
	}
	if _, err := parseCloudNoticeLogID("1"); err != nil {
		t.Fatal(err)
	}
	res, err = s.cloudNoticeJournal(ctx, nil)
	if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 400 || res.Value != nil {
		t.Fatalf("nil request: %+v %v", res, err)
	}
	denied, err := s.cloudNoticeJournal(auth.With(context.Background(), &auth.Ctx{TenantID: tenant, Support: true}), cloudJournalRequest("bad", "limit=1"))
	if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 403 || denied.Value != nil {
		t.Fatalf("scope must win before id and query: %+v %v", denied, err)
	}
}

func TestCloudNoticeJournalErrorWithoutData(t *testing.T) {
	tenant := "11111111-1111-4111-8111-111111111111"
	ctx := auth.With(context.Background(), cloudJournalActor(tenant))
	res, err := (Service{}).cloudNoticeJournal(ctx, cloudJournalRequest("9223372036854775807", ""))
	var httpErr *apierr.Error
	if err == nil || !asAPIErr(err, &httpErr) || httpErr.Status != 500 || res.Value != nil || res.Raw != nil || res.CSV != nil {
		t.Fatalf("nil db returned data: %+v %v", res, err)
	}
	poison := []byte(`[{"attempt_no":1,"state":"submitted","created_at":"2026-10-29T00:00:00.000000Z","wire_at":null,"http_status":200,"provider_message_id":"wamid.SECRET","excerpt":"corpo","token_enc":"v1.SECRET"}]`)
	_, err = assembleCloudNoticeJournal("1", "sent", 0, poison, []byte(`[]`))
	if err == nil || strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "corpo") || strings.Contains(err.Error(), "wamid") {
		t.Fatal(err)
	}
	_, err = assembleCloudNoticeJournal("1", "sent", 4, []byte(`[]`), []byte(`[]`))
	if err == nil {
		t.Fatal("accepted timeouts outside 0..3")
	}
}

func TestCloudNoticeJournalAssembleBoundsAndPrivacy(t *testing.T) {
	attempts := make([]map[string]any, 101)
	statuses := make([]map[string]any, 101)
	for i := 0; i < 101; i++ {
		attempts[i] = map[string]any{
			"attempt_no": 101 - i, "state": "not_sent", "created_at": "2026-10-29T00:00:00.000000Z", "wire_at": nil, "http_status": nil,
		}
		statuses[i] = map[string]any{
			"attempt_no": 101 - i, "raw_status": "delivered", "created_at": "2026-10-29T00:00:00.000000Z",
		}
	}
	rawAttempts, _ := json.Marshal(attempts)
	rawStatuses, _ := json.Marshal(statuses)
	resp, err := assembleCloudNoticeJournal("9223372036854775807", "sent", 3, rawAttempts, rawStatuses)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.AttemptsTruncated || !resp.StatusesTruncated || len(resp.Attempts) != 100 || len(resp.Statuses) != 100 {
		t.Fatalf("bounds: %+v len %d %d", resp.AttemptsTruncated, len(resp.Attempts), len(resp.Statuses))
	}
	if resp.Attempts[0].AttemptNo != 101 || resp.Attempts[99].AttemptNo != 2 {
		t.Fatalf("attempt order %d %d", resp.Attempts[0].AttemptNo, resp.Attempts[99].AttemptNo)
	}
	if resp.Statuses[0].AttemptNo != 101 || resp.Statuses[99].RawStatus != "delivered" {
		t.Fatalf("status order %+v", resp.Statuses[0])
	}
	body, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.Contains(text, `"notice_log_id":"9223372036854775807"`) {
		t.Fatal(text)
	}
	for _, banned := range []string{"provider_message_id", "token_enc", "webhook_secret", "excerpt", "body_hash", "phone", "cloud_account_id"} {
		if strings.Contains(text, banned) {
			t.Fatal(text)
		}
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, ok := decoded["attempts"].([]any); !ok {
		t.Fatal(text)
	}
	empty, err := assembleCloudNoticeJournal("1", "queued", 0, []byte(`[]`), []byte(`null`))
	if err != nil || empty.Attempts == nil || empty.Statuses == nil || len(empty.Attempts) != 0 || len(empty.Statuses) != 0 || empty.AttemptsTruncated || empty.StatusesTruncated {
		t.Fatalf("empty journal: %+v %v", empty, err)
	}
	exact := make([]map[string]any, 100)
	for i := 0; i < 100; i++ {
		exact[i] = attempts[i]
	}
	rawExact, _ := json.Marshal(exact)
	page, err := assembleCloudNoticeJournal("1", "sent", 0, rawExact, []byte(`[]`))
	if err != nil || page.AttemptsTruncated || len(page.Attempts) != 100 {
		t.Fatalf("exact page: %+v %v", page.AttemptsTruncated, err)
	}
}

func TestCloudNoticeJournalSQL(t *testing.T) {
	sql := strings.ToLower(cloudNoticeJournalSQL)
	for _, piece := range []string{
		"from notice_log l",
		"l.tenant_id = $1::uuid",
		"l.id = $2",
		"from cloud_notice_attempts a",
		"a.tenant_id = $1::uuid",
		"a.notice_log_id = l.id",
		"order by a.attempt_no desc",
		"limit 101",
		"join cloud_notice_status s",
		"s.tenant_id = a.tenant_id",
		"s.cloud_account_id = a.cloud_account_id",
		"s.provider_message_id = a.provider_message_id",
		"s.tenant_id = $1::uuid",
		"a.provider_message_id is not null",
		"order by s.created_at desc, s.id desc",
		"order by page.attempt_no desc",
		"order by page.created_at desc, page.id desc",
	} {
		if !strings.Contains(sql, piece) {
			t.Errorf("missing %s", piece)
		}
	}
	if strings.Count(sql, "limit 101") != 2 {
		t.Fatalf("truncation probe count %d", strings.Count(sql, "limit 101"))
	}
	for _, banned := range []string{
		"token_enc", "webhook_secret_enc", "excerpt", "body_hash", "phone", "contact",
		"insert ", "update ", "delete ", "grant ", "truncate", "select *",
		"'provider_message_id'", "'cloud_account_id'", "'excerpt'", "'body'",
	} {
		if strings.Contains(sql, banned) {
			t.Errorf("sql exposes %s", banned)
		}
	}
}

func TestCloudNoticeJournalRoute(t *testing.T) {
	if cloudNoticeJournalPermission != "settings:manage" || cloudNoticeJournalPath != "/api/notice-log/{id}/cloud-journal" {
		t.Fatal(cloudNoticeJournalPermission, cloudNoticeJournalPath)
	}
	raw, err := os.ReadFile("../../../rotas.json")
	if err != nil {
		t.Fatal(err)
	}
	var inventory struct {
		Routes []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &inventory); err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, route := range inventory.Routes {
		if route.Path == "/api/notice-log/:id/cloud-journal" {
			seen++
			if route.Method != http.MethodGet {
				t.Fatalf("method %s", route.Method)
			}
		}
	}
	if seen != 1 {
		t.Fatalf("inventory matches %d", seen)
	}
}
