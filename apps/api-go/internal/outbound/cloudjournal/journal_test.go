package cloudjournal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/db/labtest"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
)

const cjJournalSkip = "NEXO_GO_TEST_DATABASE_URL ausente; pendente. Este skip não executa o journal, não aprova PostgreSQL e não homologa WABA."

const cjJournalCipher = "v1.cj.journal.not-real"
const cjJournalInvoiceSalt int64 = 7411005

var errCjJournalRollback = errors.New("cjJournal rollback")

func TestCloudJournal_MachineContract(t *testing.T) {
	if MaxLockRequeues != 3 || lockBudget != "2s" || sweepMinutes != 10 {
		t.Fatalf("orçamento timeouts=%d lock=%s sweep=%d", MaxLockRequeues, lockBudget, sweepMinutes)
	}
	if strings.Contains(strings.ToLower(loadNoticeSQL), "for update") || strings.Contains(strings.ToLower(loadNoticeSQL), "invoices") || strings.Contains(strings.ToLower(loadNoticeSQL), "payments") {
		t.Fatal("leitura inicial de notice_log não pode travar fatura nem pagamento")
	}
	if strings.Contains(strings.ToLower(payableSQL), "for update") {
		t.Fatal("saldo não pode levar for update; LockInvoices já travou a linha")
	}
	for _, query := range []string{sweepLogSQL, sweepWireSQL, sweepReservedSQL} {
		if strings.Contains(query, "queued") {
			t.Fatal("varredura do journal não reenfileira")
		}
	}
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("origem indisponível")
	}
	srcB, err := os.ReadFile(filepath.Join(filepath.Dir(file), "journal.go"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(srcB)
	for _, banned := range []string{"cloudapi", "nexoisp/api-go/internal/outbound\"", "hashtextextended", "pg_advisory", "insert into payments", "insert into invoices", "finance.Event", "graph.facebook", "AcceptStatus"} {
		if strings.Contains(src, banned) {
			t.Fatalf("journal.go saiu do recorte: %s", banned)
		}
	}
	if !strings.Contains(src, "finance.LockInvoices") {
		t.Fatal("o lock de fatura tem de ser finance.LockInvoices")
	}
	body := cjJournalFunc(t, src, "lockBilling")
	lockAt := strings.Index(body, "finance.LockInvoices")
	consentAt := strings.Index(body, "consentOf")
	payAt := strings.Index(body, "invoicePayable")
	if lockAt < 0 || consentAt < 0 || payAt < 0 || !(lockAt < consentAt && consentAt < payAt) {
		t.Fatal("ordem no ramo billing: advisory/linha via LockInvoices, consentimento, saldo")
	}
	if strings.Contains(cjJournalFunc(t, src, "revalidateMaintenance"), "LockInvoices") || strings.Contains(cjJournalFunc(t, src, "markMaintenance"), "LockInvoices") {
		t.Fatal("manutenção não trava fatura")
	}
	for _, name := range []string{"Revalidate", "MarkWire", "RecordResult", "SweepReserved"} {
		if !strings.Contains(src, "func "+name+"(") {
			t.Fatalf("função ausente %s", name)
		}
	}
	generic, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "sql", "69b06ce3_1.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(generic), interruptedError) {
		t.Fatal("a frase da varredura genérica divergiu; o journal não deve inventar outra")
	}
}

func TestCloudJournal_ClassifyResult(t *testing.T) {
	cases := []struct {
		name                       string
		status                     int
		id                         string
		uncertain, refused         bool
		wantState, wantLog, wantID string
		wantStatus                 int
		wantErr                    bool
	}{
		{name: "aceito com id", status: 200, id: "wamid-fixture", wantState: "submitted", wantLog: "sent", wantID: "wamid-fixture", wantStatus: 200},
		{name: "2xx sem id", status: 200, wantState: "uncertain", wantLog: "uncertain", wantStatus: 200},
		{name: "429", status: 429, wantState: "refused", wantLog: "failed", wantStatus: 429},
		{name: "4xx", status: 400, wantState: "refused", wantLog: "failed", wantStatus: 400},
		{name: "5xx", status: 503, wantState: "uncertain", wantLog: "uncertain", wantStatus: 503},
		{name: "incerto explicito", status: 0, uncertain: true, wantState: "uncertain", wantLog: "uncertain"},
		{name: "recusa explicita", status: 429, refused: true, wantState: "refused", wantLog: "failed", wantStatus: 429},
		{name: "id com incerto", status: 200, id: "wamid-fixture", uncertain: true, wantErr: true},
		{name: "id com recusa", status: 400, id: "wamid-fixture", refused: true, wantErr: true},
		{name: "flags opostas", status: 500, uncertain: true, refused: true, wantErr: true},
		{name: "recusa em 2xx", status: 200, refused: true, wantErr: true},
		{name: "sem classificacao", status: 0, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, logStatus, id, status, err := classifyResult(tc.status, tc.id, tc.uncertain, tc.refused)
			if tc.wantErr {
				if !errors.Is(err, errResult) {
					t.Fatalf("err=%v", err)
				}
				return
			}
			if err != nil || state != tc.wantState || logStatus != tc.wantLog || id != tc.wantID || status != tc.wantStatus {
				t.Fatalf("got %s %s %q %d %v", state, logStatus, id, status, err)
			}
		})
	}
}

func TestCloudJournal_ExcerptUTF16(t *testing.T) {
	s := strings.Repeat("🙂", 151)
	got := cutUTF16(s, 300)
	if n := len(utf16.Encode([]rune(got))); n != 300 {
		t.Fatalf("corte utf16=%d", n)
	}
	if cutUTF16("submitted", 300) != "submitted" {
		t.Fatal("classificação estável foi cortada")
	}
}

func TestCloudJournal_B15_C01(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "queued"})
	cjJournalRequireOldestQueued(t, opened, scope, fx.logID)
	var sender cjJournalSender
	start := make(chan struct{})
	var wg sync.WaitGroup
	type outcome struct {
		id    int64
		err   error
		calls int
	}
	out := make([]outcome, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			local := 0
			out[i].err = opened.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := cjJournalAssume(ctx, tx); err != nil {
					return err
				}
				id, err := cjJournalClaim(ctx, tx, scope.TenantID)
				if err != nil || id == 0 {
					return err
				}
				if id != fx.logID {
					return fmt.Errorf("claim pegou %d", id)
				}
				decision, err := Revalidate(ctx, tx, scope.TenantID, id)
				if err != nil {
					return err
				}
				if decision != DecisionSend {
					return fmt.Errorf("revalidate %s", decision)
				}
				again, err := Revalidate(ctx, tx, scope.TenantID, id)
				if err != nil || again != DecisionSend {
					return fmt.Errorf("replay A %s %v", again, err)
				}
				decision, err = MarkWire(ctx, tx, scope.TenantID, id)
				if err != nil || decision != DecisionSend {
					return fmt.Errorf("mark %s %v", decision, err)
				}
				started, err := sender.Send(ctx, fmt.Sprintf("notice:%d", id))
				if err != nil || !started {
					return fmt.Errorf("sender %v", err)
				}
				local++
				out[i].id = id
				return nil
			})
			out[i].calls = local
		}(i)
	}
	close(start)
	wg.Wait()
	wins := 0
	for _, item := range out {
		if item.err != nil {
			t.Fatal(cjJournalRedact(item.err))
		}
		if item.id != 0 {
			wins++
			if item.calls != 1 {
				t.Fatalf("vencedor chamou sender %d", item.calls)
			}
		}
	}
	if wins != 1 || sender.calls() != 1 {
		t.Fatalf("vitórias=%d sender=%d", wins, sender.calls())
	}
	cjJournalExpectLog(t, opened, scope, fx.logID, "sending", 0, 1)
	cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:wire")
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionSend {
			return fmt.Errorf("replay depois do commit %s %v", decision, err)
		}
		before := cjJournalWireAt(t, tx, fx.logID)
		decision, err = MarkWire(ctx, tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionSend {
			return fmt.Errorf("replay B %s %v", decision, err)
		}
		if cjJournalWireAt(t, tx, fx.logID) != before {
			return fmt.Errorf("replay B mexeu em wire_at")
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:wire")
	cjJournalOtherTenantMisses(t, opened, scope, fx.logID)
}

func TestCloudJournal_B15_C07(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx := context.Background()
	fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"})
	if err := cjJournalSetAllow(ctx, opened, scope, fx.contactID, false); err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	var sender cjJournalSender
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
		if err != nil {
			return err
		}
		if decision != DecisionOptOut {
			return fmt.Errorf("decision %s", decision)
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if sender.calls() != 0 {
		t.Fatal("opt-out chamou sender")
	}
	cjJournalExpectLog(t, opened, scope, fx.logID, "skipped_no_consent", 0, 1)
	cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent")
	if cjJournalAllow(t, opened, scope, fx.contactID) {
		t.Fatal("allow_notices voltou")
	}
	if cjJournalProvider(t, opened, scope, fx.logID) != "" {
		t.Fatal("opt-out gravou provider_message_id")
	}
	err = opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		return RecordResult(ctx, tx, scope.TenantID, fx.logID, 200, "wamid-tarde", false, false, "EAA"+fx.phone)
	})
	if err == nil {
		t.Fatal("RecordResult aceitou log que não está sending")
	}
	cjJournalExpectLog(t, opened, scope, fx.logID, "skipped_no_consent", 0, 1)
}

func TestCloudJournal_B15_C08(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx := context.Background()
	fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"})
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionSend {
			return fmt.Errorf("revalidate %s %v", decision, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:reserved")
	before := cjJournalMoney(t, opened, scope, fx.invoice)
	cjJournalPay(t, opened, scope, fx.invoice, fx.amount)
	paid := cjJournalMoney(t, opened, scope, fx.invoice)
	if paid.payments != before.payments+1 {
		t.Fatalf("quitação não gravou payment: %+v %+v", before, paid)
	}
	var sender cjJournalSender
	err = opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		decision, err := MarkWire(ctx, tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionSettled {
			return fmt.Errorf("mark %s %v", decision, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if sender.calls() != 0 {
		t.Fatal("fatura quitada chamou sender")
	}
	after := cjJournalMoney(t, opened, scope, fx.invoice)
	if after != paid {
		t.Fatalf("journal mexeu em dinheiro: %+v -> %+v", paid, after)
	}
	cjJournalExpectLog(t, opened, scope, fx.logID, "skipped_settled", 0, 1)
	cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent")
}

func TestCloudJournal_B15_C09(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx := context.Background()
	t.Run("perda depois de wire", func(t *testing.T) {
		fx := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		cjJournalBackdate(t, opened, scope, fx.logID, true)
		cjJournalGenericSweep(t, opened, scope)
		cjJournalExpectLog(t, opened, scope, fx.logID, "uncertain", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:wire")
		if err := cjJournalSweep(ctx, opened, scope); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		if err := cjJournalSweep(ctx, opened, scope); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectLog(t, opened, scope, fx.logID, "uncertain", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:uncertain")
		err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := cjJournalAssume(ctx, tx); err != nil {
				return err
			}
			_, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
			return err
		})
		if !errors.Is(err, errNoResend) {
			t.Fatalf("reenvio: %v", cjJournalRedact(err))
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:uncertain")
	})
	t.Run("reserved depois da varredura", func(t *testing.T) {
		fx := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, false)
		cjJournalBackdate(t, opened, scope, fx.logID, false)
		cjJournalGenericSweep(t, opened, scope)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:reserved")
		if err := cjJournalSweep(ctx, opened, scope); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectLog(t, opened, scope, fx.logID, "uncertain", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent")
	})
	t.Run("wire recente permanece", func(t *testing.T) {
		fx := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		if err := cjJournalSweep(ctx, opened, scope); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectLog(t, opened, scope, fx.logID, "sending", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:wire")
	})
	t.Run("resultado e rollback", func(t *testing.T) {
		fx := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		secret := "EAAnotreal" + fx.phone + strings.Repeat("x", 400)
		err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := cjJournalAssume(ctx, tx); err != nil {
				return err
			}
			if err := RecordResult(ctx, tx, scope.TenantID, fx.logID, 200, "wamid-ok", false, false, secret); err != nil {
				return err
			}
			return errCjJournalRollback
		})
		if !errors.Is(err, errCjJournalRollback) {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:wire")
		cjJournalExpectLog(t, opened, scope, fx.logID, "sending", 0, 1)

		if err = cjJournalRecord(ctx, opened, scope, fx.logID, 200, "wamid-ok", false, false, secret); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		if err = cjJournalRecord(ctx, opened, scope, fx.logID, 200, "wamid-ok", false, false, secret); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectLog(t, opened, scope, fx.logID, "sent", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:submitted")
		excerpt := cjJournalExcerpt(t, opened, scope, fx.logID)
		if excerpt != "submitted" || strings.Contains(excerpt, "EAA") || strings.Contains(excerpt, fx.phone) || len(utf16.Encode([]rune(excerpt))) > 300 {
			t.Fatalf("excerpt %q", excerpt)
		}
		if cjJournalProvider(t, opened, scope, fx.logID) != "wamid-ok" {
			t.Fatal("id de provedor não ficou estável")
		}
		err = cjJournalRecord(ctx, opened, scope, fx.logID, 429, "", false, true, secret)
		if !errors.Is(err, errTerminal) {
			t.Fatalf("sobrescreveu terminal: %v", err)
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:submitted")

		refused := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		if err = cjJournalRecord(ctx, opened, scope, refused.logID, 429, "", false, false, secret); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		if cjJournalExcerpt(t, opened, scope, refused.logID) != "refused" || cjJournalProvider(t, opened, scope, refused.logID) != "" {
			t.Fatal("recusa guardou payload ou id")
		}
		cjJournalExpectLog(t, opened, scope, refused.logID, "failed", 0, 1)

		uncertain := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		if err = cjJournalRecord(ctx, opened, scope, uncertain.logID, 200, "", false, false, secret); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectLog(t, opened, scope, uncertain.logID, "uncertain", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, uncertain.logID, "1:uncertain")
		if cjJournalProvider(t, opened, scope, uncertain.logID) != "" || cjJournalExcerpt(t, opened, scope, uncertain.logID) != "uncertain" {
			t.Fatal("2xx sem id virou aceite")
		}

		reserved := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, false)
		err = cjJournalRecord(ctx, opened, scope, reserved.logID, 200, "wamid-cedo", false, false, secret)
		if err == nil {
			t.Fatal("RecordResult aceitou attempt que não está wire")
		}
		cjJournalExpectAttempts(t, opened, scope, reserved.logID, "1:reserved")

		bad := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		err = cjJournalRecord(ctx, opened, scope, bad.logID, 200, "wamid-x", true, false, secret)
		if !errors.Is(err, errResult) {
			t.Fatalf("resultado contraditório: %v", err)
		}
		cjJournalExpectAttempts(t, opened, scope, bad.logID, "1:wire")
	})
}

func TestCloudJournal_B15_C21(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx := context.Background()
	t.Run("quitação visível em B", func(t *testing.T) {
		fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"})
		if err := cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
			decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
			if err != nil || decision != DecisionSend {
				return fmt.Errorf("A %s %v", decision, err)
			}
			return nil
		}); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		_, held, done, pay := cjJournalHoldInvoice(t, opened, scope, fx.invoice, fx.amount)
		cjJournalWaitHeld(t, held, done)
		result := make(chan Decision, 1)
		errc := make(chan error, 1)
		go func() {
			var decision Decision
			err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := cjJournalAssume(ctx, tx); err != nil {
					return err
				}
				var e error
				decision, e = MarkWire(ctx, tx, scope.TenantID, fx.logID)
				return e
			})
			result <- decision
			errc <- err
		}()
		cjJournalWaitAdvisory(t, opened, scope, scope.TenantID, fx.invoice)
		close(pay)
		decision := <-result
		if err := <-errc; err != nil || decision != DecisionSettled {
			t.Fatalf("B %s %v", decision, cjJournalRedact(err))
		}
		cjJournalWaitDone(t, done, false)
		cjJournalExpectLog(t, opened, scope, fx.logID, "skipped_settled", 0, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent")
		if cjJournalMoney(t, opened, scope, fx.invoice).payments != 1 {
			t.Fatal("pagamento da corrida sumiu")
		}
	})
	t.Run("pagamento depois do wire", func(t *testing.T) {
		fx := cjJournalAdvance(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "sending"}, true)
		cjJournalPay(t, opened, scope, fx.invoice, fx.amount)
		var sender cjJournalSender
		started, err := sender.Send(ctx, "depois-do-wire")
		if err != nil || !started || sender.calls() != 1 {
			t.Fatalf("sender %d %v", sender.calls(), err)
		}
		err = cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
			decision, err := MarkWire(ctx, tx, scope.TenantID, fx.logID)
			if err != nil || decision != DecisionSend {
				return fmt.Errorf("replay depois do pagamento %s %v", decision, err)
			}
			return RecordResult(ctx, tx, scope.TenantID, fx.logID, 200, "wamid-depois", false, false, "payload")
		})
		if err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:submitted")
		cjJournalExpectLog(t, opened, scope, fx.logID, "sent", 0, 1)
		if cjJournalMoney(t, opened, scope, fx.invoice).payments != 1 || cjJournalExcerpt(t, opened, scope, fx.logID) != "submitted" {
			t.Fatal("pagamento ou excerpt depois do wire")
		}
	})
	t.Run("orçamento 3", func(t *testing.T) {
		fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, active: true, status: "queued"})
		cjJournalRequireOldestQueued(t, opened, scope, fx.logID)
		var sender cjJournalSender
		cjJournalClaimOurs(t, opened, scope, fx.logID)
		cjJournalTimeout(t, opened, scope, fx, true)
		cjJournalExpectLog(t, opened, scope, fx.logID, "queued", 1, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "")
		cjJournalClaimOurs(t, opened, scope, fx.logID)
		if err := cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
			decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
			if err != nil || decision != DecisionSend {
				return fmt.Errorf("segundo A %s %v", decision, err)
			}
			return nil
		}); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:reserved")
		cjJournalTimeout(t, opened, scope, fx, false)
		cjJournalExpectLog(t, opened, scope, fx.logID, "queued", 2, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent")
		cjJournalClaimOurs(t, opened, scope, fx.logID)
		if err := cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
			decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
			if err != nil || decision != DecisionSend {
				return fmt.Errorf("attempt 2 %s %v", decision, err)
			}
			return nil
		}); err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent,2:reserved")
		cjJournalTimeout(t, opened, scope, fx, false)
		cjJournalExpectLog(t, opened, scope, fx.logID, "failed", 3, 1)
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent,2:not_sent")
		err := cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
			decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
			if err != nil || decision != DecisionLockTimeout {
				return fmt.Errorf("depois do teto %s %v", decision, err)
			}
			return nil
		})
		if err != nil {
			t.Fatal(cjJournalRedact(err))
		}
		cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent,2:not_sent")
		if sender.calls() != 0 {
			t.Fatal("estouro chamou sender")
		}
		if id := cjJournalClaimID(t, opened, scope); id == fx.logID {
			t.Fatal("failed voltou para a fila")
		}
	})
}

func TestCloudJournal_B15_C26(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx := context.Background()
	notes, orders := cjJournalSideCounts(t, opened, scope)
	cases := []struct {
		name    string
		purpose string
		allow   bool
		want    Decision
		status  string
		attempt string
		send    bool
	}{
		{name: "technical", purpose: "technical", allow: true, want: DecisionSend, status: "sending", attempt: "1:wire", send: true},
		{name: "billing", purpose: "billing", allow: true, want: DecisionSend, status: "sending", attempt: "1:wire", send: true},
		{name: "opt-out", purpose: "technical", allow: false, want: DecisionOptOut, status: "skipped_no_consent", attempt: "1:not_sent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindMaintenance, purpose: tc.purpose, allow: tc.allow, active: true, status: "sending"})
			if Classify("", fx.maintenance) != LogKindMaintenance || Classify(fx.invoice, fx.maintenance) != LogKindMaintenance {
				t.Fatal("classify da manutenção")
			}
			var sender cjJournalSender
			err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := cjJournalAssume(ctx, tx); err != nil {
					return err
				}
				decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
				if err != nil {
					return err
				}
				if decision == DecisionSettled {
					return fmt.Errorf("manutenção devolveu settled")
				}
				if decision != tc.want && !(tc.send && decision == DecisionSend) {
					return fmt.Errorf("revalidate %s", decision)
				}
				if decision != DecisionSend {
					return cjJournalExpectNoInvoiceLock(ctx, tx)
				}
				decision, err = MarkWire(ctx, tx, scope.TenantID, fx.logID)
				if err != nil || decision != DecisionSend {
					return fmt.Errorf("mark %s %v", decision, err)
				}
				if err = cjJournalExpectNoInvoiceLock(ctx, tx); err != nil {
					return err
				}
				started, err := sender.Send(ctx, fx.phone)
				if err != nil || !started {
					return err
				}
				return nil
			})
			if err != nil {
				t.Fatal(cjJournalRedact(err))
			}
			if tc.send && sender.calls() != 1 {
				t.Fatalf("sender %d", sender.calls())
			}
			if !tc.send && sender.calls() != 0 {
				t.Fatal("opt-out de manutenção chamou sender")
			}
			cjJournalExpectLog(t, opened, scope, fx.logID, tc.status, 0, 1)
			cjJournalExpectAttempts(t, opened, scope, fx.logID, tc.attempt)
			if cjJournalPhone(t, opened, scope, fx.logID) != fx.phone {
				t.Fatal("contact_value trocado")
			}
		})
	}
	notes2, orders2 := cjJournalSideCounts(t, opened, scope)
	if notes2 != notes || orders2 != orders {
		t.Fatalf("notifications %d->%d work_orders %d->%d", notes, notes2, orders, orders2)
	}
}

func TestCloudJournal_IneligibleAndInactive(t *testing.T) {
	opened, scope := cjJournalDatabase(t)
	ctx := context.Background()
	fx := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindOther, active: true, status: "sending"})
	err := cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
		decision, err := Revalidate(ctx, tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionIneligible {
			return fmt.Errorf("other %s %v", decision, err)
		}
		return cjJournalExpectNoInvoiceLock(ctx, tx)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	cjJournalExpectLog(t, opened, scope, fx.logID, "failed", 0, 1)
	cjJournalExpectAttempts(t, opened, scope, fx.logID, "1:not_sent")

	inactive := cjJournalSeed(t, opened, scope, cjJournalSeedOpt{kind: LogKindBilling, purpose: "billing", allow: true, status: "sending"})
	err = cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
		_, err := Revalidate(ctx, tx, scope.TenantID, inactive.logID)
		if !errors.Is(err, errInactive) {
			return fmt.Errorf("inativa: %v", err)
		}
		return errCjJournalRollback
	})
	if !errors.Is(err, errCjJournalRollback) {
		t.Fatal(cjJournalRedact(err))
	}
	cjJournalExpectLog(t, opened, scope, inactive.logID, "sending", 0, 1)
	cjJournalExpectAttempts(t, opened, scope, inactive.logID, "")
}

type cjJournalSeedOpt struct {
	kind    LogKind
	purpose string
	allow   bool
	active  bool
	status  string
}

type cjJournalFx struct {
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

type cjJournalMoneySnap struct {
	payments int
	invoices int
	moves    int
}

type cjJournalSender struct {
	mu sync.Mutex
	n  int
}

func (s *cjJournalSender) Send(context.Context, string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	return true, nil
}

func (s *cjJournalSender) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.n
}

func cjJournalDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_CLOUD_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_CLOUD_PG_REQUIRED=1; o journal não executou e PostgreSQL não está aprovado")
		}
		t.Skip(cjJournalSkip)
	}
	if err := cjJournalRejectLabURL(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	opened, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("db.Open falhou com URL presente; skip não se aplica: %v", cjJournalRedact(err))
	}
	t.Cleanup(opened.Close)
	var name, sessionUser, currentUser string
	if err = opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser)
	}); err != nil {
		t.Fatalf("identidade do laboratório: %v", cjJournalRedact(err))
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" {
		t.Fatalf("conexão fora de nexo_test/nexo_go: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	return opened, cjJournalExclusiveScope(t, opened)
}

func cjJournalExclusiveScope(t *testing.T, opened *db.DB) tenancy.Scope {
	t.Helper()
	ctx := context.Background()
	id, slug, err := cjJournalInsertExclusiveTenant(ctx)
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	t.Cleanup(func() {
		if err := cjJournalDetachExclusiveTenant(context.Background(), id, slug); err != nil {
			t.Errorf("limpeza cjJournal escopo: %v", cjJournalRedact(err))
		}
	})
	scope := tenancy.Scope{TenantID: id}
	err = opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		var seen string
		if err := tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() where tenant_id = $1::uuid`, id).Scan(&seen); err != nil {
			return fmt.Errorf("escopo exclusivo fora do diretório: %w", err)
		}
		if seen != id {
			return fmt.Errorf("diretório devolveu outro tenant")
		}
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		if err := cjJournalSeedBaseContract(ctx, tx); err != nil {
			return err
		}
		var queued int
		if err := tx.QueryRow(ctx, `select count(*) from notice_log where tenant_id = app_tenant() and status = 'queued'`).Scan(&queued); err != nil {
			return err
		}
		if queued != 0 {
			return fmt.Errorf("escopo exclusivo já tem %d notice_log queued", queued)
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return scope
}

func cjJournalInsertExclusiveTenant(ctx context.Context) (string, string, error) {
	tail := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	id := "ffffffff-ffff-4fff-bfff-" + tail
	if _, err := uuid.Parse(id); err != nil {
		return "", "", err
	}
	slug := "cj" + tail
	err := labtest.InsertExclusiveJournalTenant(ctx, cjJournalOwnerURL(), os.Getenv("NEXO_GO_TEST_DATABASE_URL"), id, slug)
	return id, slug, err
}

func cjJournalSeedBaseContract(ctx context.Context, tx *db.Tx) error {
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var subscriber, plan, version string
	if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status) values (app_tenant(), $1, 'active') returning id::text`, "cjJournal base "+mark).Scan(&subscriber); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `insert into plans (tenant_id, name) values (app_tenant(), $1) returning id::text`, "cjJournal plano "+mark).Scan(&plan); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values (app_tenant(), $1::uuid, 1, 6400, 100000, 50000, 'cjjournal') returning id::text`, plan).Scan(&version); err != nil {
		return err
	}
	return tx.Exec(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) values (app_tenant(), $1::uuid, $2::uuid, 15)`, subscriber, version)
}

func cjJournalDetachExclusiveTenant(ctx context.Context, id, slug string) error {
	return labtest.DetachExclusiveJournalTenant(ctx, cjJournalOwnerURL(), os.Getenv("NEXO_GO_TEST_DATABASE_URL"), id, slug)
}

func cjJournalSeed(t *testing.T, opened *db.DB, scope tenancy.Scope, opt cjJournalSeedOpt) cjJournalFx {
	t.Helper()
	ctx := context.Background()
	var fx cjJournalFx
	fx.amount = 1500
	fx.phone = cjJournalPhoneValue(opt.purpose)
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		var err error
		if opt.kind == LogKindBilling {
			fx.subscriber, fx.invoice, err = cjJournalBillingParty(ctx, tx, fx.amount)
		} else {
			fx.subscriber, err = cjJournalInsertSubscriber(ctx, tx)
		}
		if err != nil {
			return err
		}
		if opt.kind != LogKindOther {
			fx.contactID, err = cjJournalInsertContact(ctx, tx, fx.subscriber, fx.phone, opt.purpose, opt.allow)
			if err != nil {
				return err
			}
		}
		if opt.kind == LogKindMaintenance {
			fx.maintenance, err = cjJournalInsertMaintenance(ctx, tx)
			if err != nil {
				return err
			}
		}
		fx.account, fx.channel, err = cjJournalInsertChannel(ctx, tx, opt.active)
		if err != nil {
			return err
		}
		fx.logID, err = cjJournalInsertLog(ctx, tx, fx, opt)
		return err
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	t.Cleanup(func() { cjJournalCleanup(t, opened, scope, fx) })
	return fx
}

func cjJournalAdvance(t *testing.T, opened *db.DB, scope tenancy.Scope, opt cjJournalSeedOpt, wire bool) cjJournalFx {
	t.Helper()
	fx := cjJournalSeed(t, opened, scope, opt)
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		decision, err := Revalidate(context.Background(), tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionSend {
			return fmt.Errorf("advance A %s %v", decision, err)
		}
		if !wire {
			return nil
		}
		decision, err = MarkWire(context.Background(), tx, scope.TenantID, fx.logID)
		if err != nil || decision != DecisionSend {
			return fmt.Errorf("advance B %s %v", decision, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return fx
}

func cjJournalInTx(ctx context.Context, opened *db.DB, scope tenancy.Scope, fn func(*db.Tx) error) error {
	return opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		return fn(tx)
	})
}

func cjJournalBillingParty(ctx context.Context, tx *db.Tx, amount int) (string, string, error) {
	var base, subscriber, invoice string
	if err := tx.QueryRow(ctx, `select id::text from contracts where tenant_id = app_tenant() and status = 'active' order by id limit 1`).Scan(&base); err != nil {
		return "", "", fmt.Errorf("tenant sem contrato ativo para a fixture: %w", err)
	}
	if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status)
		select tenant_id, $2, 'active' from contracts where id = $1::uuid returning id::text`, base, "cjJournal "+uuid.NewString()[:8]).Scan(&subscriber); err != nil {
		return "", "", err
	}
	invoice = uuid.NewString()
	err := tx.Exec(ctx, `insert into invoices (id, tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
		select $3::uuid, tenant_id, id, $2::uuid, 'manual', current_date, $4 from contracts where id = $1::uuid`, base, subscriber, invoice, amount)
	return subscriber, invoice, err
}

func cjJournalInsertSubscriber(ctx context.Context, tx *db.Tx) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status) values (app_tenant(), $1, 'active') returning id::text`, "cjJournal "+uuid.NewString()[:8]).Scan(&id)
	return id, err
}

func cjJournalInsertContact(ctx context.Context, tx *db.Tx, subscriber, phone, purpose string, allow bool) (string, error) {
	if purpose == "" {
		purpose = "general"
	}
	var id string
	err := tx.QueryRow(ctx, `insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, purpose, allow_notices)
		values (app_tenant(), $1::uuid, 'mobile', $2, $3, $4) returning id::text`, subscriber, phone, purpose, allow).Scan(&id)
	return id, err
}

func cjJournalInsertMaintenance(ctx context.Context, tx *db.Tx) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `insert into maintenance_notices (tenant_id, title, message, starts_at, ends_at)
		values (app_tenant(), 'cjJournal janela', 'aviso interno de manutencao', now(), now() + interval '1 hour') returning id::text`).Scan(&id)
	return id, err
}

func cjJournalInsertChannel(ctx context.Context, tx *db.Tx, active bool) (string, string, error) {
	name := "cj" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var account, channel string
	if err := tx.QueryRow(ctx, `insert into cloud_accounts (tenant_id, name, phone_number_id, graph_version, token_enc, webhook_secret_enc, active)
		values (app_tenant(), $1, $2, 'v0.0', $3, $3, $4) returning id::text`, "cjJournal "+name[:8], name, cjJournalCipher, active).Scan(&account); err != nil {
		return "", "", err
	}
	err := tx.QueryRow(ctx, `insert into notice_channels (tenant_id, name, url, adapter, cloud_account_id)
		values (app_tenant(), $1, 'https://invalid.test/cj-journal', 'cloud_api', $2::uuid) returning id::text`, name, account).Scan(&channel)
	return account, channel, err
}

func cjJournalInsertLog(ctx context.Context, tx *db.Tx, fx cjJournalFx, opt cjJournalSeedOpt) (int64, error) {
	var invoice, maintenance, phase any
	if fx.invoice != "" {
		invoice = fx.invoice
	}
	if fx.maintenance != "" {
		maintenance = fx.maintenance
		phase = "start"
	}
	var contact any
	if fx.phone != "" {
		contact = fx.phone
	}
	var subscriber any
	if fx.subscriber != "" {
		subscriber = fx.subscriber
	}
	var id int64
	err := tx.QueryRow(ctx, `insert into notice_log (tenant_id, invoice_id, subscriber_id, contact_value, channel_id, status, attempts, message, claimed_at, maintenance_notice_id, phase)
		values (app_tenant(), $1::uuid, $2::uuid, $3, $4::uuid, $5, 1, 'cjJournal corpo', now(), $6::uuid, $7) returning id`,
		invoice, subscriber, contact, fx.channel, opt.status, maintenance, phase).Scan(&id)
	return id, err
}

func cjJournalCleanup(t *testing.T, opened *db.DB, scope tenancy.Scope, fx cjJournalFx) {
	t.Helper()
	ctx := context.Background()
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `delete from notice_log where id = $1 and tenant_id = app_tenant()`, fx.logID); err != nil {
			return err
		}
		if fx.channel != "" {
			if err := tx.Exec(ctx, `delete from notice_channels where id = $1::uuid and tenant_id = app_tenant()`, fx.channel); err != nil {
				return err
			}
		}
		if fx.contactID != "" {
			if err := tx.Exec(ctx, `delete from subscriber_contacts where id = $1::uuid and tenant_id = app_tenant()`, fx.contactID); err != nil {
				return err
			}
		}
		if fx.invoice != "" {
			if err := tx.Exec(ctx, `update invoices set status = 'canceled', canceled_at = now() where id = $1::uuid and tenant_id = app_tenant() and status = 'open'`, fx.invoice); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Errorf("limpeza cjJournal: %v", cjJournalRedact(err))
		return
	}
	// nexo_app só tem SELECT/INSERT/UPDATE em maintenance_notices. O owner apaga só a janela desta fixture, depois do notice_log.
	if fx.maintenance != "" {
		if err := cjJournalDeleteMaintenance(ctx, scope.TenantID, fx.maintenance); err != nil {
			t.Errorf("limpeza cjJournal: %v", cjJournalRedact(err))
		}
	}
	if fx.account == "" {
		return
	}
	if err := cjJournalDeleteAccount(ctx, scope.TenantID, fx.account); err != nil {
		t.Errorf("limpeza cjJournal: %v", cjJournalRedact(err))
	}
}

func cjJournalDeleteMaintenance(ctx context.Context, tenant, maintenance string) error {
	return labtest.DeleteOwnCloudFixture(ctx, cjJournalOwnerURL(), os.Getenv("NEXO_GO_TEST_DATABASE_URL"), labtest.FamilyCloudJournal, tenant, "", maintenance)
}

func cjJournalDeleteAccount(ctx context.Context, tenant, account string) error {
	return labtest.DeleteOwnCloudFixture(ctx, cjJournalOwnerURL(), os.Getenv("NEXO_GO_TEST_DATABASE_URL"), labtest.FamilyCloudJournal, tenant, account, "")
}

func cjJournalOwnerURL() string {
	return strings.TrimSpace(os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL"))
}

func cjJournalClaim(ctx context.Context, tx *db.Tx, tenant string) (int64, error) {
	sqlText := cjJournalSQL(nil, "69b06ce3_6.sql")
	parsed, err := uuid.Parse(tenant)
	if err != nil {
		return 0, err
	}
	var id int64
	var contact, message *string
	var channel any
	err = tx.QueryRow(ctx, sqlText, parsed).Scan(&id, &contact, &message, &channel)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return id, err
}

func cjJournalClaimOurs(t *testing.T, opened *db.DB, scope tenancy.Scope, want int64) {
	t.Helper()
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		id, err := cjJournalClaim(context.Background(), tx, scope.TenantID)
		if err != nil {
			return err
		}
		if id != want {
			return fmt.Errorf("claim devolveu %d, fixture %d", id, want)
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
}

func cjJournalClaimID(t *testing.T, opened *db.DB, scope tenancy.Scope) int64 {
	t.Helper()
	var id int64
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(context.Background(), tx); err != nil {
			return err
		}
		got, err := cjJournalClaim(context.Background(), tx, scope.TenantID)
		if err != nil {
			return err
		}
		id = got
		return errCjJournalRollback
	})
	if !errors.Is(err, errCjJournalRollback) {
		t.Fatal(cjJournalRedact(err))
	}
	return id
}

func cjJournalRequireOldestQueued(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) {
	t.Helper()
	var older int
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from notice_log where tenant_id = app_tenant() and status = 'queued' and id < $1`, id).Scan(&older)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if older != 0 {
		t.Fatalf("tenant já tem %d notice_log queued anteriores; o claim oficial não isolaria a fixture", older)
	}
}

func cjJournalGenericSweep(t *testing.T, opened *db.DB, scope tenancy.Scope) {
	t.Helper()
	sqlText := cjJournalSQL(t, "69b06ce3_1.sql")
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.Exec(context.Background(), sqlText, uuid.MustParse(scope.TenantID), 10)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
}

func cjJournalSweep(ctx context.Context, opened *db.DB, scope tenancy.Scope) error {
	return cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
		return SweepReserved(ctx, tx, scope.TenantID)
	})
}

func cjJournalBackdate(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64, wire bool) {
	t.Helper()
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		if err := tx.Exec(context.Background(), `update notice_log set claimed_at = now() - interval '11 minutes' where id = $1 and tenant_id = app_tenant()`, id); err != nil {
			return err
		}
		if !wire {
			return nil
		}
		return tx.Exec(context.Background(), `update cloud_notice_attempts set wire_at = now() - interval '11 minutes' where notice_log_id = $1 and tenant_id = app_tenant() and state = 'wire'`, id)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
}

func cjJournalRecord(ctx context.Context, opened *db.DB, scope tenancy.Scope, id int64, status int, provider string, uncertain, refused bool, excerpt string) error {
	return cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
		return RecordResult(ctx, tx, scope.TenantID, id, status, provider, uncertain, refused, excerpt)
	})
}

func cjJournalPay(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string, amount int) {
	t.Helper()
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		if err := finance.LockInvoices(context.Background(), tx, scope.TenantID, invoice); err != nil {
			return err
		}
		return tx.Exec(context.Background(), `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source)
			values (app_tenant(), $1::uuid, $2, now(), 'manual', 'manual')`, invoice, amount)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
}

func cjJournalTimeout(t *testing.T, opened *db.DB, scope tenancy.Scope, fx cjJournalFx, first bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	release, held, done, _ := cjJournalHoldInvoice(t, opened, scope, fx.invoice, 0)
	cjJournalWaitHeld(t, held, done)
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		var decision Decision
		var err error
		if first {
			decision, err = Revalidate(ctx, tx, scope.TenantID, fx.logID)
		} else {
			decision, err = MarkWire(ctx, tx, scope.TenantID, fx.logID)
		}
		if err != nil || decision != DecisionLockTimeout {
			return fmt.Errorf("timeout %s %v", decision, err)
		}
		var status string
		if err = tx.QueryRow(ctx, `select status from notice_log where id = $1 and tenant_id = app_tenant()`, fx.logID).Scan(&status); err != nil {
			return fmt.Errorf("transação abortada depois do estouro: %w", err)
		}
		return nil
	})
	release()
	cjJournalWaitDone(t, done, false)
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
}

func cjJournalHoldInvoice(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string, payAmount int) (func(), <-chan struct{}, <-chan error, chan struct{}) {
	t.Helper()
	releaseCh := make(chan struct{})
	pay := make(chan struct{})
	held := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			if err := cjJournalAssume(context.Background(), tx); err != nil {
				return err
			}
			if err := finance.LockInvoices(context.Background(), tx, scope.TenantID, invoice); err != nil {
				return err
			}
			close(held)
			if payAmount > 0 {
				select {
				case <-pay:
				case <-releaseCh:
					return nil
				}
				if err := tx.Exec(context.Background(), `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source)
					values (app_tenant(), $1::uuid, $2, now(), 'manual', 'manual')`, invoice, payAmount); err != nil {
					return err
				}
				return nil
			}
			<-releaseCh
			return nil
		})
	}()
	release := func() {
		select {
		case <-releaseCh:
		default:
			close(releaseCh)
		}
	}
	t.Cleanup(release)
	return release, held, done, pay
}

func cjJournalWaitHeld(t *testing.T, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatal(cjJournalRedact(err))
	case <-time.After(5 * time.Second):
		t.Fatal("sessão não segurou a fatura")
	}
}

func cjJournalWaitDone(t *testing.T, done <-chan error, rollback bool) {
	t.Helper()
	select {
	case err := <-done:
		if rollback {
			if !errors.Is(err, errCjJournalRollback) {
				t.Fatal(cjJournalRedact(err))
			}
			return
		}
		if err != nil {
			t.Fatal(cjJournalRedact(err))
		}
	case <-time.After(8 * time.Second):
		t.Fatal("sessão de fatura não encerrou")
	}
}

func cjJournalWaitAdvisory(t *testing.T, opened *db.DB, scope tenancy.Scope, tenant, invoice string) {
	t.Helper()
	key := uuid.MustParse(tenant).String() + ":invoice:" + uuid.MustParse(invoice).String()
	deadline := time.Now().Add(1500 * time.Millisecond)
	var last error
	for time.Now().Before(deadline) {
		var n int
		last = cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
			return tx.QueryRow(context.Background(), `
				select count(*) from pg_locks
				where granted = false and locktype = 'advisory'
				  and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, $2)`, key, cjJournalInvoiceSalt).Scan(&n)
		})
		if last == nil && n > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("MarkWire não esperou o advisory 7411005: %v", cjJournalRedact(last))
}

func cjJournalExpectLog(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64, status string, timeouts, attempts int) {
	t.Helper()
	var gotStatus string
	var gotTimeouts, gotAttempts int
	var message *string
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select status, cloud_lock_timeouts, attempts, message from notice_log where id = $1 and tenant_id = app_tenant()`, id).Scan(&gotStatus, &gotTimeouts, &gotAttempts, &message)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if gotStatus != status || gotTimeouts != timeouts || gotAttempts != attempts {
		t.Fatalf("log status=%s timeouts=%d attempts=%d", gotStatus, gotTimeouts, gotAttempts)
	}
	if status != "sending" && status != "queued" && message != nil {
		t.Fatalf("message permaneceu em %s", status)
	}
}

func cjJournalExpectAttempts(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64, want string) {
	t.Helper()
	var got string
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `
			select coalesce(string_agg(attempt_no::text || ':' || state, ',' order by attempt_no), '')
			from cloud_notice_attempts where notice_log_id = $1 and tenant_id = app_tenant()`, id).Scan(&got)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if got != want {
		t.Fatalf("attempts %q, want %q", got, want)
	}
}

func cjJournalMoney(t *testing.T, opened *db.DB, scope tenancy.Scope, invoice string) cjJournalMoneySnap {
	t.Helper()
	var snap cjJournalMoneySnap
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(context.Background(), `select count(*) from payments where invoice_id = $1::uuid and tenant_id = app_tenant()`, invoice).Scan(&snap.payments); err != nil {
			return err
		}
		if err := tx.QueryRow(context.Background(), `select count(*) from invoices where id = $1::uuid and tenant_id = app_tenant()`, invoice).Scan(&snap.invoices); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(), `select count(*) from invoice_movements where invoice_id = $1::uuid and tenant_id = app_tenant()`, invoice).Scan(&snap.moves)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return snap
}

func cjJournalExcerpt(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) string {
	t.Helper()
	var excerpt *string
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select excerpt from cloud_notice_attempts where notice_log_id = $1 and tenant_id = app_tenant() order by attempt_no desc limit 1`, id).Scan(&excerpt)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if excerpt == nil {
		return ""
	}
	return *excerpt
}

func cjJournalProvider(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) string {
	t.Helper()
	var provider *string
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select provider_message_id from cloud_notice_attempts where notice_log_id = $1 and tenant_id = app_tenant() order by attempt_no desc limit 1`, id).Scan(&provider)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if provider == nil {
		return ""
	}
	return *provider
}

func cjJournalPhone(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) string {
	t.Helper()
	var phone string
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select contact_value from notice_log where id = $1 and tenant_id = app_tenant()`, id).Scan(&phone)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return phone
}

func cjJournalAllow(t *testing.T, opened *db.DB, scope tenancy.Scope, contact string) bool {
	t.Helper()
	var allow bool
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select allow_notices from subscriber_contacts where id = $1::uuid and tenant_id = app_tenant()`, contact).Scan(&allow)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return allow
}

func cjJournalSetAllow(ctx context.Context, opened *db.DB, scope tenancy.Scope, contact string, allow bool) error {
	return cjJournalInTx(ctx, opened, scope, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update subscriber_contacts set allow_notices = $2 where id = $1::uuid and tenant_id = app_tenant()`, contact, allow)
	})
}

func cjJournalWireAt(t *testing.T, tx *db.Tx, id int64) time.Time {
	t.Helper()
	var at time.Time
	if err := tx.QueryRow(context.Background(), `select wire_at from cloud_notice_attempts where notice_log_id = $1 and tenant_id = app_tenant()`, id).Scan(&at); err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return at
}

func cjJournalExpectNoInvoiceLock(ctx context.Context, tx *db.Tx) error {
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from pg_locks where pid = pg_backend_pid() and (locktype = 'advisory' or relation = 'invoices'::regclass)`).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return fmt.Errorf("manutenção adquiriu lock de fatura ou advisory")
	}
	return nil
}

func cjJournalSideCounts(t *testing.T, opened *db.DB, scope tenancy.Scope) (int, int) {
	t.Helper()
	var notes, orders int
	err := cjJournalInTx(context.Background(), opened, scope, func(tx *db.Tx) error {
		if err := tx.QueryRow(context.Background(), `select count(*) from notifications where tenant_id = app_tenant()`).Scan(&notes); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(), `select count(*) from work_orders where tenant_id = app_tenant()`).Scan(&orders)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	return notes, orders
}

func cjJournalOtherTenantMisses(t *testing.T, opened *db.DB, scope tenancy.Scope, id int64) {
	t.Helper()
	ctx := context.Background()
	var other string
	err := opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select coalesce((select tenant_id::text from nexo_go_directory() where tenant_id::text <> $1 order by tenant_id limit 1), '')`, scope.TenantID).Scan(&other)
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	if other == "" {
		return
	}
	err = opened.WithScope(ctx, tenancy.Scope{TenantID: other}, func(tx *db.Tx) error {
		if err := cjJournalAssume(ctx, tx); err != nil {
			return err
		}
		_, err := Revalidate(ctx, tx, other, id)
		if err == nil {
			return fmt.Errorf("outro tenant leu o aviso")
		}
		return nil
	})
	if err != nil {
		t.Fatal(cjJournalRedact(err))
	}
	cjJournalExpectAttempts(t, opened, scope, id, "1:wire")
}

func cjJournalAssume(ctx context.Context, tx *db.Tx) error {
	var name, sessionUser, currentUser string
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
		return err
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" {
		return fmt.Errorf("sessão antes do papel: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	if err := tx.Exec(ctx, `set local role nexo_app`); err != nil {
		return err
	}
	var super, bypass bool
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`).Scan(&name, &sessionUser, &currentUser, &super, &bypass); err != nil {
		return err
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_app" || super || bypass {
		return fmt.Errorf("papel nexo_app recusado: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	return nil
}

func cjJournalRejectLabURL(raw string) error {
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return fmt.Errorf("URL de laboratório inválida")
	}
	if cfg.User != "nexo_go" || cfg.Database != "nexo_test" {
		return fmt.Errorf("URL recusada; este pacote só usa nexo_go em nexo_test")
	}
	return nil
}

func cjJournalRedact(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	for _, key := range []string{"NEXO_GO_TEST_DATABASE_URL", "NEXO_GO_TEST_DATABASE_OWNER_URL"} {
		url := os.Getenv(key)
		if url == "" {
			continue
		}
		text = strings.ReplaceAll(text, url, key)
		if cfg, parseErr := pgx.ParseConfig(url); parseErr == nil && cfg.Password != "" {
			text = strings.ReplaceAll(text, cfg.Password, key)
		}
	}
	return text
}

func cjJournalPhoneValue(tag string) string {
	compact := strings.ReplaceAll(uuid.NewString(), "-", "")
	if tag == "" {
		tag = "n"
	}
	return "cj" + tag + compact[:10]
}

func cjJournalSQL(t *testing.T, name string) string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		if t != nil {
			t.Fatal("origem indisponível")
		}
		return ""
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "sql", name))
	if err != nil {
		if t != nil {
			t.Fatal(err)
		}
		panic(err)
	}
	return string(b)
}

func cjJournalFunc(t *testing.T, src, name string) string {
	t.Helper()
	start := strings.Index(src, "func "+name+"(")
	if start < 0 {
		t.Fatalf("função %s ausente", name)
	}
	rest := src[start+1:]
	next := strings.Index(rest, "\nfunc ")
	if next < 0 {
		return src[start:]
	}
	return src[start : start+1+next]
}
