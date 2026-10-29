package outbound

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/outbound/cloudapi"
	"nexoisp/api-go/internal/radius"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
)

const cgGateSkip = "NEXO_GO_TEST_DATABASE_URL ausente; skip offline. Este skip não executa o gate no PostgreSQL e não aprova o banco."

// cgGateVersion é rótulo de fixture. Não entra em provenGraphVersions e não é versão homologada.
const cgGateVersion = "v0.0"

const cgGateTokenPlain = "cg-fixture-token"

const cgGateClaimSQL = `
update notice_log l set status = 'sending', claimed_at = now()
where l.id = (
  select id from notice_log
  where tenant_id = $1::uuid and status = 'queued' and id = any($2::bigint[])
  order by id
  limit 1
  for update skip locked
)
returning l.id, l.contact_value, l.message,
  (select row_to_json(ch) from notice_channels ch where ch.id = l.channel_id and ch.active) as channel`

func TestCloudNoticeGate_B15_C17(t *testing.T) {
	t.Run("offline", func(t *testing.T) { cgGateAssertOffline(t) })
	t.Run("postgres", func(t *testing.T) {
		opened, scope := cgGateDatabase(t)
		t.Run("flag ou versão vazia fecha antes do fio", func(t *testing.T) {
			cgGateRefuseBeforeWire(t, opened, scope)
		})
		t.Run("cobrança enviada uma vez sem pagamento", func(t *testing.T) {
			cgGateBillingSent(t, opened, scope)
		})
		t.Run("cobrança quitada não chama o transporte", func(t *testing.T) {
			cgGateBillingSettled(t, opened, scope)
		})
		t.Run("manutenção com e sem consentimento", func(t *testing.T) {
			cgGateMaintenance(t, opened, scope)
		})
		t.Run("incerto não é reenviado", func(t *testing.T) {
			cgGateUncertain(t, opened, scope)
		})
		t.Run("varredura fecha reserved sem HTTP", func(t *testing.T) {
			cgGateSweepReserved(t, opened, scope)
		})
	})
}

func TestCloudNoticeGate_B15_C19(t *testing.T) {
	opened, scope := cgGateDatabase(t)
	trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "ok"}
	generic := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "generic", message: "cg corpo generico", url: "https://invalid.test/graph.facebook.com/cg-generic"})
	cloud := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, message: "cg corpo cloud"})
	trip.ids = []int64{generic.logID, cloud.logID}
	trip.contact = cloud.phone
	out := cgGateRun(t, opened, scope, trip, cgGateReady(trip, nil))
	if trip.genericN != 1 || !trip.sawGenericURL {
		t.Fatalf("canal genérico não seguiu Message injetado: chamadas=%d url=%v", trip.genericN, trip.sawGenericURL)
	}
	if trip.roundN != 1 {
		t.Fatalf("cloud_api chamou o transporte %d vezes", trip.roundN)
	}
	if out["sent"] != 2 || out["failed"] != 0 || out["skipped"] != 0 {
		t.Fatalf("contadores sent=%v failed=%v skipped=%v", out["sent"], out["failed"], out["skipped"])
	}
	cgGateExpectStatus(t, opened, scope, generic.logID, "sent")
	cgGateExpectStatus(t, opened, scope, cloud.logID, "sent")
	if cgGateAttempts(t, opened, scope, generic.logID) != 0 {
		t.Fatal("genérico gravou attempt cloud")
	}
	if cgGateAttemptStates(t, opened, scope, cloud.logID) != "1:submitted" {
		t.Fatalf("attempt cloud %s", cgGateAttemptStates(t, opened, scope, cloud.logID))
	}
	cgGateExpectMoney(t, opened, scope, cloud.invoice, 0, 0)

	unknown := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "generic", message: "nao enviar", url: "https://invalid.test/graph.facebook.com/unknown"})
	cgGateMarkSending(t, opened, scope, unknown.logID)
	beforeG, beforeR := trip.genericN, trip.roundN
	job := jsonx.Object{}
	job.Set("id", float64(unknown.logID))
	job.Set("contact_value", unknown.phone)
	job.Set("message", "nao enviar")
	channel := jsonx.Object{}
	channel.Set("adapter", "smtp")
	channel.Set("url", "https://invalid.test/graph.facebook.com/unknown")
	channel.Set("phone_field", "to")
	channel.Set("message_field", "message")
	job.Set("channel", channel)
	closed := map[string]any{"sent": 0, "failed": 0, "skipped": 0}
	if err := dispatchClaimedNotice(context.Background(), opened, scope, scope.TenantID, job, noticeRuntime{gate: cgGateReady(trip, nil), send: trip.generic}, closed); err != nil {
		t.Fatal(cgGateRedact(err))
	}
	if trip.genericN != beforeG || trip.roundN != beforeR || closed["failed"] != 1 || closed["sent"] != 0 {
		t.Fatalf("adapter desconhecido não falhou fechado: generic=%d round=%d out=%v", trip.genericN, trip.roundN, closed)
	}
	cgGateExpectStatus(t, opened, scope, unknown.logID, "failed")
	if strings.Contains(cgGateError(t, opened, scope, unknown.logID), cgGateTokenPlain) {
		t.Fatal("erro do adapter guarda segredo")
	}
}

func TestCloudNoticeGate_B15_C24(t *testing.T) {
	if os.Getenv("NEXO_CLOUD_API") == "on" {
		t.Fatal("C24 exige NEXO_CLOUD_API ausente; o teste não altera o ambiente")
	}
	migration := cgGateRead(filepath.Join("..", "..", "..", "..", "db", "migrations", "00079_cloud_notice_journal.sql"))
	up := migration
	if i := strings.Index(migration, "-- +goose Down"); i > 0 {
		up = migration[:i]
	}
	if strings.Contains(strings.ToLower(up), "insert into cloud_accounts") {
		t.Fatal("migração 79 insere cloud_accounts")
	}
	if !strings.Contains(up, "active boolean not null default false") {
		t.Fatal("active não nasce falso")
	}
	t.Run("postgres", func(t *testing.T) {
		cgGateAccountAbsent(t)
	})
}

func cgGateAccountAbsent(t *testing.T) {
	t.Helper()
	opened, scope := cgGateDatabase(t)
	var defaults string
	var residue, ours int
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(context.Background(), `select column_default from information_schema.columns where table_schema = 'public' and table_name = 'cloud_accounts' and column_name = 'active'`).Scan(&defaults); err != nil {
			return err
		}
		if err := tx.QueryRow(context.Background(), `select count(*) from cloud_accounts where name not like 'cjJournal %' and name not like 'cjStatus %' and name not like 'cgGate %' and name not like 'Synthetic%'`).Scan(&residue); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(), `select count(*) from cloud_accounts where name like 'cgGate %'`).Scan(&ours)
	})
	if !strings.Contains(defaults, "false") {
		t.Fatalf("default de active é %q", defaults)
	}
	if residue != 0 {
		t.Fatalf("há %d cloud_accounts fora dos prefixos de fixture; a migração não pode inserir conta", residue)
	}
	beforeOurs := ours
	row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "generic", message: "cg sem conta", url: "https://invalid.test/cg-c24"})
	cgGateMarkSending(t, opened, scope, row.logID)
	trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "boom"}
	gate := productionCloudGate()
	if gate.enabled || len(gate.allow) != 0 || gate.transport != nil {
		t.Fatal("produção não está desligada com allowlist vazia")
	}
	gate.transport = trip
	job := jsonx.Object{}
	job.Set("id", float64(row.logID))
	job.Set("contact_value", row.phone)
	job.Set("message", "cg sem conta")
	channel := jsonx.Object{}
	channel.Set("adapter", "cloud_api")
	channel.Set("cloud_account_id", uuid.NewString())
	channel.Set("active", true)
	job.Set("channel", channel)
	counter, err := deliverCloudNotice(context.Background(), opened, scope, scope.TenantID, job, gate)
	if err != nil {
		t.Fatal(cgGateRedact(err))
	}
	if counter != "failed" || trip.roundN != 0 {
		t.Fatalf("gate com flag ausente devolveu %s e %d viagens", counter, trip.roundN)
	}
	cgGateExpectStatus(t, opened, scope, row.logID, "failed")
	if cgGateAttempts(t, opened, scope, row.logID) != 0 {
		t.Fatal("recusa anterior ao fio gravou attempt")
	}
	text := cgGateError(t, opened, scope, row.logID)
	if strings.Contains(text, "sent") || strings.Contains(text, cgGateTokenPlain) {
		t.Fatal("recusa simulou envio ou guardou segredo")
	}
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from cloud_accounts where name like 'cgGate %'`).Scan(&ours)
	})
	if ours != beforeOurs {
		t.Fatalf("C24 criou conta: %d -> %d", beforeOurs, ours)
	}
}

func TestCloudNoticeGate_B15_C27(t *testing.T) {
	noticeSQL := cgGateRead(filepath.Join("sql", "69b06ce3_3.sql"))
	purgeSQL := cgGateRead(filepath.Join("..", "radius", "sql", "b2808f33_1.sql"))
	routines := cgGateRead("rotinas.json")
	executor := cgGateRead(filepath.Join("..", "radius", "executor.go"))
	if !strings.Contains(noticeSQL, "skipped_settled") || !strings.Contains(noticeSQL, "skipped_no_consent") {
		t.Fatal("69b06ce3_3.sql não exclui skipped_settled")
	}
	for _, status := range []string{"'sent'", "'failed'", "'skipped_no_consent'", "'skipped_settled'", "'uncertain'", "'test'"} {
		if !strings.Contains(purgeSQL, status) {
			t.Fatalf("b2808f33_1.sql não lista %s", status)
		}
	}
	if strings.Contains(purgeSQL, "'queued'") || strings.Contains(purgeSQL, "'sending'") || !strings.Contains(purgeSQL, "limit $3") {
		t.Fatal("retenção alterou fila, envio em curso ou o limite")
	}
	if !strings.Contains(executor, `query("purgeRadius", 1), tenant, notice, 5000`) {
		t.Fatal("Purge não usa o limite 5000")
	}
	if !strings.Contains(routines, `"sha256": "bd54b3b760d85a10d95c3583625e7ae75aa06f610d89e0338b884f52a9f5e419"`) {
		t.Fatal("sha256 de rotinas.json mudou")
	}
	if !strings.Contains(RoutineSQL("runNotices", 3), "skipped_settled") {
		t.Fatal("embed de 69b06ce3_3.sql não contém skipped_settled")
	}

	t.Run("postgres", func(t *testing.T) {
		cgGatePurge(t)
	})
}

func cgGatePurge(t *testing.T) {
	t.Helper()
	opened, scope := cgGateDatabase(t)
	days := cgGateNoticeDays(t, opened, scope)
	expired := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, status: "skipped_settled"})
	recent := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, status: "skipped_settled"})
	queued := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, status: "queued"})
	sending := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, status: "sending"})
	var attempt string
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		ctx := context.Background()
		if err := tx.Exec(ctx, `update notice_log set created_at = now() - make_interval(days => $2::int) where id = $1 and tenant_id = app_tenant()`, expired.logID, days+2); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `update notice_log set created_at = now() - make_interval(days => $2::int) where id = $1 and tenant_id = app_tenant()`, queued.logID, days+2); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `update notice_log set created_at = now() - make_interval(days => $2::int), claimed_at = now() where id = $1 and tenant_id = app_tenant()`, sending.logID, days+2); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `insert into cloud_notice_attempts (tenant_id, cloud_account_id, notice_log_id, attempt_no, state)
			values (app_tenant(), $1::uuid, $2, 1, 'not_sent') returning id::text`, expired.account, expired.logID).Scan(&attempt)
	})
	if err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return radius.Purge(context.Background(), tx, scope.TenantID)
	}); err != nil {
		t.Fatal(cgGateRedact(err))
	}
	if cgGateLogExists(t, opened, scope, expired.logID) {
		t.Fatal("skipped_settled vencido permaneceu")
	}
	if !cgGateLogExists(t, opened, scope, recent.logID) || !cgGateLogExists(t, opened, scope, queued.logID) || !cgGateLogExists(t, opened, scope, sending.logID) {
		t.Fatal("purge apagou linha dentro do prazo, queued ou sending")
	}
	cgGateExpectStatus(t, opened, scope, recent.logID, "skipped_settled")
	cgGateExpectStatus(t, opened, scope, queued.logID, "queued")
	cgGateExpectStatus(t, opened, scope, sending.logID, "sending")
	var left int
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(context.Background(), `select count(*) from cloud_notice_attempts where id = $1::uuid`, attempt).Scan(&left); err != nil {
			return err
		}
		var invoices int
		if err := tx.QueryRow(context.Background(), `select count(*) from invoices where id = $1::uuid and tenant_id = app_tenant()`, expired.invoice).Scan(&invoices); err != nil {
			return err
		}
		if invoices != 1 {
			return errors.New("purge apagou fatura")
		}
		return nil
	})
	if left != 0 {
		t.Fatalf("FK de attempt não acompanhou a retenção: %d", left)
	}
}

func cgGateAssertOffline(t *testing.T) {
	t.Helper()
	if got := provenGraphVersions(); len(got) != 0 {
		t.Fatalf("provenGraphVersions de produção tem %d itens", len(got))
	}
	gate := productionCloudGate()
	if len(gate.allow) != 0 || gate.transport != nil || gate.factory == nil {
		t.Fatal("gate de produção não está default-off")
	}
	request, err := productionCloudRequest(cloudLoaded{graphVersion: cgGateVersion, phoneNumberID: "1", bearer: "x"}, "5500000000000", "local")
	if err != nil {
		t.Fatal(err)
	}
	if request.BodyParams != nil || request.TemplateName != "" || request.TemplateLang != "" {
		t.Fatal("factory de produção inventou template ou parâmetros")
	}
	if !cloudRequestBlocked(request) {
		t.Fatal("template vazio deveria recusar antes do HTTP")
	}
	request.TemplateName = "cg_fixture"
	request.TemplateLang = "pt_BR"
	request.To = "5500000000000"
	request.Bearer = "x"
	request.BodyParams = []string{"1"}
	if !cloudRequestBlocked(request) {
		t.Fatal("BodyParams não vazio deveria recusar fechado")
	}
	source := cgGateRead("notices_cloud.go")
	if strings.Contains(source, "NEXO_GRAPH") || strings.Contains(source, "GRAPH_VERSION") || strings.Contains(source, "baseURL") || strings.Contains(source, "BaseURL") {
		t.Fatal("gate lê versão ou URL de ambiente")
	}
	if strings.Count(source, "os.Getenv") != 1 || !strings.Contains(source, `os.Getenv("NEXO_CLOUD_API") == "on"`) {
		t.Fatal("gate lê ambiente além da flag on")
	}
}

func cgGateRefuseBeforeWire(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	cases := []struct {
		name string
		gate cloudGate
	}{
		{name: "desligada", gate: cloudGate{enabled: false, allow: []string{cgGateVersion}, factory: cgGateFactory}},
		{name: "versão vazia", gate: cloudGate{enabled: true, allow: provenGraphVersions(), factory: cgGateFactory}},
		{name: "conta inativa", gate: cgGateReady(nil, nil)},
		{name: "parâmetros", gate: cgGateReady(nil, cgGateBlockedFactory)},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			active := item.name != "conta inativa"
			row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: active, message: "cg recusa"})
			trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "boom", ids: []int64{row.logID}}
			item.gate.transport = trip
			out := cgGateRun(t, opened, scope, trip, item.gate)
			if trip.roundN != 0 || trip.genericN != 0 {
				t.Fatalf("%s chamou transporte ou genérico", item.name)
			}
			if out["failed"] != 1 || out["sent"] != 0 || out["skipped"] != 0 {
				t.Fatalf("%s contadores %v", item.name, out)
			}
			cgGateExpectStatus(t, opened, scope, row.logID, "failed")
			if cgGateAttempts(t, opened, scope, row.logID) != 0 {
				t.Fatalf("%s gravou attempt", item.name)
			}
			if strings.Contains(cgGateError(t, opened, scope, row.logID), cgGateTokenPlain) {
				t.Fatal("erro guarda o token")
			}
		})
	}
}

func cgGateBillingSent(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, message: "cg cobrança"})
	trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "ok", ids: []int64{row.logID}, contact: row.phone}
	out := cgGateRun(t, opened, scope, trip, cgGateReady(trip, nil))
	if trip.roundN != 1 || trip.genericN != 0 || !trip.sawWire {
		t.Fatalf("envio round=%d generic=%d wire=%v", trip.roundN, trip.genericN, trip.sawWire)
	}
	if out["sent"] != 1 || out["failed"] != 0 || out["skipped"] != 0 {
		t.Fatalf("contadores %v", out)
	}
	cgGateExpectStatus(t, opened, scope, row.logID, "sent")
	if cgGateAttemptStates(t, opened, scope, row.logID) != "1:submitted" {
		t.Fatalf("attempt %s", cgGateAttemptStates(t, opened, scope, row.logID))
	}
	cgGateExpectMoney(t, opened, scope, row.invoice, 0, 0)
	_, err := deliverCloudNotice(context.Background(), opened, scope, scope.TenantID, cgGateCloudJob(row), cgGateReady(trip, nil))
	if err == nil || !strings.Contains(err.Error(), "reenvio") {
		t.Fatal("segunda chamada não recusou o sent")
	}
	if trip.roundN != 1 {
		t.Fatal("dedupe chamou o transporte de novo")
	}
}

func cgGateBillingSettled(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, message: "cg quitada"})
	cgGatePay(t, opened, scope, row.invoice, row.amount)
	before, sum := cgGateMoney(t, opened, scope, row.invoice)
	trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "boom", ids: []int64{row.logID}}
	out := cgGateRun(t, opened, scope, trip, cgGateReady(trip, nil))
	if trip.roundN != 0 || out["skipped"] != 1 || out["sent"] != 0 {
		t.Fatalf("quitação round=%d out=%v", trip.roundN, out)
	}
	cgGateExpectStatus(t, opened, scope, row.logID, "skipped_settled")
	if cgGateAttemptStates(t, opened, scope, row.logID) != "1:not_sent" {
		t.Fatalf("attempt %s", cgGateAttemptStates(t, opened, scope, row.logID))
	}
	after, sumAfter := cgGateMoney(t, opened, scope, row.invoice)
	if after != before || sumAfter != sum {
		t.Fatalf("pagamento mudou %d/%d -> %d/%d", before, sum, after, sumAfter)
	}
}

func cgGateMaintenance(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	technical := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "maintenance", purpose: "technical", allow: true, active: true, message: "cg manutencao"})
	billingPurpose := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "maintenance", purpose: "billing", allow: true, active: true, message: "cg manutencao"})
	optOut := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "maintenance", purpose: "technical", allow: false, active: true, message: "cg manutencao"})
	trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "ok", ids: []int64{technical.logID, billingPurpose.logID, optOut.logID}}
	out := cgGateRun(t, opened, scope, trip, cgGateReady(trip, nil))
	if trip.roundN != 2 || trip.genericN != 0 || out["sent"] != 2 || out["skipped"] != 1 || out["failed"] != 0 {
		t.Fatalf("manutenção round=%d out=%v", trip.roundN, out)
	}
	cgGateExpectStatus(t, opened, scope, technical.logID, "sent")
	cgGateExpectStatus(t, opened, scope, billingPurpose.logID, "sent")
	cgGateExpectStatus(t, opened, scope, optOut.logID, "skipped_no_consent")
	if cgGateAttemptStates(t, opened, scope, optOut.logID) != "1:not_sent" {
		t.Fatalf("opt-out %s", cgGateAttemptStates(t, opened, scope, optOut.logID))
	}

	heldRow := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "maintenance", purpose: "technical", allow: true, active: true, message: "cg manutencao lock", withInvoice: true})
	release, held := cgGateHoldInvoice(t, opened, scope, heldRow.invoice)
	defer release()
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("não segurou a fatura da manutenção")
	}
	lockTrip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "ok", ids: []int64{heldRow.logID}, contact: heldRow.phone}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out = map[string]any{"sent": 0, "failed": 0, "skipped": 0}
	runtime := cgGateRuntime(lockTrip, cgGateReady(lockTrip, nil))
	if err := deliverQueuedNotices(ctx, opened, scope, scope.TenantID, runtime, out); err != nil {
		t.Fatal(cgGateRedact(err))
	}
	if lockTrip.roundN != 1 || out["sent"] != 1 {
		t.Fatalf("manutenção esperou fatura alheia round=%d out=%v", lockTrip.roundN, out)
	}
	cgGateExpectStatus(t, opened, scope, heldRow.logID, "sent")
}

func cgGateUncertain(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, message: "cg incerto"})
	trip := &cgGateTrip{t: t, opened: opened, scope: scope, mode: "uncertain", ids: []int64{row.logID}, contact: row.phone}
	out := cgGateRun(t, opened, scope, trip, cgGateReady(trip, nil))
	if trip.roundN != 1 || out["sent"] != 0 || out["failed"] != 1 {
		t.Fatalf("incerto round=%d out=%v", trip.roundN, out)
	}
	cgGateExpectStatus(t, opened, scope, row.logID, "uncertain")
	if cgGateAttemptStates(t, opened, scope, row.logID) != "1:uncertain" {
		t.Fatalf("attempt %s", cgGateAttemptStates(t, opened, scope, row.logID))
	}
	cgGateExpectMoney(t, opened, scope, row.invoice, 0, 0)
	again := cgGateRun(t, opened, scope, trip, cgGateReady(trip, nil))
	if trip.roundN != 1 || again["sent"] != 0 || again["failed"] != 0 || again["skipped"] != 0 {
		t.Fatalf("reenvio incerto round=%d out=%v", trip.roundN, again)
	}
	_, err := deliverCloudNotice(context.Background(), opened, scope, scope.TenantID, cgGateCloudJob(row), cgGateReady(trip, nil))
	if err == nil || !strings.Contains(err.Error(), "reenvio") {
		t.Fatal("releitura de uncertain não recusou")
	}
	if trip.roundN != 1 {
		t.Fatal("releitura chamou o transporte")
	}
}

func cgGateSweepReserved(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	row := cgGateSeed(t, opened, scope, cgGateSeedOpt{kind: "billing", purpose: "billing", allow: true, active: true, status: "sending", message: "cg sweep"})
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		ctx := context.Background()
		if err := tx.Exec(ctx, `update notice_log set claimed_at = now() - interval '20 minutes' where id = $1 and tenant_id = app_tenant()`, row.logID); err != nil {
			return err
		}
		return tx.Exec(ctx, `insert into cloud_notice_attempts (tenant_id, cloud_account_id, notice_log_id, attempt_no, state)
			values (app_tenant(), $1::uuid, $2, 1, 'reserved')`, row.account, row.logID)
	})
	trip := &cgGateTrip{t: t, mode: "boom"}
	if err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return sweepNotices(context.Background(), tx, scope.TenantID)
	}); err != nil {
		t.Fatal(cgGateRedact(err))
	}
	if trip.roundN != 0 {
		t.Fatal("varredura chamou HTTP")
	}
	cgGateExpectStatus(t, opened, scope, row.logID, "uncertain")
	if cgGateAttemptStates(t, opened, scope, row.logID) != "1:not_sent" {
		t.Fatalf("reserved depois da varredura %s", cgGateAttemptStates(t, opened, scope, row.logID))
	}
}

type cgGateSeedOpt struct {
	kind        string
	purpose     string
	allow       bool
	active      bool
	status      string
	message     string
	url         string
	withInvoice bool
}

type cgGateRow struct {
	subscriber  string
	contactID   string
	phone       string
	invoice     string
	account     string
	channel     string
	maintenance string
	logID       int64
	amount      int
}

type cgGateTrip struct {
	t             *testing.T
	opened        *db.DB
	scope         tenancy.Scope
	mode          string
	ids           []int64
	contact       string
	mu            sync.Mutex
	genericN      int
	roundN        int
	sawGenericURL bool
	sawWire       bool
}

func (c *cgGateTrip) generic(_ context.Context, channel jsonx.Object, _, _ string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.genericN++
	url, _ := channel.Get("url").(string)
	if strings.Contains(url, "graph.facebook.com") && strings.Contains(url, "invalid.test") {
		c.sawGenericURL = true
	}
	if channel.Get("adapter") == "cloud_api" {
		c.t.Errorf("genérico recebeu adapter cloud_api")
	}
	return nil
}

func (c *cgGateTrip) RoundTrip(req *http.Request) (*http.Response, error) {
	c.mu.Lock()
	c.roundN++
	mode := c.mode
	ids := append([]int64(nil), c.ids...)
	contact := c.contact
	opened, scope := c.opened, c.scope
	c.mu.Unlock()
	if mode == "boom" {
		c.t.Errorf("RoundTrip chamado com o gate fechado")
		return cgGateResponse(500, `{"error":"boom"}`), nil
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		c.t.Errorf("leitura do corpo")
		return cgGateResponse(500, `{}`), nil
	}
	if strings.Contains(string(body), cgGateTokenPlain) {
		c.t.Errorf("corpo contém o token")
	}
	if !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer ") || !strings.Contains(req.Header.Get("Authorization"), cgGateTokenPlain) {
		c.t.Errorf("bearer de fixture ausente no header")
	}
	for name := range req.Header {
		if strings.Contains(strings.ToLower(name), "idempoten") {
			c.t.Errorf("cabeçalho de idempotência")
		}
	}
	if req.URL == nil || req.URL.Hostname() != "graph.facebook.com" || strings.Contains(req.URL.String(), "invalid.test") {
		c.t.Errorf("URL do cliente não é o endpoint fixo")
	}
	if bytesContainsToken(body) || strings.Contains(string(body), "biz_opaque_callback_data") || strings.Contains(string(body), scope.TenantID) {
		c.t.Errorf("corpo contém segredo, tenant ou campo não verificado")
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil || payload["messaging_product"] != "whatsapp" || payload["type"] != "template" || len(payload) != 4 {
		c.t.Errorf("corpo mínimo divergente")
	} else if contact != "" && payload["to"] != contact {
		c.t.Errorf("destinatário divergente do contact_value")
	}
	template, _ := payload["template"].(map[string]any)
	if template["name"] != "cg_fixture" {
		c.t.Errorf("template de fixture ausente")
	}
	if _, ok := template["components"]; ok {
		c.t.Errorf("template ganhou components")
	}
	if opened != nil && len(ids) > 0 {
		var wires int
		err = opened.WithScope(req.Context(), scope, func(tx *db.Tx) error {
			return tx.QueryRow(req.Context(), `select count(*) from cloud_notice_attempts where tenant_id = app_tenant() and notice_log_id = any($1::bigint[]) and state = 'wire' and wire_at is not null`, ids).Scan(&wires)
		})
		if err != nil || wires != 1 {
			c.t.Errorf("HTTP antes do commit de MarkWire")
			return cgGateResponse(500, `{}`), nil
		}
		c.mu.Lock()
		c.sawWire = true
		c.mu.Unlock()
	}
	if mode == "uncertain" {
		return cgGateResponse(500, `{"error":"later"}`), nil
	}
	raw := `{"messages":[{"id":"wamid.cg"}]}`
	return cgGateResponse(200, raw), nil
}

func cgGateResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Status:        http.StatusText(status),
		Body:          io.NopCloser(strings.NewReader(body)),
		Header:        make(http.Header),
		ContentLength: int64(len(body)),
	}
}

func bytesContainsToken(body []byte) bool {
	return strings.Contains(string(body), cgGateTokenPlain)
}

func cgGateReady(trip http.RoundTripper, factory cloudRequestFactory) cloudGate {
	if factory == nil {
		factory = cgGateFactory
	}
	return cloudGate{enabled: true, allow: []string{cgGateVersion}, transport: trip, factory: factory}
}

func cgGateFactory(account cloudLoaded, contact, attemptKey string) (cloudapi.Request, error) {
	return cloudapi.Request{
		Version:       account.graphVersion,
		PhoneNumberID: account.phoneNumberID,
		To:            contact,
		TemplateName:  "cg_fixture",
		TemplateLang:  "pt_BR",
		BodyParams:    nil,
		Bearer:        account.bearer,
		AttemptKey:    attemptKey,
	}, nil
}

func cgGateBlockedFactory(account cloudLoaded, contact, attemptKey string) (cloudapi.Request, error) {
	request, err := cgGateFactory(account, contact, attemptKey)
	if err != nil {
		return request, err
	}
	request.BodyParams = []string{"nao-verificado"}
	return request, nil
}

func cgGateRuntime(trip *cgGateTrip, gate cloudGate) noticeRuntime {
	return noticeRuntime{
		gate: gate,
		send: trip.generic,
		claim: func(ctx context.Context, tx *db.Tx, tenant string) (jsonx.Object, error) {
			rs, err := tx.Objects(ctx, cgGateClaimSQL, tenant, trip.ids)
			if err != nil || len(rs) == 0 {
				return nil, err
			}
			return rs[0], nil
		},
	}
}

func cgGateRun(t *testing.T, opened *db.DB, scope tenancy.Scope, trip *cgGateTrip, gate cloudGate) map[string]any {
	t.Helper()
	out := map[string]any{"sent": 0, "failed": 0, "skipped": 0}
	if err := deliverQueuedNotices(context.Background(), opened, scope, scope.TenantID, cgGateRuntime(trip, gate), out); err != nil {
		t.Fatal(cgGateRedact(err))
	}
	return out
}

func cgGateCloudJob(row cgGateRow) jsonx.Object {
	channel := jsonx.Object{}
	channel.Set("adapter", "cloud_api")
	channel.Set("cloud_account_id", row.account)
	channel.Set("active", true)
	job := jsonx.Object{}
	job.Set("id", float64(row.logID))
	job.Set("contact_value", row.phone)
	job.Set("message", "cg")
	job.Set("channel", channel)
	return job
}

func cgGateDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_CLOUD_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_CLOUD_PG_REQUIRED=1; o gate não executou e PostgreSQL não está aprovado")
		}
		t.Skip(cgGateSkip)
		return nil, tenancy.Scope{}
	}
	if err := cgGateRejectLabURL(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	opened, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("db.Open falhou com URL presente; skip não se aplica: %s", cgGateRedact(err))
	}
	t.Cleanup(opened.Close)
	var name, sessionUser, currentUser, tenant string
	if err = opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatalf("identidade do laboratório: %s", cgGateRedact(err))
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" || tenant == "" {
		t.Fatalf("conexão fora de nexo_test/nexo_go: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	return opened, tenancy.Scope{TenantID: tenant}
}

func cgGateSeed(t *testing.T, opened *db.DB, scope tenancy.Scope, opt cgGateSeedOpt) cgGateRow {
	t.Helper()
	if opt.status == "" {
		opt.status = "queued"
	}
	if opt.message == "" {
		opt.message = "cgGate"
	}
	if opt.url == "" {
		opt.url = "https://invalid.test/cg-cloud"
	}
	if opt.purpose == "" {
		opt.purpose = "general"
	}
	row := cgGateRow{amount: 1500, phone: "55" + cgGateDigits(11)}
	token, err := cryptox.EncryptSecret(cgGateTokenPlain)
	if err != nil {
		t.Fatal(cgGateRedact(err))
	}
	if !strings.HasPrefix(token, "v1.") || strings.Contains(token, cgGateTokenPlain) {
		t.Fatal("segredo de fixture não está no formato v1")
	}
	err = opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		ctx := context.Background()
		if opt.kind == "billing" || opt.withInvoice {
			var base string
			if err := tx.QueryRow(ctx, `select id::text from contracts where tenant_id = app_tenant() and status = 'active' order by id limit 1`).Scan(&base); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status)
				select tenant_id, $2, 'active' from contracts where id = $1::uuid returning id::text`, base, cgGateName()).Scan(&row.subscriber); err != nil {
				return err
			}
			row.invoice = uuid.NewString()
			if err := tx.Exec(ctx, `insert into invoices (id, tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
				select $3::uuid, tenant_id, id, $2::uuid, 'manual', current_date, $4 from contracts where id = $1::uuid`, base, row.subscriber, row.invoice, row.amount); err != nil {
				return err
			}
		} else if opt.kind != "generic" {
			if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status) values (app_tenant(), $1, 'active') returning id::text`, cgGateName()).Scan(&row.subscriber); err != nil {
				return err
			}
		}
		if opt.kind == "billing" || opt.kind == "maintenance" {
			if err := tx.QueryRow(ctx, `insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, purpose, allow_notices)
				values (app_tenant(), $1::uuid, 'mobile', $2, $3, $4) returning id::text`, row.subscriber, row.phone, opt.purpose, opt.allow).Scan(&row.contactID); err != nil {
				return err
			}
		}
		if opt.kind == "maintenance" {
			if err := tx.QueryRow(ctx, `insert into maintenance_notices (tenant_id, title, message, starts_at, ends_at)
				values (app_tenant(), $1, 'janela interna', now(), now() + interval '1 hour') returning id::text`, cgGateName()).Scan(&row.maintenance); err != nil {
				return err
			}
		}
		if opt.kind == "generic" {
			if err := tx.QueryRow(ctx, `insert into notice_channels (tenant_id, name, url, phone_field, message_field)
				values (app_tenant(), $1, $2, 'to', 'message') returning id::text`, cgGateName(), opt.url).Scan(&row.channel); err != nil {
				return err
			}
		} else {
			phoneID := cgGateDigits(15)
			if err := tx.QueryRow(ctx, `insert into cloud_accounts (tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc, active)
				values (app_tenant(), $1, $2, $3, $4, $4, $5) returning id::text`, cgGateName(), phoneID, cgGateVersion, token, opt.active).Scan(&row.account); err != nil {
				return err
			}
			if err := tx.QueryRow(ctx, `insert into notice_channels (tenant_id, name, url, adapter, cloud_account_id)
				values (app_tenant(), $1, $2, 'cloud_api', $3::uuid) returning id::text`, cgGateName(), opt.url, row.account).Scan(&row.channel); err != nil {
				return err
			}
		}
		var invoice, subscriber, maintenance, phase, contact any
		if row.invoice != "" && opt.kind == "billing" {
			invoice = row.invoice
		}
		if row.subscriber != "" && opt.kind != "generic" {
			subscriber = row.subscriber
			contact = row.phone
		}
		if row.maintenance != "" {
			maintenance = row.maintenance
			phase = "start"
		}
		return tx.QueryRow(ctx, `insert into notice_log (tenant_id, invoice_id, subscriber_id, contact_value, channel_id, status, attempts, message, maintenance_notice_id, phase)
			values (app_tenant(), $1::uuid, $2::uuid, $3, $4::uuid, $5, 1, $6, $7::uuid, $8) returning id`,
			invoice, subscriber, contact, row.channel, opt.status, opt.message, maintenance, phase).Scan(&row.logID)
	})
	if err != nil {
		t.Fatal(cgGateRedact(err))
	}
	t.Cleanup(func() { cgGateCleanup(t, opened, scope, row) })
	return row
}

func cgGateCleanup(t *testing.T, opened *db.DB, scope tenancy.Scope, row cgGateRow) {
	t.Helper()
	ctx := context.Background()
	// notice_log sai numa transação própria. Falha posterior não devolve aviso queued à fila do tenant.
	if row.logID != 0 {
		if err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.Exec(ctx, `delete from notice_log where id = $1 and tenant_id = app_tenant()`, row.logID)
		}); err != nil {
			t.Errorf("limpeza cgGate notice_log: %s", cgGateRedact(err))
		}
	}
	if row.channel != "" {
		if err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
			return tx.Exec(ctx, `delete from notice_channels where id = $1::uuid and tenant_id = app_tenant()`, row.channel)
		}); err != nil {
			t.Errorf("limpeza cgGate notice_channels: %s", cgGateRedact(err))
		}
	}
	// nexo_app não tem DELETE em cloud_accounts nem em maintenance_notices.
	// O owner do laboratório apaga só o id desta fixture, depois do commit de notice_log.
	if row.account != "" || row.maintenance != "" {
		if err := cgGateDeleteOwnFixture(ctx, scope.TenantID, row.account, row.maintenance); err != nil {
			t.Errorf("limpeza cgGate cloud_accounts/maintenance_notices: %s", cgGateRedact(err))
		}
	}
	if err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if row.contactID != "" {
			if err := tx.Exec(ctx, `delete from subscriber_contacts where id = $1::uuid and tenant_id = app_tenant()`, row.contactID); err != nil {
				return err
			}
		}
		if row.invoice != "" {
			// payments é histórico imutável: nexo_app só tem SELECT/INSERT e
			// immutable_payments rejeita DELETE para qualquer papel, inclusive o owner.
			// O recibo fica retido na invoice desta fixture. Não há DELETE por tenant.
			// Fatura ainda open sai da fila; fatura já paid permanece com o recibo.
			if err := tx.Exec(ctx, `update invoices set status = 'canceled', canceled_at = now() where id = $1::uuid and tenant_id = app_tenant() and status = 'open'`, row.invoice); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Errorf("limpeza cgGate: %s", cgGateRedact(err))
	}
}

// cgGateDeleteOwnFixture apaga conta e aviso de manutenção criados por esta fixture.
// Recusa URL que não seja nexo_owner em nexo_test no host local e não mexe em notice_log nem em payments.
func cgGateDeleteOwnFixture(ctx context.Context, tenantID, accountID, maintenanceID string) error {
	if _, err := uuid.Parse(tenantID); err != nil {
		return errors.New("tenant da fixture inválido")
	}
	if accountID != "" {
		if _, err := uuid.Parse(accountID); err != nil {
			return errors.New("conta da fixture inválida")
		}
	}
	if maintenanceID != "" {
		if _, err := uuid.Parse(maintenanceID); err != nil {
			return errors.New("manutenção da fixture inválida")
		}
	}
	if accountID == "" && maintenanceID == "" {
		return nil
	}
	raw := os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if strings.TrimSpace(raw) == "" {
		return errors.New("NEXO_GO_TEST_DATABASE_OWNER_URL ausente; cloud_accounts ou maintenance_notices da fixture permanecem e o papel nexo_go não recebe DELETE")
	}
	if raw == os.Getenv("NEXO_GO_TEST_DATABASE_URL") {
		return errors.New("owner recusado; a URL não pode ser a sessão de runtime")
	}
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return errors.New("URL de owner do laboratório inválida")
	}
	if cfg.User != "nexo_owner" || cfg.Database != "nexo_test" || !cgGateLoopback(cfg.Host) {
		return errors.New("owner recusado; limpeza de cloud_accounts e maintenance_notices exige nexo_owner em nexo_test no host local")
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 15 * time.Second
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return cgGateScrub(err, raw, cfg.Password)
	}
	defer conn.Close(ctx)
	var database, sessionUser, currentUser string
	if err = conn.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&database, &sessionUser, &currentUser); err != nil {
		return cgGateScrub(err, raw, cfg.Password)
	}
	if database != "nexo_test" || sessionUser != "nexo_owner" || currentUser != "nexo_owner" {
		return errors.New("destino efetivo recusado; limpeza não usa o papel de runtime")
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return cgGateScrub(err, raw, cfg.Password)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `select set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return cgGateScrub(err, raw, cfg.Password)
	}
	if accountID != "" {
		tag, err := tx.Exec(ctx, `delete from cloud_accounts where id = $1::uuid and tenant_id = $2::uuid and name like 'cgGate %'`, accountID, tenantID)
		if err != nil {
			return cgGateScrub(err, raw, cfg.Password)
		}
		if tag.RowsAffected() != 1 {
			return errors.New("limpeza de cloud_accounts não removeu exatamente a conta desta fixture")
		}
	}
	if maintenanceID != "" {
		tag, err := tx.Exec(ctx, `delete from maintenance_notices where id = $1::uuid and tenant_id = $2::uuid and title like 'cgGate %'`, maintenanceID, tenantID)
		if err != nil {
			return cgGateScrub(err, raw, cfg.Password)
		}
		if tag.RowsAffected() != 1 {
			return errors.New("limpeza de maintenance_notices não removeu exatamente o aviso desta fixture")
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return cgGateScrub(err, raw, cfg.Password)
	}
	return nil
}

func cgGateLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func cgGateScrub(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(msg, secret) {
			return errors.New("conexão de owner do laboratório recusada")
		}
	}
	if strings.Contains(msg, "://") {
		return errors.New("conexão de owner do laboratório recusada")
	}
	return err
}

func cgGatePay(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string, amount int) {
	t.Helper()
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		if err := finance.LockInvoices(context.Background(), tx, scope.TenantID, invoice); err != nil {
			return err
		}
		return tx.Exec(context.Background(), `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source)
			values (app_tenant(), $1::uuid, $2, now(), 'manual', 'manual')`, invoice, amount)
	})
}

func cgGateHoldInvoice(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string) (func(), <-chan struct{}) {
	t.Helper()
	held := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			if err := finance.LockInvoices(context.Background(), tx, scope.TenantID, invoice); err != nil {
				return err
			}
			close(held)
			<-release
			return errors.New("cgGate rollback")
		})
		if err != nil && !strings.Contains(err.Error(), "cgGate rollback") {
			t.Errorf("hold da fatura: %s", cgGateRedact(err))
		}
	}()
	return func() {
		close(release)
		<-done
	}, held
}

func cgGateMarkSending(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) {
	t.Helper()
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		n, err := tx.Affected(context.Background(), `update notice_log set status = 'sending', claimed_at = now() where id = $1 and tenant_id = app_tenant() and status = 'queued'`, id)
		if err != nil {
			return err
		}
		if n != 1 {
			return errors.New("aviso não estava queued")
		}
		return nil
	})
}

func cgGateExpectStatus(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64, status string) {
	t.Helper()
	var got string
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select status from notice_log where id = $1 and tenant_id = app_tenant()`, id).Scan(&got)
	})
	if got != status {
		t.Fatalf("status %s, esperado %s", got, status)
	}
}

func cgGateError(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) string {
	t.Helper()
	var got *string
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select error from notice_log where id = $1 and tenant_id = app_tenant()`, id).Scan(&got)
	})
	if got == nil {
		return ""
	}
	return *got
}

func cgGateAttempts(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) int {
	t.Helper()
	var n int
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from cloud_notice_attempts where notice_log_id = $1 and tenant_id = app_tenant()`, id).Scan(&n)
	})
	return n
}

func cgGateAttemptStates(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) string {
	t.Helper()
	var got string
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select coalesce(string_agg(attempt_no::text || ':' || state, ',' order by attempt_no), '') from cloud_notice_attempts where notice_log_id = $1 and tenant_id = app_tenant()`, id).Scan(&got)
	})
	return got
}

func cgGateMoney(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string) (int, int) {
	t.Helper()
	var n, sum int
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*), coalesce(sum(signed_cents), 0) from payments where invoice_id = $1::uuid and tenant_id = app_tenant()`, invoice).Scan(&n, &sum)
	})
	return n, sum
}

func cgGateExpectMoney(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string, n, sum int) {
	t.Helper()
	gotN, gotSum := cgGateMoney(t, opened, scope, invoice)
	if gotN != n || gotSum != sum {
		t.Fatalf("pagamentos %d/%d, esperado %d/%d", gotN, gotSum, n, sum)
	}
}

func cgGateLogExists(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) bool {
	t.Helper()
	var n int
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from notice_log where id = $1 and tenant_id = app_tenant()`, id).Scan(&n)
	})
	return n == 1
}

func cgGateNoticeDays(t *testing.T, opened *db.DB, scope tenancy.Scope) int {
	t.Helper()
	var days *int
	cgGateInTx(t, opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select retention_notice_log_days from tenant_settings where tenant_id = app_tenant()`).Scan(&days)
	})
	if days != nil {
		return *days
	}
	parsed := int(validate.JSNumber(os.Getenv("NEXO_NOTICE_LOG_DAYS")))
	if parsed == 0 {
		parsed = 400
	}
	if parsed < 30 {
		parsed = 30
	}
	return parsed
}

func cgGateInTx(t *testing.T, opened *db.DB, scope tenancy.Scope, fn func(*db.Tx) error) {
	t.Helper()
	if err := opened.WithScope(context.Background(), scope, fn); err != nil {
		t.Fatal(cgGateRedact(err))
	}
}

func cgGateName() string {
	return "cgGate " + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
}

func cgGateDigits(n int) string {
	raw := strings.ReplaceAll(uuid.NewString(), "-", "") + strings.ReplaceAll(uuid.NewString(), "-", "")
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = '0' + raw[i]%10
	}
	if out[0] == '0' {
		out[0] = '1'
	}
	return string(out)
}

func cgGateRead(name string) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		return ""
	}
	body, err := os.ReadFile(filepath.Join(filepath.Dir(file), name))
	if err != nil {
		return ""
	}
	return string(body)
}

func cgGateRejectLabURL(raw string) error {
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return errors.New("URL de laboratório inválida")
	}
	if cfg.User != "nexo_go" || cfg.Database != "nexo_test" {
		return errors.New("URL recusada; este pacote só usa nexo_go em nexo_test")
	}
	return nil
}

func cgGateRedact(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	for _, key := range []string{"NEXO_GO_TEST_DATABASE_URL", "NEXO_GO_TEST_DATABASE_OWNER_URL"} {
		if url := os.Getenv(key); url != "" {
			text = strings.ReplaceAll(text, url, key)
		}
	}
	text = strings.ReplaceAll(text, cgGateTokenPlain, "[segredo]")
	return text
}
