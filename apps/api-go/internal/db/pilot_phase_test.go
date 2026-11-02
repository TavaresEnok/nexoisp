package db

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestPilotPhaseChecks(t *testing.T) {
	ownerDSN := os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if ownerDSN == "" {
		if os.Getenv("PG_REQUIRED") == "1" {
			t.Fatal("PG_REQUIRED=1 exige NEXO_GO_TEST_DATABASE_OWNER_URL")
		}
		t.Skip("URL do PostgreSQL descartável ausente; SKIP não comprova SQL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := sql.Open("pgx", ownerDSN)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	var name string
	if err = c.QueryRowContext(ctx, `select current_database()`).Scan(&name); err != nil || name != "nexo_test" {
		t.Fatal("somente nexo_test", name, err)
	}
	exec := func(q string) {
		t.Helper()
		if _, err := c.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// Provedor sem linha em tenant_settings usa os padrões (tudo desligado); o teste cria uma para poder desviar.
	exec(`create temp table pilot_settings_created as with x as (insert into tenant_settings (tenant_id) select id from tenants on conflict do nothing returning tenant_id) select tenant_id from x`)
	t.Cleanup(func() {
		_, _ = c.ExecContext(context.Background(), `delete from tenant_settings where tenant_id in (select tenant_id from pilot_settings_created)`)
	})
	exec(`create temp table pilot_settings_backup as select tenant_id, gateway, billing_auto, auto_suspend, suspend_after_days, auto_resume_on_payment from tenant_settings`)
	exec(`create temp table pilot_channels_backup as select id from notice_channels where active union all select id from cloud_accounts where active`)
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = c.ExecContext(ctx, `update tenant_settings s set gateway=b.gateway, billing_auto=b.billing_auto, auto_suspend=b.auto_suspend, suspend_after_days=b.suspend_after_days, auto_resume_on_payment=b.auto_resume_on_payment from pilot_settings_backup b where b.tenant_id=s.tenant_id`)
		_, _ = c.ExecContext(ctx, `update notice_channels set active=true where id in (select id from pilot_channels_backup)`)
		_, _ = c.ExecContext(ctx, `update cloud_accounts set active=true where id in (select id from pilot_channels_backup)`)
	})
	run := func() []string {
		t.Helper()
		failed := []string{}
		err := pilotPhaseChecks(ctx, c, func(ok, warn bool, name string) {
			if warn {
				t.Fatalf("checagem do piloto deveria reprovar, não avisar: %s", name)
			}
			if !ok {
				failed = append(failed, name)
			}
		})
		if err != nil {
			t.Fatal(err)
		}
		return failed
	}

	exec(`update tenant_settings set gateway='none', billing_auto=false, auto_suspend=false, suspend_after_days=null, auto_resume_on_payment=false`)
	exec(`update notice_channels set active=false`)
	exec(`update cloud_accounts set active=false`)
	if failed := run(); len(failed) != 0 {
		t.Fatalf("configuração da fase 1 reprovada: %v", failed)
	}

	for _, deviation := range []struct{ sql, want string }{
		{`update tenant_settings set gateway='demo' where tenant_id=(select min(tenant_id::text)::uuid from tenant_settings)`, "sem gateway"},
		{`update tenant_settings set billing_auto=true where tenant_id=(select min(tenant_id::text)::uuid from tenant_settings)`, "geração automática"},
		{`update tenant_settings set auto_suspend=true, suspend_after_days=5 where tenant_id=(select min(tenant_id::text)::uuid from tenant_settings)`, "suspensão automática"},
		{`update tenant_settings set auto_resume_on_payment=true where tenant_id=(select min(tenant_id::text)::uuid from tenant_settings)`, "reativação automática"},
		{`insert into notice_channels (tenant_id, name, url) select min(tenant_id::text)::uuid, 'canal-piloto-teste', 'https://exemplo.invalid/aviso' from tenant_settings`, "canal de aviso"},
	} {
		exec(deviation.sql)
		failed := run()
		if len(failed) != 1 || !strings.Contains(failed[0], deviation.want) {
			t.Fatalf("%q: reprovações %v", deviation.want, failed)
		}
		exec(`update tenant_settings set gateway='none', billing_auto=false, auto_suspend=false, suspend_after_days=null, auto_resume_on_payment=false`)
		exec(`delete from notice_channels where name='canal-piloto-teste'`)
	}
}
