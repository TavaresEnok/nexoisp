package network

import (
	"strings"
	"testing"
)

// Formato do NE8000/NE20 com SGP visto em campo (nomes e endereços trocados por fictícios).
const hwConfig = `#
radius-server group sgp
 radius-server shared-key-cipher %^%#segredoHW%^%#
 radius-server authentication 10.200.0.1 1812 source ip-address 10.10.10.1 weight 0
 radius-server accounting 10.200.0.1 1813 source ip-address 10.10.10.1 weight 0
#
radius-server authorization 10.200.0.1 destination-port 3799 shared-key-cipher %^%#outro%^%# server-group sgp
#
aaa
 authentication-scheme sgp
  authentication-mode radius local
 accounting-scheme sgp
  accounting-mode radius
  accounting interim interval 20
 domain default0
 domain default1
  authentication-scheme sgp
  accounting-scheme sgp
  radius-server group sgp
 domain default_admin
 domain bloqueados
  authentication-scheme sgp
  accounting-scheme sgp
  radius-server group sgp
 domain wifi
  radius-server group hotspot
#
radius-server group hotspot
 radius-server authentication 10.30.0.1 1812 weight 0
#
return`

func TestHuaweiRepoint(t *testing.T) {
	ours := "radius-server group nexoisp\n radius-server authentication 198.51.100.5 1812 weight 0\n radius-server shared-key cipher <SEGREDO>\nradius-server authorization 198.51.100.5 shared-key cipher <SEGREDO>\naaa\n authentication-scheme nexoisp\n  authentication-mode radius\n accounting-scheme nexoisp\n  accounting-mode radius\n domain nexoisp\n  radius-server group nexoisp"
	p := HuaweiRepoint(hwConfig, ours)
	if p.ERP != "sgp" || !p.CoA || len(p.Radius) != 2 || strings.Contains(p.Apply, "domain wifi") || !strings.Contains(strings.Join(p.Warnings, " "), "1 domínio(s) usam grupo RADIUS que não é do sistema anterior") {
		t.Fatalf("%+v", p)
	}
	if strings.Count(p.Apply, "  radius-server group nexoisp") != 3 || !strings.Contains(p.Apply, " domain default1\n  authentication-scheme nexoisp") || strings.Contains(p.Apply, "domain default_admin") {
		t.Fatalf("só os domínios do ERP (default1, bloqueados) mudam:\n%s", p.Apply)
	}
	if strings.Contains(p.Apply+p.Rollback, "segredoHW") || strings.Contains(p.Apply+p.Rollback, "outro") || strings.Contains(p.Apply, "undo radius-server group sgp") {
		t.Fatalf("sem segredo do ERP e sem apagar o grupo dele:\n%s", p.Apply)
	}
	for _, w := range []string{" domain bloqueados\n  authentication-scheme sgp\n  accounting-scheme sgp\n  radius-server group sgp", "undo radius-server authorization 198.51.100.5", "undo radius-server group nexoisp", "commit"} {
		if !strings.Contains(p.Rollback, w) {
			t.Fatalf("volta sem %q:\n%s", w, p.Rollback)
		}
	}
}

func TestCiscoRepoint(t *testing.T) {
	cfg := `aaa new-model
aaa group server radius ERP_SGP
 server-private 10.200.0.1 auth-port 1812 acct-port 1813 key 7 segredoCisco
 ip radius source-interface Loopback1
aaa authentication login default local
aaa authentication ppp ERP_SGP group ERP_SGP
aaa authorization network ERP_SGP group ERP_SGP
aaa authorization subscriber-service ERP_SGP local group ERP_SGP
aaa accounting network ERP_SGP start-stop group ERP_SGP
aaa accounting update periodic 20
aaa server radius dynamic-author
 client 10.200.0.1 server-key 7 outroSegredo
bba-group pppoe ERP_SGP
 virtual-template 1`
	ours := "aaa new-model\nradius server nexoisp\n address ipv4 198.51.100.5 auth-port 1812 acct-port 1813\n key <SEGREDO>\naaa group server radius NEXOISP\n server name nexoisp\naaa authentication ppp default group NEXOISP\naaa authorization network default group NEXOISP\naaa accounting network default start-stop group NEXOISP\naaa accounting update periodic 5\naaa server radius dynamic-author\n client 198.51.100.5 server-key <SEGREDO>\n port 3799"
	p := CiscoRepoint(cfg, ours)
	if p.ERP != "sgp" || !p.CoA {
		t.Fatalf("%+v", p)
	}
	for _, w := range []string{"aaa authentication ppp ERP_SGP group NEXOISP", "aaa authorization subscriber-service ERP_SGP local group NEXOISP", "aaa accounting network ERP_SGP start-stop group NEXOISP"} {
		if !strings.Contains(p.Apply, w) {
			t.Fatalf("lista nomeada redirecionada (%q):\n%s", w, p.Apply)
		}
	}
	if strings.Contains(p.Apply, "ppp default group") || strings.Contains(p.Apply, "login default") || strings.Contains(p.Apply+p.Rollback, "segredoCisco") || strings.Contains(p.Apply+p.Rollback, "outroSegredo") {
		t.Fatalf("não mexe em listas default/login nem vaza segredo:\n%s", p.Apply)
	}
	for _, w := range []string{"aaa authentication ppp ERP_SGP group ERP_SGP", "aaa accounting update periodic 20", "no aaa group server radius NEXOISP", " no client 198.51.100.5"} {
		if !strings.Contains(p.Rollback, w) {
			t.Fatalf("volta sem %q:\n%s", w, p.Rollback)
		}
	}
}
