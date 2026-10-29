package outbound

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/tenancy"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
)

const noticeLockSkip = "NEXO_GO_TEST_DATABASE_URL ausente; este skip não é teste de banco aprovado. A gerência precisa executar tests/contrato/nativo.py e tests/contrato/go_integration.py num PostgreSQL descartável antes de publicar"

const noticeAdvisorySalt int64 = 7411005

var errNoticeRollback = errors.New("rollback do teste de avisos")

func TestNoticeEnqueueLockOrderRollbackAndCanceled(t *testing.T) {
	d, scope := openNoticeDatabase(t)
	ctx := context.Background()
	fx := seedNoticeRace(t, d, scope)

	t.Run("rival waits and rollback writes nothing", func(t *testing.T) {
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if _, err := enqueueNotices(ctx, tx, scope.TenantID, true, map[string]any{"sent": 0, "failed": 0, "skipped": 0}); err != nil {
				return err
			}
			rival := make(chan error, 1)
			go func() {
				rival <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
					if err := tx.Exec(ctx, `select set_config('lock_timeout', '400ms', true)`); err != nil {
						return err
					}
					return finance.LockInvoices(ctx, tx, scope.TenantID, fx.high, fx.mid, fx.low)
				})
			}()
			err := <-rival
			var pg *pgconn.PgError
			if !errors.As(err, &pg) || pg.Code != "55P03" {
				return fmt.Errorf("rival não esperou o protocolo das faturas: %w", err)
			}
			return errNoticeRollback
		})
		if !errors.Is(err, errNoticeRollback) {
			t.Fatal(err)
		}
		if n := noticeCount(t, d, scope, fx.ids()); n != 0 {
			t.Fatalf("rollback deixou %d avisos", n)
		}
	})

	t.Run("lower invoice blocks before the higher one is locked", func(t *testing.T) {
		release, held, holderDone := holdNoticeLocks(t, d, scope, func(ctx context.Context, tx *db.Tx) error {
			return finance.LockInvoices(ctx, tx, scope.TenantID, fx.low)
		})
		defer release()
		waitNoticeHeld(t, held, holderDone)
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		done := make(chan error, 1)
		go func() {
			done <- d.WithScope(runCtx, scope, func(tx *db.Tx) error {
				_, err := enqueueNotices(runCtx, tx, scope.TenantID, true, map[string]any{"sent": 0, "failed": 0, "skipped": 0})
				return err
			})
		}()
		if err := waitNoticeAdvisory(ctx, d, scope, fx.low); err != nil {
			t.Fatal(err)
		}
		err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			if err := tx.Exec(ctx, `select set_config('lock_timeout', '200ms', true)`); err != nil {
				return err
			}
			if _, err := tx.Objects(ctx, `select id::text as id from invoices where id = $1::uuid for update nowait`, fx.high); err != nil {
				return err
			}
			return errNoticeRollback
		})
		if !errors.Is(err, errNoticeRollback) {
			t.Fatalf("a fatura maior foi travada antes da menor: %v", err)
		}
		if n := noticeCount(t, d, scope, []string{fx.high}); n != 0 {
			t.Fatalf("aviso da fatura maior gravado enquanto a menor ainda espera: %d", n)
		}
		cancel()
		select {
		case err := <-done:
			if err == nil {
				t.Fatal("o enfileiramento interrompido commitou")
			}
		case <-time.After(8 * time.Second):
			t.Fatal("enfileiramento não interrompeu a espera")
		}
		if n := noticeCount(t, d, scope, fx.ids()); n != 0 {
			t.Fatalf("cancelamento do enfileiramento deixou %d avisos", n)
		}
		release()
		if err := <-holderDone; !errors.Is(err, errNoticeRollback) {
			t.Fatal(err)
		}
	})

	t.Run("canceled after the wait is skipped and consent stays", func(t *testing.T) {
		blocked := make(chan struct{})
		release := make(chan struct{})
		holderErr := make(chan error, 1)
		go func() {
			holderErr <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
				if err := finance.LockInvoices(ctx, tx, scope.TenantID, fx.low, fx.paid, fx.mid, fx.high); err != nil {
					return err
				}
				close(blocked)
				<-release
				if err := tx.Exec(ctx, `update invoices set status = 'canceled', canceled_at = now() where id = $1::uuid and status = 'open'`, fx.high); err != nil {
					return err
				}
				var due int
				if err := tx.QueryRow(ctx, `select (amount_cents + fee_cents - discount_cents)::int from invoices where id = $1::uuid`, fx.paid).Scan(&due); err != nil {
					return err
				}
				_, err := tx.Affected(ctx, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source)
					values ($1::uuid, $2::uuid, $3, now(), 'cash', 'manual')`, scope.TenantID, fx.paid, due)
				return err
			})
		}()
		select {
		case <-blocked:
		case err := <-holderErr:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("o detentor não travou as faturas")
		}
		out := map[string]any{"sent": 0, "failed": 0, "skipped": 0}
		done := make(chan error, 1)
		go func() {
			done <- d.WithScope(ctx, scope, func(tx *db.Tx) error {
				_, err := enqueueNotices(ctx, tx, scope.TenantID, true, out)
				return err
			})
		}()
		if err := waitNoticeAdvisory(ctx, d, scope, fx.low); err != nil {
			t.Fatal(err)
		}
		fx.late = "11111111-1111-4111-8111-" + fmt.Sprintf("%012x", time.Now().UnixNano()%0x1000000000000)
		if err := insertNoticeParty(ctx, d, scope, fx.tag, fx.late, "Tarde Aviso", "", 8000, true); err != nil {
			t.Fatal(err)
		}
		close(release)
		if err := <-holderErr; err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if got := noticeStatus(t, d, scope, fx.high); got != "" {
			t.Fatalf("fatura cancelada durante a espera recebeu aviso %q", got)
		}
		if got := noticeStatus(t, d, scope, fx.paid); got != "" {
			t.Fatalf("fatura quitada durante a espera recebeu aviso %q", got)
		}
		if got := noticeStatus(t, d, scope, fx.low); got != "queued" {
			t.Fatalf("fatura em aberto com consentimento ficou %q", got)
		}
		if got := noticeStatus(t, d, scope, fx.mid); got != "skipped_no_consent,skipped_no_consent" {
			t.Fatalf("fatura sem consentimento ficou %q", got)
		}
		if got := noticeStatus(t, d, scope, fx.late); got != "" {
			t.Fatalf("fatura surgida durante a espera, fora do conjunto travado, recebeu aviso %q", got)
		}
		// Duas regras de days_relative=0 compartilham a etiqueta. skipped_no_consent
		// não entra na exclusão por assinante, então mid gera uma linha por regra.
		if out["skipped"] != 2 || out["sent"] != 0 || out["failed"] != 0 {
			t.Fatalf("contadores = %#v", out)
		}
		msg := noticeMessage(t, d, scope, fx.low)
		if msg == "" || !strings.Contains(msg, "R$ 80,00") {
			t.Fatalf("mensagem não relida sob o lock: %q", msg)
		}
		again := map[string]any{"sent": 0, "failed": 0, "skipped": 0}
		if err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
			_, err := enqueueNotices(ctx, tx, scope.TenantID, true, again)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if noticeCount(t, d, scope, []string{fx.low, fx.mid, fx.high, fx.paid}) != 3 || again["skipped"] != 0 {
			t.Fatalf("deduplicação não segurou a segunda passagem: avisos=%d contador=%#v", noticeCount(t, d, scope, []string{fx.low, fx.mid, fx.high, fx.paid}), again)
		}
		if got := noticeStatus(t, d, scope, fx.late); got != "queued" {
			t.Fatalf("a fatura tardia, já visível antes do lock da segunda execução, ficou %q", got)
		}
	})
}

type noticeRace struct {
	low, mid, high, paid, late, tag string
}

func (f noticeRace) ids() []string {
	ids := []string{f.low, f.mid, f.high, f.paid}
	if f.late != "" {
		ids = append(ids, f.late)
	}
	return ids
}

func seedNoticeRace(t *testing.T, d *db.DB, scope tenancy.Scope) *noticeRace {
	t.Helper()
	ctx := context.Background()
	suffix := fmt.Sprintf("%012x", time.Now().UnixNano()%0x1000000000000)
	fx := &noticeRace{
		low:  "00000000-0000-4000-8000-" + suffix[:10] + "01",
		paid: "40000000-0000-4000-8000-" + suffix[:10] + "02",
		mid:  "80000000-0000-4000-8000-" + suffix[:10] + "03",
		high: "ffffffff-ffff-4fff-8fff-" + suffix[:10] + "04",
	}
	var restored []string
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, `update notice_rules set active = false where active returning id::text as id`)
		if err != nil {
			return err
		}
		for _, row := range rows {
			restored = append(restored, row.Get("id").(string))
		}
		var today, yesterday string
		if err = tx.QueryRow(ctx, `select (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date::text,
			((now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date - 1)::text`).Scan(&today, &yesterday); err != nil {
			return err
		}
		var base string
		if err = tx.QueryRow(ctx, `select k.id::text from contracts k
			join subscribers s on s.id = k.subscriber_id and s.tenant_id = k.tenant_id
			join plan_versions pv on pv.id = k.plan_version_id
			join plans pl on pl.id = pv.plan_id
			where k.status = 'active' and s.status = 'active'
			order by k.id limit 1`).Scan(&base); err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `insert into tags (tenant_id, name) values (app_tenant(), $1) returning id::text`, "etiq "+suffix[:8]).Scan(&fx.tag); err != nil {
			return err
		}
		parties := []struct {
			invoice, name, due string
			cents              int
			consent            bool
		}{
			{fx.low, "Ana Aviso", today, 8000, true},
			{fx.paid, "Caio Aviso", today, 8000, true},
			{fx.mid, "Sem Consentimento", today, 8000, false},
			{fx.high, "Bia Aviso", yesterday, 9000, true},
		}
		for _, p := range parties {
			if err = insertNoticePartyTx(ctx, tx, base, fx.tag, p.invoice, p.name, p.due, p.cents, p.consent); err != nil {
				return err
			}
		}
		var channel, template string
		if err = tx.QueryRow(ctx, `insert into notice_channels (tenant_id, name, url)
			values (app_tenant(), $1, 'https://example.com/nexo-aviso-lock') returning id::text`, "canal "+suffix[:8]).Scan(&channel); err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `insert into notice_templates (tenant_id, name, body)
			values (app_tenant(), $1, 'Olá {nome}, valor {valor}, vence {vencimento}.') returning id::text`, "modelo "+suffix[:8]).Scan(&template); err != nil {
			return err
		}
		for i, rel := range []int{1, 0, 0} {
			if err = tx.Exec(ctx, `insert into notice_rules
				(tenant_id, name, template_id, channel_id, days_relative, tag_id, hour_from, hour_to, weekdays, min_interval_days, active)
				values (app_tenant(), $1, $2::uuid, $3::uuid, $4, $5::uuid, 0, 24, '{0,1,2,3,4,5,6}', 1, true)`,
				fmt.Sprintf("regra %s %d", suffix[:8], i), template, channel, rel, fx.tag); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			_, _ = tx.Affected(context.Background(), `delete from notice_log where invoice_id = any($1::uuid[])`, fx.ids())
			_, _ = tx.Affected(context.Background(), `delete from notice_rules where name like $1`, "regra "+suffix[:8]+"%")
			_, _ = tx.Affected(context.Background(), `delete from notice_templates where name = $1`, "modelo "+suffix[:8])
			_, _ = tx.Affected(context.Background(), `delete from notice_channels where name = $1`, "canal "+suffix[:8])
			_, _ = tx.Affected(context.Background(), `delete from contract_tags where tag_id = $1::uuid`, fx.tag)
			_, _ = tx.Affected(context.Background(), `delete from tags where id = $1::uuid`, fx.tag)
			_, _ = tx.Affected(context.Background(), `update invoices set status = 'canceled', canceled_at = now() where id = any($1::uuid[]) and status = 'open'`, fx.ids())
			if len(restored) > 0 {
				_, _ = tx.Affected(context.Background(), `update notice_rules set active = true where id = any($1::uuid[])`, restored)
			}
			return nil
		})
	})
	return fx
}

func insertNoticeParty(ctx context.Context, d *db.DB, scope tenancy.Scope, tag, invoice, name, due string, cents int, consent bool) error {
	return d.WithScope(ctx, scope, func(tx *db.Tx) error {
		var base string
		if err := tx.QueryRow(ctx, `select k.id::text from contracts k
			join subscribers s on s.id = k.subscriber_id and s.tenant_id = k.tenant_id
			where k.status = 'active' and s.status = 'active'
			order by k.id limit 1`).Scan(&base); err != nil {
			return err
		}
		if due == "" {
			if err := tx.QueryRow(ctx, `select (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date::text`).Scan(&due); err != nil {
				return err
			}
		}
		return insertNoticePartyTx(ctx, tx, base, tag, invoice, name, due, cents, consent)
	})
}

func insertNoticePartyTx(ctx context.Context, tx *db.Tx, base, tag, invoice, name, due string, cents int, consent bool) error {
	var subscriber, contract string
	if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name, status)
		select tenant_id, $2, 'active' from contracts where id = $1 returning id::text`, base, name).Scan(&subscriber); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, status, due_day, start_date, pop_id)
		select tenant_id, $2, plan_version_id, 'active', due_day, start_date, pop_id from contracts where id = $1 returning id::text`, base, subscriber).Scan(&contract); err != nil {
		return err
	}
	if err := tx.Exec(ctx, `insert into invoices (id, tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents)
		select $3::uuid, tenant_id, id, $2::uuid, 'manual', $4::date, $5 from contracts where id = $1`, contract, subscriber, invoice, due, cents); err != nil {
		return err
	}
	if err := tx.Exec(ctx, `insert into contract_tags (tenant_id, contract_id, tag_id) values (app_tenant(), $1::uuid, $2::uuid)`, contract, tag); err != nil {
		return err
	}
	if !consent {
		return nil
	}
	return tx.Exec(ctx, `insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, purpose, allow_notices)
		values (app_tenant(), $1::uuid, 'mobile', '11988887777', 'billing', true)`, subscriber)
}

func openNoticeDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip(noticeLockSkip)
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var name, tenant string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database()`).Scan(&name); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatal(err)
	}
	if name != "nexo_test" {
		t.Fatalf("banco %s recusado; só o laboratório descartável nexo_test pode executar o teste de avisos", name)
	}
	return d, tenancy.Scope{TenantID: tenant}
}

func noticeCount(t *testing.T, d *db.DB, scope tenancy.Scope, ids []string) int {
	t.Helper()
	var n int
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select count(*) from notice_log where invoice_id = any($1::uuid[])`, ids).Scan(&n)
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func noticeStatus(t *testing.T, d *db.DB, scope tenancy.Scope, id string) string {
	t.Helper()
	var status string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select coalesce(string_agg(status, ',' order by status), '') from notice_log where invoice_id = $1::uuid`, id).Scan(&status)
	})
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func noticeMessage(t *testing.T, d *db.DB, scope tenancy.Scope, id string) string {
	t.Helper()
	var message string
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select coalesce(message, '') from notice_log where invoice_id = $1::uuid and status = 'queued' limit 1`, id).Scan(&message)
	})
	if err != nil {
		t.Fatal(err)
	}
	return message
}

func holdNoticeLocks(t *testing.T, d *db.DB, scope tenancy.Scope, fn func(context.Context, *db.Tx) error) (func(), <-chan struct{}, <-chan error) {
	t.Helper()
	releaseCh := make(chan struct{})
	held := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			if err := fn(context.Background(), tx); err != nil {
				return err
			}
			close(held)
			<-releaseCh
			return errNoticeRollback
		})
	}()
	return func() {
		select {
		case <-releaseCh:
		default:
			close(releaseCh)
		}
	}, held, done
}

func waitNoticeHeld(t *testing.T, held <-chan struct{}, done <-chan error) {
	t.Helper()
	select {
	case <-held:
	case err := <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("lock não adquirido")
	}
}

func waitNoticeAdvisory(ctx context.Context, d *db.DB, scope tenancy.Scope, id string) error {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	key := scope.TenantID + ":invoice:" + id
	for {
		if err := wait.Err(); err != nil {
			return fmt.Errorf("enfileiramento não esperou o advisory %s: %w", id, err)
		}
		var n int
		err := d.WithScope(wait, scope, func(tx *db.Tx) error {
			return tx.QueryRow(wait, `select count(*) from pg_locks
				where locktype = 'advisory' and not granted
				  and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, $2)`, key, noticeAdvisorySalt).Scan(&n)
		})
		if err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		timer := time.NewTimer(2 * time.Millisecond)
		select {
		case <-wait.Done():
			timer.Stop()
			return fmt.Errorf("enfileiramento não esperou o advisory %s", id)
		case <-timer.C:
		}
	}
}
