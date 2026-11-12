package escrita

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/tenancy"
)

// Migração de rede contra PostgreSQL real: plano de troca do RADIUS, leitura do CGNAT, importação de regras exatas e
// de registro de NAT, consulta de ofício pelos mapeamentos, isolamento entre provedores e auditoria.
func TestNetworkMigrationPG(t *testing.T) {
	d := templateTestDB(t, "NEXO_NETWORK_MIGRATION_PG_REQUIRED")
	ctx := context.Background()
	t.Setenv("NEXO_GO_JOBS", "0")
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	type ids struct{ id, admin, nas string }
	mk := func(n int) ids {
		x := ids{id: lateTenantID()}
		if err := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste migração de rede',$2)`, x.id, "mig-"+strings.ReplaceAll(x.id, "-", "")[:20])
		}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = d.WithScope(ctx, op, func(tx *db.Tx) error { return tx.Exec(ctx, `update tenants set status='suspended' where id=$1`, x.id) })
		})
		if err := d.WithScope(ctx, tenancy.Scope{TenantID: x.id}, func(tx *db.Tx) error {
			if e := tx.QueryRow(ctx, `insert into users(tenant_id,email,name,password_hash,role) values(app_tenant(),$1,'Admin migração','!','admin') returning id::text`, uuid.NewString()+"@example.invalid").Scan(&x.admin); e != nil {
				return e
			}
			if e := tx.QueryRow(ctx, `insert into devices(tenant_id,name,driver,vendor) values(app_tenant(),$1,'radius','mikrotik') returning id::text`, "NAS "+x.id[:8]).Scan(&x.nas); e != nil {
				return e
			}
			return tx.Exec(ctx, `insert into radius_nas(device_id,tenant_id,nas_ip,secret) values($1,app_tenant(),$2,'synthetic-secret-1234')`, x.nas, fmt.Sprintf("192.0.2.%d", 100+n+int(time.Now().UnixNano()%100)))
		}); err != nil {
			t.Fatal(err)
		}
		return x
	}
	a, b := mk(1), mk(2)
	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: user, TenantID: tenant, Role: role, Permissions: auth.Permissions[role], Modules: []string{"ipam"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant}}
	}
	add("a", a.id, "admin", a.admin)
	add("b", b.id, "admin", b.admin)
	add("finance", a.id, "finance", a.admin)
	h := templateHarness{t, templateRouter(t, d, actors, func(api huma.API, r *endpoint.Registry, s Service) { Register(api, r, s) })}

	// 1. Plano de troca do RADIUS a partir do export do SGP: o segredo antigo nunca volta na resposta.
	export := "/interface l2tp-client add connect-to=203.0.113.10 name=SGP-VPN user=u password=senhaSGP comment=\"VPN SGP\"\n" +
		"/radius add address=10.200.0.1 secret=segredoSGP comment=\"SGP\" service=ppp\n/radius incoming set accept=yes\n/ppp aaa set use-radius=yes\n"
	plan := h.call("a", "POST", "/api/radius/devices/"+a.nas+"/repoint-plan", map[string]any{"export": export}, 200)
	if plan["erp"] != "sgp" || !strings.Contains(plan["apply"].(string), "comment=nexoisp") || strings.Contains(plan["_raw"].(string), "segredoSGP") || strings.Contains(plan["_raw"].(string), "senhaSGP") {
		t.Fatalf("plano: %v", plan["_raw"])
	}
	h.call("b", "POST", "/api/radius/devices/"+a.nas+"/repoint-plan", map[string]any{"export": export}, 404)
	// Huawei NE: o domínio de assinante passa para o nosso grupo; o grupo do ERP fica para a volta.
	if err := d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update devices set vendor='huawei' where id=$1`, a.nas)
	}); err != nil {
		t.Fatal(err)
	}
	hw := h.call("a", "POST", "/api/radius/devices/"+a.nas+"/repoint-plan", map[string]any{"export": "radius-server group sgp\n radius-server shared-key-cipher %^%#x%^%#\naaa\n domain default1\n  radius-server group sgp\n#\nreturn"}, 200)
	if hw["erp"] != "sgp" || !strings.Contains(hw["apply"].(string), " domain default1\n  authentication-scheme nexoisp") || !strings.Contains(hw["rollback"].(string), "  radius-server group sgp") {
		t.Fatalf("huawei: %v", hw["_raw"])
	}
	if err := d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update devices set vendor='mikrotik' where id=$1`, a.nas)
	}); err != nil {
		t.Fatal(err)
	}
	h.call("finance", "POST", "/api/radius/devices/"+a.nas+"/repoint-plan", map[string]any{"export": export}, 403)

	// 1b. Usuários PPPoE locais do concentrador viram o CSV do importador.
	sec := h.call("a", "POST", "/api/import/mikrotik-secrets", map[string]any{"export": "/ppp secret add name=joao password=s1 profile=100M\n"}, 200)
	if sec["rows"] != float64(1) || !strings.Contains(sec["csv"].(string), "mk:joao,joao,joao,s1,100M") {
		t.Fatalf("secrets: %v", sec["_raw"])
	}

	// 2. Leitura do CGNAT: netmap fora da ordem contígua não vira fórmula, vira regra exata.
	cfg := "/ip firewall nat\nadd action=netmap chain=CGNAT_1 protocol=tcp src-address=100.64.0.8/29 to-addresses=203.0.113.8/29 to-ports=1024-2031\n" +
		"add action=netmap chain=CGNAT_2 protocol=tcp src-address=100.64.0.0/29 to-addresses=203.0.113.8/29 to-ports=2032-3039\n"
	an := h.call("a", "POST", "/api/cgnat/analyze", map[string]any{"config": cfg}, 200)
	if an["kind"] != "deterministic" || len(an["rules"].([]any)) != 2 || len(an["suggestions"].([]any)) != 0 {
		t.Fatalf("análise: %v", an["_raw"])
	}
	imp := h.call("a", "POST", "/api/cgnat/mappings", map[string]any{"kind": "config", "label": "CGNAT MikroTik", "text": cfg}, 201)
	if imp["batch"].(map[string]any)["accepted"] != float64(2) {
		t.Fatalf("importação de regras: %v", imp["_raw"])
	}

	// 3. Ofício: 203.0.113.13 porta 2500 -> segunda regra (100.64.0.0/29) deslocamento 5 -> 100.64.0.5.
	tr := h.call("a", "GET", "/api/cgnat/trace?ip=203.0.113.13&port=2500&at=2026-11-10T12:00:00.000Z", nil, 200)
	if tr["found"] != true || tr["private_ip"] != "100.64.0.5" || tr["layout"] != "mapping" {
		t.Fatalf("ofício pela regra: %v", tr["_raw"])
	}
	if bt := h.call("b", "GET", "/api/cgnat/trace?ip=203.0.113.13&port=2500&at=2026-11-10T12:00:00.000Z", nil, 200); bt["found"] != false {
		t.Fatalf("outro provedor não enxerga os mapeamentos: %v", bt["_raw"])
	}

	// 4. Registro de NAT (Hillstone fixed-block): o titular depende do HORÁRIO.
	log := "2026-11-01T10:00:00-03:00 hs NAT444 allocated src 100.64.9.2 trans 198.51.100.7 ports 3040-5055\n" +
		"2026-11-01T12:00:00-03:00 hs NAT444 released src 100.64.9.2 trans 198.51.100.7 ports 3040-5055\n" +
		"2026-11-01T12:05:00-03:00 hs NAT444 allocated src 100.64.9.3 trans 198.51.100.7 ports 3040-5055\n" +
		"linha que não serve 100.64.9.9\n"
	li := h.call("a", "POST", "/api/cgnat/mappings", map[string]any{"kind": "log", "label": "Hillstone 01/11", "text": log}, 201)
	lb := li["batch"].(map[string]any)
	if lb["accepted"] != float64(3) || lb["rejected"] != float64(1) {
		t.Fatalf("log: %v", li["_raw"])
	}
	for at, want := range map[string]any{"2026-11-01T14:00:00.000Z": "100.64.9.2", "2026-11-01T15:30:00.000Z": "100.64.9.3", "2026-11-01T12:00:00.000Z": nil} {
		r := h.call("a", "GET", "/api/cgnat/trace?ip=198.51.100.7&port=4000&at="+at, nil, 200)
		if (want == nil && r["found"] != false) || (want != nil && r["private_ip"] != want) {
			t.Fatalf("ofício em %s: %v", at, r["_raw"])
		}
	}
	h.call("a", "POST", "/api/cgnat/mappings", map[string]any{"kind": "log", "label": "vazio", "text": "nada aqui que sirva\noutra linha"}, 400)
	h.call("a", "POST", "/api/cgnat/mappings", map[string]any{"kind": "mapping_file", "label": "A10", "text": "Inside 100.64.0.1 NAT 203.0.113.1 ports 1024-3023"}, 400)

	// 5. Lotes: listar, isolar e apagar (o ofício deixa de achar), tudo auditado.
	list := h.call("a", "GET", "/api/cgnat/mappings/batches", nil, 200)
	if !strings.Contains(list["_raw"].(string), "Hillstone 01/11") || strings.Contains(h.call("b", "GET", "/api/cgnat/mappings/batches", nil, 200)["_raw"].(string), "Hillstone") {
		t.Fatalf("lotes: %v", list["_raw"])
	}
	h.call("b", "DELETE", "/api/cgnat/mappings/batches/"+lb["id"].(string), nil, 404)
	h.call("a", "DELETE", "/api/cgnat/mappings/batches/"+lb["id"].(string), nil, 200)
	if r := h.call("a", "GET", "/api/cgnat/trace?ip=198.51.100.7&port=4000&at=2026-11-01T14:00:00.000Z", nil, 200); r["found"] != false {
		t.Fatalf("lote apagado ainda responde: %v", r["_raw"])
	}
	var audits int
	if err := d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select count(*) from audit_events where action in ('radius.repoint_plan','cgnat.mappings_import','cgnat.mappings_delete')`).Scan(&audits)
	}); err != nil || audits != 5 {
		t.Fatalf("auditoria: %d %v", audits, err)
	}
}
