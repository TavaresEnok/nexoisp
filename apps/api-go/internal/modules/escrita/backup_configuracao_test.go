package escrita

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/tenancy"
)

// Backup semanal de configuração contra PostgreSQL real: agenda do agente, 4 cópias, falha, pedido manual,
// texto cifrado, comparação e permissões.
func TestConfigBackupsPG(t *testing.T) {
	d := templateTestDB(t, "NEXO_CONFIG_BACKUP_PG_REQUIRED")
	ctx := context.Background()
	if os.Getenv("NEXO_SECRET_KEY") == "" {
		t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("c", 32))))
	}
	t.Setenv("NEXO_GO_JOBS", "0")
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	type tenantIDs struct{ id, admin, pop, agent, olt, off, integrated string }
	mk := func() tenantIDs {
		x := tenantIDs{id: lateTenantID()}
		if err := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste backup de configuração',$2)`, x.id, "cfg-"+strings.ReplaceAll(x.id, "-", "")[:20])
		}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = d.WithScope(ctx, op, func(tx *db.Tx) error { return tx.Exec(ctx, `update tenants set status='suspended' where id=$1`, x.id) })
		})
		if err := d.WithScope(ctx, tenancy.Scope{TenantID: x.id}, func(tx *db.Tx) error {
			for _, s := range []struct {
				sql  string
				args []any
				dest *string
			}{
				{`insert into users(tenant_id,email,name,password_hash,role) values(app_tenant(),$1,'Admin backup','!','admin') returning id::text`, []any{uuid.NewString() + "@example.invalid"}, &x.admin},
				{`insert into pops(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"POP " + mark}, &x.pop},
				{`insert into agents(tenant_id,name,token_hash,version) values(app_tenant(),$1,$2,'0.6.6') returning id::text`, []any{"Agente " + mark, uuid.NewString()}, &x.agent},
			} {
				if e := tx.QueryRow(ctx, s.sql, s.args...).Scan(s.dest); e != nil {
					return e
				}
			}
			for _, s := range []struct {
				name, driver string
				agent        any
				dest         *string
			}{{"OLT " + mark, "olt_huawei", x.agent, &x.olt}, {"NAS desligado " + mark, "mikrotik_radius", x.agent, &x.off}, {"RADIUS " + mark, "radius", nil, &x.integrated}} {
				if e := tx.QueryRow(ctx, `insert into devices(tenant_id,name,driver,agent_id,vendor) values(app_tenant(),$1,$2,$3,case when $2 = 'radius' then 'mikrotik' end) returning id::text`, s.name, s.driver, s.agent).Scan(s.dest); e != nil {
					return e
				}
			}
			return tx.Exec(ctx, `update devices set config_backup = false where id = $1`, x.off)
		}); err != nil {
			t.Fatal(err)
		}
		return x
	}
	a, b := mk(), mk()
	inA := func(run func(tx *db.Tx) error) {
		t.Helper()
		if err := d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, run); err != nil {
			t.Fatal(err)
		}
	}
	schedule := func() []jsonx.Object {
		t.Helper()
		var out []jsonx.Object
		inA(func(tx *db.Tx) error { var e error; out, e = network.ConfigBackupSchedule(ctx, tx, a.agent); return e })
		return out
	}
	save := func(body map[string]any) map[string]any {
		t.Helper()
		var out map[string]any
		inA(func(tx *db.Tx) error { var e error; out, e = network.SaveConfigBackup(ctx, tx, a.id, a.olt, body); return e })
		return out
	}
	age := func(days int) { // "envelhece" as cópias para simular semanas
		inA(func(tx *db.Tx) error {
			return tx.Exec(ctx, `update config_backups set taken_at = taken_at - make_interval(days => $2) where device_id = $1`, a.olt, days)
		})
	}
	dueOf := func(v any) time.Time {
		t.Helper()
		tm, ok := v.(jsonx.Time)
		if !ok {
			t.Fatalf("data de vencimento inesperada: %T %v", v, v)
		}
		return tm.Time
	}

	// Agenda: só a OLT com agente e backup ligado; primeiro backup vence na hora.
	s := schedule()
	if len(s) != 1 || s[0].Get("device_id") != a.olt || s[0].Get("manual") != false || time.Until(dueOf(s[0].Get("due_at"))) > time.Minute {
		t.Fatalf("agenda inicial: %v", s)
	}

	// Seis semanas de backups: ficam só 4; "changed" compara com a cópia anterior ignorando a data do cabeçalho.
	configs := []string{"# 2026-01-01 by RouterOS 7\n/system identity\nset name=A\n", "# 2026-01-08 by RouterOS 7\n/system identity\nset name=A\n",
		"/system identity\nset name=B\n", "/system identity\nset name=B\n/ip dns\nset servers=192.0.2.53\n", "/system identity\nset name=C\n/ip dns\nset servers=192.0.2.53\n", "/system identity\nset name=C\n/ip dns\nset servers=192.0.2.53\n"}
	var last map[string]any
	for i, c := range configs {
		if i > 0 {
			age(7)
		}
		last = save(map[string]any{"ok": true, "content": c})
		if next := dueOf(last["next_due_at"]); next.Sub(time.Now()) < 6*24*time.Hour+23*time.Hour {
			t.Fatalf("próximo backup deveria vencer em 7 dias: %v", next)
		}
	}
	var kept []jsonx.Object
	inA(func(tx *db.Tx) error {
		var e error
		kept, e = tx.Objects(ctx, `select changed, trigger, content_enc from config_backups where device_id = $1 order by taken_at`, a.olt)
		return e
	})
	if len(kept) != network.ConfigBackupKeep {
		t.Fatalf("deveriam ficar %d cópias, ficaram %d", network.ConfigBackupKeep, len(kept))
	}
	if got := fmt.Sprint(kept[0].Get("changed"), kept[1].Get("changed"), kept[2].Get("changed"), kept[3].Get("changed")); got != "true true true false" {
		t.Fatalf("changed: %s", got)
	}
	for _, k := range kept {
		if strings.Contains(k.Get("content_enc").(string), "identity") {
			t.Fatal("configuração gravada em claro")
		}
	}

	// Desligado: o envio de um agente é ignorado.
	var ignored map[string]any
	inA(func(tx *db.Tx) error {
		var e error
		ignored, e = network.SaveConfigBackup(ctx, tx, a.id, a.off, map[string]any{"ok": true, "content": "x"})
		return e
	})
	if ignored["ignored"] != true {
		t.Fatalf("equipamento com backup desligado: %v", ignored)
	}

	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user string, pops []string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: user, TenantID: tenant, Role: role, PopIDs: pops, Permissions: auth.Permissions[role], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, PopIDs: pops}}
	}
	add("a", a.id, "admin", a.admin, nil)
	add("b", b.id, "admin", b.admin, nil)
	add("pop", a.id, "noc", a.admin, []string{a.pop})
	add("finance", a.id, "finance", a.admin, nil)
	h := templateHarness{t, templateRouter(t, d, actors, func(api huma.API, r *endpoint.Registry, s Service) { registerConfigBackups(api, r, s) })}

	list := h.call("a", "GET", "/api/devices/"+a.olt+"/config-backups", nil, 200)
	items := list["items"].([]any)
	if len(items) != 4 || list["keep"] != float64(4) || list["device"].(map[string]any)["supported"] != true {
		t.Fatalf("lista: %v", list["_raw"])
	}
	if strings.Contains(list["_raw"].(string), "content") {
		t.Fatal("a lista não deve trazer o conteúdo")
	}
	newest, oldest := items[0].(map[string]any)["id"].(string), items[3].(map[string]any)["id"].(string)
	h.call("b", "GET", "/api/devices/"+a.olt+"/config-backups", nil, 404)
	h.call("b", "GET", "/api/config-backups/"+newest, nil, 404)
	h.call("pop", "GET", "/api/config-backups/"+newest, nil, 403)
	h.call("finance", "GET", "/api/devices/"+a.olt+"/config-backups", nil, 403)

	got := h.call("a", "GET", "/api/config-backups/"+newest, nil, 200)
	if got["content"] != configs[5] || got["content_enc"] != nil {
		t.Fatalf("conteúdo: %v", got["_raw"])
	}
	diff := h.call("a", "GET", "/api/config-backups/"+items[1].(map[string]any)["id"].(string)+"/diff", nil, 200)
	if diff["added"] != float64(1) || diff["removed"] != float64(1) || !strings.Contains(diff["_raw"].(string), "set name=C") {
		t.Fatalf("diff: %v", diff["_raw"])
	}
	h.call("a", "GET", "/api/config-backups/"+oldest+"/diff", nil, 409)
	var audits int
	inA(func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select count(*) from audit_events where action in ('config_backup.view','config_backup.diff') and entity_id = $1`, a.olt).Scan(&audits)
	})
	if audits != 2 {
		t.Fatalf("abertura e comparação deveriam ficar na auditoria: %d", audits)
	}

	// Pedido pelo painel: vence na hora e o próximo envio conta como manual; falha registra o erro e libera o pedido.
	h.call("a", "POST", "/api/devices/"+a.integrated+"/config-backups", nil, 400)
	h.call("a", "POST", "/api/devices/"+a.off+"/config-backups", nil, 400)
	h.call("a", "POST", "/api/devices/"+a.olt+"/config-backups", nil, 200)
	s = schedule()
	if s[0].Get("manual") != true || time.Until(dueOf(s[0].Get("due_at"))) > 0 {
		t.Fatalf("pedido manual: %v", s)
	}
	failed := save(map[string]any{"ok": false, "error": "SSH host key is absent from the configured trust file"})
	if next := dueOf(failed["next_due_at"]); time.Until(next) < 5*time.Hour {
		t.Fatalf("depois da falha, nova tentativa em 6 h ou no vencimento semanal: %v", next)
	}
	list = h.call("a", "GET", "/api/devices/"+a.olt+"/config-backups", nil, 200)
	dev := list["device"].(map[string]any)
	if dev["config_backup_error"] != "SSH host key is absent from the configured trust file" || dev["config_backup_requested_at"] != nil {
		t.Fatalf("falha: %v", list["_raw"])
	}
	h.call("a", "POST", "/api/devices/"+a.olt+"/config-backups", nil, 200)
	ok := save(map[string]any{"ok": true, "content": "/system identity\nset name=D\n"})
	inA(func(tx *db.Tx) error {
		var trigger string
		var errText *string
		if e := tx.QueryRow(ctx, `select trigger from config_backups where id = $1`, ok["id"]).Scan(&trigger); e != nil || trigger != "manual" {
			return fmt.Errorf("origem do backup: %q %v", trigger, e)
		}
		if e := tx.QueryRow(ctx, `select config_backup_error from devices where id = $1`, a.olt).Scan(&errText); e != nil || errText != nil {
			return fmt.Errorf("erro deveria ser limpo após sucesso: %v %v", errText, e)
		}
		return nil
	})
}
