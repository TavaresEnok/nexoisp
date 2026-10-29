package cloudjournal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
)

const cjConsentSkip = "NEXO_GO_TEST_DATABASE_URL ausente; skip offline. Este skip não executa o lock FOR SHARE nem aprova PostgreSQL."

var errCjConsentRollback = errors.New("cjConsent rollback")

func TestCloudConsentSQLScopeAndShare(t *testing.T) {
	for _, query := range []string{consentBillingSQL, consentMaintenanceSQL} {
		lower := strings.ToLower(query)
		if strings.Contains(lower, "for key share") {
			t.Fatal("FOR KEY SHARE não bloqueia UPDATE de allow_notices")
		}
		if !strings.Contains(lower, "for share") {
			t.Fatal("releitura sem FOR SHARE")
		}
		if strings.Contains(lower, "pg_has_role") || strings.Contains(lower, "notice_log") || strings.Contains(lower, "invoices") || strings.Contains(lower, "advisory") {
			t.Fatal("consulta de consentimento saiu do contato e do escopo")
		}
		for _, verb := range []string{"insert ", "update ", "delete "} {
			if strings.Contains(lower, verb) {
				t.Fatal("helper de consentimento não escreve")
			}
		}
	}
	if !strings.Contains(consentBillingSQL, "purpose in ('billing', 'general')") {
		t.Fatal("cobrança precisa do filtro billing/general")
	}
	if strings.Contains(consentMaintenanceSQL, "purpose") {
		t.Fatal("manutenção não restringe purpose")
	}
	if !strings.Contains(consentFrom, "value = $3") || !strings.Contains(consentFrom, "app_tenant()") {
		t.Fatal("número e tenant precisam ser explícitos")
	}
}

func TestCloudConsentLabURLGuard(t *testing.T) {
	if err := cjConsentRejectLabURL("postgres://nexo_owner:fixture@127.0.0.1/nexo_test"); err == nil {
		t.Fatal("nexo_owner não é a URL deste pacote")
	}
	if err := cjConsentRejectLabURL("postgres://nexo_go:fixture@127.0.0.1/nexo"); err == nil {
		t.Fatal("banco diferente de nexo_test")
	}
	if err := cjConsentRejectLabURL("postgres://nexo_app:fixture@127.0.0.1/nexo_test"); err == nil {
		t.Fatal("usuário diferente de nexo_go")
	}
	if err := cjConsentRejectLabURL("postgres://nexo_go:fixture@127.0.0.1/nexo_test"); err != nil {
		t.Fatal(err)
	}
}

func TestCloudConsentFilters(t *testing.T) {
	opened, scope := cjConsentDatabase(t)
	ctx := context.Background()
	var subscriber, otherSubscriber string
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(ctx, tx); err != nil {
			return err
		}
		var err error
		subscriber, err = cjConsentInsertSubscriber(ctx, tx, "cjConsent filtros")
		if err != nil {
			return err
		}
		otherSubscriber, err = cjConsentInsertSubscriber(ctx, tx, "cjConsent outro")
		if err != nil {
			return err
		}
		billing := cjConsentPhone("bill")
		general := cjConsentPhone("gen")
		technical := cjConsentPhone("tec")
		landline := cjConsentPhone("land")
		email := "cj" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12] + "@example.test"
		responsible := cjConsentPhone("resp")
		denied := cjConsentPhone("deny")
		technicalDenied := cjConsentPhone("tdeny")
		sameOnOther := billing
		rows := []struct {
			sub, kind, value, purpose string
			allow                     bool
		}{
			{subscriber, "mobile", billing, "billing", true},
			{subscriber, "whatsapp", general, "general", true},
			{subscriber, "mobile", technical, "technical", true},
			{subscriber, "landline", landline, "billing", true},
			{subscriber, "email", email, "billing", true},
			{subscriber, "responsible", responsible, "billing", true},
			{subscriber, "mobile", denied, "billing", false},
			{subscriber, "whatsapp", technicalDenied, "technical", false},
			{otherSubscriber, "mobile", sameOnOther, "billing", true},
		}
		for _, row := range rows {
			if _, err = cjConsentInsertContact(ctx, tx, row.sub, row.kind, row.value, row.purpose, row.allow); err != nil {
				return err
			}
		}
		checks := []struct {
			name, sub, value string
			billing, maint   bool
		}{
			{"billing mobile", subscriber, billing, true, true},
			{"general whatsapp", subscriber, general, true, true},
			{"technical", subscriber, technical, false, true},
			{"landline", subscriber, landline, false, false},
			{"email", subscriber, email, false, false},
			{"responsible", subscriber, responsible, false, false},
			{"allow falso", subscriber, denied, false, false},
			{"technical sem allow", subscriber, technicalDenied, false, false},
			{"número vizinho não substitui", subscriber, cjConsentPhone("ausente"), false, false},
			{"número próprio também gravado no outro", subscriber, sameOnOther, true, true},
			{"número do outro assinante", otherSubscriber, sameOnOther, true, true},
			{"assinante sem o número", otherSubscriber, general, false, false},
		}
		for _, check := range checks {
			if err = cjConsentExpect(ctx, tx, scope.TenantID, check.sub, check.value, check.billing, check.maint, check.name); err != nil {
				return err
			}
		}
		if _, err = ConsentBilling(ctx, tx, "", subscriber, billing); err == nil {
			return fmt.Errorf("tenant vazio aceito")
		}
		if _, err = ConsentMaintenance(ctx, tx, scope.TenantID, "", billing); err == nil {
			return fmt.Errorf("assinante vazio aceito")
		}
		if _, err = ConsentBilling(ctx, tx, uuid.NewString(), subscriber, billing); err == nil {
			return fmt.Errorf("tenant divergente de app_tenant aceito")
		}
		if err = tx.Exec(ctx, `select set_config('app.subscriber_id', $1, true)`, otherSubscriber); err != nil {
			return err
		}
		if _, err = ConsentBilling(ctx, tx, scope.TenantID, subscriber, billing); err == nil {
			return fmt.Errorf("app_subscriber divergente aceito")
		}
		if err = tx.Exec(ctx, `select set_config('app.subscriber_id', '', true)`); err != nil {
			return err
		}
		var notices int
		if err = tx.QueryRow(ctx, `select count(*) from notice_log where subscriber_id = $1::uuid`, subscriber).Scan(&notices); err != nil {
			return err
		}
		if notices != 0 {
			return fmt.Errorf("consentimento gravou notice_log")
		}
		return errCjConsentRollback
	})
	if !errors.Is(err, errCjConsentRollback) {
		t.Fatal(err)
	}
	cjConsentExpectAbsent(t, opened, scope, subscriber)
	cjConsentExpectAbsent(t, opened, scope, otherSubscriber)
}

func TestCloudConsentOptOutWaitsOrVisible(t *testing.T) {
	opened, scope := cjConsentDatabase(t)
	ctx := context.Background()
	contact, subscriber, value := cjConsentCommitContact(t, opened, scope)
	t.Cleanup(func() { cjConsentDelete(t, opened, scope, subscriber) })
	cjConsentOtherTenantSeesNothing(t, opened, scope, subscriber, value)

	cjConsentExpectBlockedUpdate(t, opened, scope, contact, func(ctx context.Context, tx *db.Tx) error {
		ok, err := ConsentBilling(ctx, tx, scope.TenantID, subscriber, value)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("cobrança sem consentimento na fixture")
		}
		return cjConsentExpectNoInvoiceLock(ctx, tx)
	})
	if !cjConsentAllow(t, opened, scope, contact) {
		t.Fatal("opt-out atravessou o FOR SHARE da cobrança")
	}

	cjConsentExpectBlockedUpdate(t, opened, scope, contact, func(ctx context.Context, tx *db.Tx) error {
		ok, err := ConsentMaintenance(ctx, tx, scope.TenantID, subscriber, value)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("manutenção sem consentimento na fixture")
		}
		return cjConsentExpectNoInvoiceLock(ctx, tx)
	})
	if !cjConsentAllow(t, opened, scope, contact) {
		t.Fatal("opt-out atravessou o FOR SHARE da manutenção")
	}

	if err := cjConsentSetAllow(ctx, opened, scope, contact, false); err != nil {
		t.Fatal(err)
	}
	cjConsentExpectConsent(t, opened, scope, subscriber, value, false, false)
	if err := cjConsentSetAllow(ctx, opened, scope, contact, true); err != nil {
		t.Fatal(err)
	}

	release, held, done := cjConsentHold(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		if err := cjConsentAssume(ctx, tx); err != nil {
			return err
		}
		return tx.Exec(ctx, `update subscriber_contacts set allow_notices = false where id = $1::uuid and tenant_id = app_tenant()`, contact)
	}, false)
	cjConsentWaitHeld(t, held, done)
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(ctx, tx); err != nil {
			return err
		}
		if err := tx.Exec(ctx, `set local lock_timeout = '300ms'`); err != nil {
			return err
		}
		_, err := ConsentBilling(ctx, tx, scope.TenantID, subscriber, value)
		return err
	})
	cjConsentExpectLockTimeout(t, err)
	release()
	cjConsentWaitDone(t, done, false)
	cjConsentExpectConsent(t, opened, scope, subscriber, value, false, false)
}

func cjConsentExpect(ctx context.Context, tx *db.Tx, tenant, subscriber, value string, billing, maint bool, name string) error {
	gotBilling, err := ConsentBilling(ctx, tx, tenant, subscriber, value)
	if err != nil {
		return fmt.Errorf("%s cobrança: %w", name, err)
	}
	gotMaint, err := ConsentMaintenance(ctx, tx, tenant, subscriber, value)
	if err != nil {
		return fmt.Errorf("%s manutenção: %w", name, err)
	}
	if gotBilling != billing || gotMaint != maint {
		return fmt.Errorf("%s: cobrança %v manutenção %v", name, gotBilling, gotMaint)
	}
	return nil
}

func cjConsentExpectConsent(t *testing.T, opened *db.DB, scope tenancy.Scope, subscriber, value string, billing, maint bool) {
	t.Helper()
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(context.Background(), tx); err != nil {
			return err
		}
		return cjConsentExpect(context.Background(), tx, scope.TenantID, subscriber, value, billing, maint, "depois do opt-out")
	})
	if err != nil {
		t.Fatal(err)
	}
}

func cjConsentOtherTenantSeesNothing(t *testing.T, opened *db.DB, scope tenancy.Scope, subscriber, value string) {
	t.Helper()
	ctx := context.Background()
	var other string
	err := opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select coalesce((select tenant_id::text from nexo_go_directory() where tenant_id::text <> $1 order by tenant_id limit 1), '')`, scope.TenantID).Scan(&other)
	})
	if err != nil {
		t.Fatal(err)
	}
	if other == "" {
		return
	}
	err = opened.WithScope(ctx, tenancy.Scope{TenantID: other}, func(tx *db.Tx) error {
		if err := cjConsentAssume(ctx, tx); err != nil {
			return err
		}
		billing, err := ConsentBilling(ctx, tx, other, subscriber, value)
		if err != nil {
			return err
		}
		maint, err := ConsentMaintenance(ctx, tx, other, subscriber, value)
		if err != nil {
			return err
		}
		if billing || maint {
			return fmt.Errorf("outro tenant enxergou o contato")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func cjConsentExpectBlockedUpdate(t *testing.T, opened *db.DB, scope tenancy.Scope, contact string, read func(context.Context, *db.Tx) error) {
	t.Helper()
	release, held, done := cjConsentHold(t, opened, scope, func(ctx context.Context, tx *db.Tx) error {
		if err := cjConsentAssume(ctx, tx); err != nil {
			return err
		}
		return read(ctx, tx)
	}, true)
	cjConsentWaitHeld(t, held, done)
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(context.Background(), tx); err != nil {
			return err
		}
		if err := tx.Exec(context.Background(), `set local lock_timeout = '300ms'`); err != nil {
			return err
		}
		return tx.Exec(context.Background(), `update subscriber_contacts set allow_notices = false where id = $1::uuid and tenant_id = app_tenant()`, contact)
	})
	cjConsentExpectLockTimeout(t, err)
	release()
	cjConsentWaitDone(t, done, true)
}

func cjConsentExpectLockTimeout(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
		t.Fatalf("a outra transação não aguardou o lock: %v", err)
	}
}

func cjConsentExpectNoInvoiceLock(ctx context.Context, tx *db.Tx) error {
	var n int
	if err := tx.QueryRow(ctx, `select count(*) from pg_locks where pid = pg_backend_pid() and (locktype = 'advisory' or relation = 'invoices'::regclass)`).Scan(&n); err != nil {
		return err
	}
	if n != 0 {
		return fmt.Errorf("helper adquiriu lock de fatura ou advisory")
	}
	return nil
}

func cjConsentHold(t *testing.T, opened *db.DB, scope tenancy.Scope, fn func(context.Context, *db.Tx) error, rollback bool) (func(), <-chan struct{}, <-chan error) {
	t.Helper()
	releaseCh := make(chan struct{})
	held := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			if err := fn(context.Background(), tx); err != nil {
				return err
			}
			close(held)
			<-releaseCh
			if rollback {
				return errCjConsentRollback
			}
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
	return release, held, done
}

func cjConsentWaitHeld(t *testing.T, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("transação de consentimento não segurou o contato")
	}
}

func cjConsentWaitDone(t *testing.T, done <-chan error, rollback bool) {
	t.Helper()
	select {
	case err := <-done:
		if rollback {
			if !errors.Is(err, errCjConsentRollback) {
				t.Fatal(err)
			}
			return
		}
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("transação de consentimento não encerrou")
	}
}

func cjConsentCommitContact(t *testing.T, opened *db.DB, scope tenancy.Scope) (contact, subscriber, value string) {
	t.Helper()
	value = cjConsentPhone("lock")
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(context.Background(), tx); err != nil {
			return err
		}
		var err error
		subscriber, err = cjConsentInsertSubscriber(context.Background(), tx, "cjConsent lock")
		if err != nil {
			return err
		}
		contact, err = cjConsentInsertContact(context.Background(), tx, subscriber, "mobile", value, "billing", true)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return contact, subscriber, value
}

func cjConsentDelete(t *testing.T, opened *db.DB, scope tenancy.Scope, subscriber string) {
	t.Helper()
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(context.Background(), tx); err != nil {
			return err
		}
		if err := tx.Exec(context.Background(), `delete from subscriber_contacts where subscriber_id = $1::uuid and tenant_id = app_tenant()`, subscriber); err != nil {
			return err
		}
		return tx.Exec(context.Background(), `delete from subscribers where id = $1::uuid and tenant_id = app_tenant()`, subscriber)
	})
	if err != nil {
		t.Errorf("limpeza cjConsent: %v", err)
	}
}

func cjConsentSetAllow(ctx context.Context, opened *db.DB, scope tenancy.Scope, contact string, allow bool) error {
	return opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(ctx, tx); err != nil {
			return err
		}
		return tx.Exec(ctx, `update subscriber_contacts set allow_notices = $2 where id = $1::uuid and tenant_id = app_tenant()`, contact, allow)
	})
}

func cjConsentAllow(t *testing.T, opened *db.DB, scope tenancy.Scope, contact string) bool {
	t.Helper()
	var allow bool
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(context.Background(), tx); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(), `select allow_notices from subscriber_contacts where id = $1::uuid and tenant_id = app_tenant()`, contact).Scan(&allow)
	})
	if err != nil {
		t.Fatal(err)
	}
	return allow
}

func cjConsentExpectAbsent(t *testing.T, opened *db.DB, scope tenancy.Scope, subscriber string) {
	t.Helper()
	var n int
	err := opened.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		if err := cjConsentAssume(context.Background(), tx); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(), `select count(*) from subscribers where id = $1::uuid and tenant_id = app_tenant()`, subscriber).Scan(&n)
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("rollback deixou assinante %s", subscriber)
	}
}

func cjConsentInsertSubscriber(ctx context.Context, tx *db.Tx, name string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status) values (app_tenant(), $1, 'active') returning id::text`, name).Scan(&id)
	return id, err
}

func cjConsentInsertContact(ctx context.Context, tx *db.Tx, subscriber, kind, value, purpose string, allow bool) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, purpose, allow_notices) values (app_tenant(), $1::uuid, $2, $3, $4, $5) returning id::text`, subscriber, kind, value, purpose, allow).Scan(&id)
	return id, err
}

func cjConsentPhone(tag string) string {
	compact := strings.ReplaceAll(uuid.NewString(), "-", "")
	return "cj" + tag + compact[:12]
}

func cjConsentDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_CLOUD_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_CLOUD_PG_REQUIRED=1; o lock não executou e PostgreSQL não está aprovado")
		}
		t.Skip(cjConsentSkip)
	}
	if err := cjConsentRejectLabURL(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	opened, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("db.Open falhou com URL presente; skip não se aplica: %v", cjConsentRedact(err))
	}
	t.Cleanup(opened.Close)
	var name, sessionUser, currentUser, tenant string
	if err = opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatalf("identidade do laboratório: %v", cjConsentRedact(err))
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" || tenant == "" {
		t.Fatalf("conexão fora de nexo_test/nexo_go: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	return opened, tenancy.Scope{TenantID: tenant}
}

func cjConsentAssume(ctx context.Context, tx *db.Tx) error {
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

func cjConsentRejectLabURL(raw string) error {
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return fmt.Errorf("URL de laboratório inválida")
	}
	if cfg.User != "nexo_go" || cfg.Database != "nexo_test" {
		return fmt.Errorf("URL recusada; este pacote só usa nexo_go em nexo_test")
	}
	return nil
}

func cjConsentRedact(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if url := os.Getenv("NEXO_GO_TEST_DATABASE_URL"); url != "" {
		text = strings.ReplaceAll(text, url, "NEXO_GO_TEST_DATABASE_URL")
	}
	return text
}
