package outbound

import (
	"context"
	"net/http"
	"os"
	"testing"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/outbound/cloudjournal"
)

type r07RedirectTrip func(*http.Request) (*http.Response, error)

func (f r07RedirectTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestR07RedirectWorkerJournalPG(t *testing.T) {
	if os.Getenv("NEXO_GO_TEST_DATABASE_URL") == "" && (os.Getenv("PG_REQUIRED") == "1" || os.Getenv("NEXO_CLOUD_PG_REQUIRED") == "1") {
		t.Fatal("URL de nexo_test ausente com PG_REQUIRED=1; composição PostgreSQL não executada")
	}
	// Existing helpers enforce nexo_test/nexo_go, RLS and fixture-only cleanup.
	opened, scope := cgGateDatabase(t)
	row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "maintenance", purpose: "general", allow: true, active: true})
	ctx := context.Background()
	calls := 0
	trip := r07RedirectTrip(func(req *http.Request) (*http.Response, error) {
		calls++
		if calls != 1 || req.URL.Scheme != "https" || req.URL.Host != "graph.facebook.com" || req.Header.Get("Authorization") != "Bearer "+cgGateTokenPlain {
			t.Fatal("redirect seguido, bearer transferido ou destino original incorreto")
		}
		cgGateExpectStatus(t, opened, scope, row.logID, "sending")
		if cgGateAttemptStates(t, opened, scope, row.logID) != "1:wire" {
			t.Fatal("cliente chamado antes do commit wire")
		}
		resp := cgGateResponse(302, cgGateTokenPlain+row.phone)
		resp.Header.Set("Location", "https://invalid.test/"+cgGateTokenPlain)
		return resp, nil // Pure local transport: no HTTP server, dial or DNS.
	})
	claim := &cgGateTrip{ids: []int64{row.logID}}
	runtime := cgGateRuntime(claim, cgGateReady(trip, nil))
	for pass := 0; pass < 2; pass++ {
		out := map[string]any{"sent": 0, "failed": 0, "skipped": 0}
		if err := deliverQueuedNotices(ctx, opened, scope, scope.TenantID, runtime, out); err != nil {
			t.Fatal(cgGateRedact(err))
		}
		wantFailed := 1 - pass
		if out["failed"] != wantFailed || out["sent"] != 0 || out["skipped"] != 0 || calls != 1 {
			t.Fatalf("contadores=%v viagens=%d passagem=%d", out, calls, pass)
		}
	}
	cgGateExpectStatus(t, opened, scope, row.logID, "failed")
	if cgGateAttemptStates(t, opened, scope, row.logID) != "1:refused" || cgGateAttempts(t, opened, scope, row.logID) != 1 {
		t.Fatal("attempt wire preso ou novo attempt criado")
	}
	if cgGateError(t, opened, scope, row.logID) != "recusado" {
		t.Fatal("diagnóstico do log não sanitizado")
	}
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		// Repeating finalization must keep the same terminal attempt.
		if err := cloudjournal.RecordResult(ctx, tx, scope.TenantID, row.logID, 302, "", false, true, cgGateTokenPlain); err != nil {
			return err
		}
		var state, excerpt string
		var status int
		var noProvider, noMessage bool
		if err := tx.QueryRow(ctx, `select a.state, a.http_status, a.provider_message_id is null, a.excerpt, l.message is null
			from cloud_notice_attempts a join notice_log l on l.id = a.notice_log_id and l.tenant_id = a.tenant_id
			where a.notice_log_id = $1 and a.tenant_id = app_tenant()`, row.logID).Scan(&state, &status, &noProvider, &excerpt, &noMessage); err != nil {
			return err
		}
		if state != "refused" || status != 302 || !noProvider || excerpt != "refused" || !noMessage {
			t.Fatal("persistência terminal ou sanitização incorreta")
		}
		return nil
	})
	if _, err := deliverCloudNotice(ctx, opened, scope, scope.TenantID, cgGateCloudJob(row), runtime.gate); err == nil || calls != 1 {
		t.Fatal("replay do aviso terminal deveria impedir novo envio")
	}
}
