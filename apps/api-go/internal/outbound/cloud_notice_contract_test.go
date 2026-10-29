package outbound

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nexoisp/api-go/internal/outbound/cloudapi"
	"nexoisp/api-go/internal/outbound/cloudjournal"
)

// TestCloudNoticeContract compõe as travas offline já entregues pelas raízes.
// Não repete os identificadores B15-Cxx e não abre PostgreSQL, rede nem Meta.
func TestCloudNoticeContract(t *testing.T) {
	if len(provenGraphVersions()) != 0 {
		t.Fatal("provenGraphVersions de produção não está vazio")
	}
	gate := productionCloudGate()
	if gate.enabled || gate.transport != nil || len(gate.allow) != 0 {
		t.Fatal("produção não está desligada, com transporte nulo e allowlist vazia")
	}
	if cloudjournal.MaxLockRequeues != 3 {
		t.Fatalf("teto de requeue %d", cloudjournal.MaxLockRequeues)
	}
	if (cloudjournal.UnprovedAuthenticator{}).Proven() {
		t.Fatal("UnprovedAuthenticator aceitou")
	}
	if _, ok := any(cloudjournal.UnprovedAuthenticator{}).(cloudjournal.StatusDecoder); ok {
		t.Fatal("autenticador de produção implementa decoder")
	}
	if cloudjournal.Classify("invoice", "") != cloudjournal.LogKindBilling ||
		cloudjournal.Classify("", "maintenance") != cloudjournal.LogKindMaintenance ||
		cloudjournal.Classify("", "") != cloudjournal.LogKindOther {
		t.Fatal("Classify mudou o vocabulário")
	}

	boom := &contractTrip{t: t}
	off, err := cloudapi.New(cloudapi.Config{Enabled: false, AllowVersions: []string{"v0.0"}, Transport: boom})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = off.Send(context.Background(), cloudapi.Request{}); err == nil || boom.n != 0 {
		t.Fatalf("cliente desligado: err=%v idas=%d", err, boom.n)
	}
	closed, err := cloudapi.New(cloudapi.Config{Enabled: true, Transport: boom})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = closed.Send(context.Background(), cloudapi.Request{Version: "v0.0"}); err == nil || boom.n != 0 {
		t.Fatalf("versão fora da allowlist vazia: err=%v idas=%d", err, boom.n)
	}
	refused, err := cloudapi.New(cloudapi.Config{Enabled: true, AllowVersions: []string{"v0.0"}, Transport: boom})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refused.Send(context.Background(), cloudapi.Request{
		Version: "v0.0", PhoneNumberID: "100", To: "100", TemplateName: "fixture", TemplateLang: "pt_BR",
		BodyParams: []string{"x"}, Bearer: "fixture", AttemptKey: "local",
	})
	if err == nil || boom.n != 0 {
		t.Fatalf("BodyParams não vazio chegou ao transporte: err=%v idas=%d", err, boom.n)
	}

	journal := contractRead(t, "cloudjournal", "journal.go")
	consent := contractRead(t, "cloudjournal", "consent.go")
	status := contractRead(t, "cloudjournal", "status.go")
	migration := contractRead(t, "..", "..", "..", "..", "db", "migrations", "00079_cloud_notice_journal.sql")
	for _, part := range []string{"func MarkWire", "savepoint cloud_journal_lock", "7411005", "cloud_lock_timeouts"} {
		if !strings.Contains(journal, part) {
			t.Fatalf("journal sem %s", part)
		}
	}
	if !strings.Contains(journal, "Depois do commit, o HTTP em voo não é desfeito.") {
		t.Fatal("MarkWire deixou de ser a última barreira")
	}
	if !strings.Contains(consent, "for share") || strings.Contains(strings.ToLower(consentBillingSQLOf(consent)), "for key share") {
		t.Fatal("consentimento não usa FOR SHARE")
	}
	if !strings.Contains(status, "func (UnprovedAuthenticator) Proven() bool { return false }") || !strings.Contains(status, "StatusDecoder") {
		t.Fatal("status de produção não permanece não provado")
	}
	up := migration
	if i := strings.Index(migration, "-- +goose Down"); i > 0 {
		up = migration[:i]
	}
	for _, part := range []string{
		"active boolean not null default false",
		"adapter text not null default 'generic_http'",
		"cloud_lock_timeouts integer not null default 0",
		"cloud_lock_timeouts between 0 and 3",
		"on delete cascade",
		"cloud notice status is append-only",
	} {
		if !strings.Contains(up, part) {
			t.Fatalf("migração 79 sem %s", part)
		}
	}
	if strings.Contains(strings.ToLower(up), "insert into cloud_accounts") {
		t.Fatal("migração 79 insere conta")
	}
}

func consentBillingSQLOf(consent string) string {
	const marker = "const consentBillingSQL = consentFrom + `"
	i := strings.Index(consent, marker)
	if i < 0 {
		return consent
	}
	rest := consent[i+len(marker):]
	j := strings.Index(rest, "`")
	if j < 0 {
		return rest
	}
	return rest[:j]
}

func contractRead(t *testing.T, parts ...string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(append([]string{"."}, parts...)...))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

type contractTrip struct {
	t *testing.T
	n int
}

func (c *contractTrip) RoundTrip(*http.Request) (*http.Response, error) {
	c.n++
	c.t.Fatal("RoundTrip em teste de composição")
	return nil, context.Canceled
}
