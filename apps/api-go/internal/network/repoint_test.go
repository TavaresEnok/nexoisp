package network

import (
	"strings"
	"testing"
)

// Export fictício no formato "terse" que o backup center registra, com o padrão do SGP: RADIUS privado alcançado
// por um cliente L2TP que o próprio MikroTik disca até o servidor do ERP.
const exportSGP = `# 2026-11-12 by RouterOS 7.16
/interface l2tp-client add connect-to=203.0.113.10 disabled=no name=SGP-VPN user=prov1 password=segredo1 comment="VPN SGP"
/interface wireguard add listen-port=13231 name=wg-adm
/interface wireguard peers add interface=wg-adm public-key="AAAA" allowed-address=10.9.0.2/32
/ppp aaa set interim-update=20m use-radius=yes
/radius add address=10.200.0.1 secret=naoVaza comment="SGP RADIUS" service=ppp src-address=10.200.0.5 \
    timeout=3s
/radius add address=10.200.0.2 secret=naoVaza2 comment=backup service=ppp disabled=yes
/radius incoming set accept=yes
/ppp secret add name=teste password=x profile=default
`

func TestMikrotikRepointSGP(t *testing.T) {
	ours := `/radius add service=ppp,hotspot,dhcp address=198.51.100.5 secret="<SEGREDO>" authentication-port=1812 accounting-port=1813 timeout=3s comment=nexoisp
/radius incoming set accept=yes port=3799
/ppp aaa set use-radius=yes accounting=yes interim-update=5m`
	p := MikrotikRepoint(exportSGP, ours)
	if p.ERP != "sgp" || !p.CoA || !p.UseRadius {
		t.Fatalf("classificação: %+v", p)
	}
	if len(p.Radius) != 2 || p.Radius[0].Address != "10.200.0.1" || !p.Radius[0].Enabled || p.Radius[1].Enabled {
		t.Fatalf("radius: %+v", p.Radius)
	}
	if len(p.VPN) != 1 || p.VPN[0].Name != "SGP-VPN" || p.VPN[0].ERP != "sgp" {
		t.Fatalf("vpn (o peer wireguard sem endpoint é servidor, não entra): %+v", p.VPN)
	}
	for _, s := range []string{p.Apply, p.Rollback} {
		if strings.Contains(s, "naoVaza") || strings.Contains(s, "segredo1") {
			t.Fatal("segredo do sistema anterior vazou no script")
		}
	}
	iOurs := strings.Index(p.Apply, "comment=nexoisp")
	iOff := strings.Index(p.Apply, `/radius set [find where address=10.200.0.1 and !(comment~"^nexoisp")] disabled=yes`)
	if iOurs < 0 || iOff < 0 || iOurs > iOff {
		t.Fatalf("o nosso RADIUS entra ANTES de desativar o anterior:\n%s", p.Apply)
	}
	if strings.Contains(p.Apply, "address=10.200.0.2") || strings.Contains(p.Apply, "/radius remove") {
		t.Fatalf("não mexe no que já estava desativado e não apaga nada:\n%s", p.Apply)
	}
	if !strings.Contains(p.Apply, `# /interface l2tp-client disable [find where name="SGP-VPN"]`) {
		t.Fatalf("túnel do ERP só sai na fase 2, comentado:\n%s", p.Apply)
	}
	for _, want := range []string{"/ppp aaa set use-radius=yes accounting=yes interim-update=20m", "/radius incoming set accept=yes port=3799", `/radius set [find where address=10.200.0.1 and !(comment~"^nexoisp")] disabled=no`, `/radius remove [find where comment~"^nexoisp"]`, `/interface l2tp-client enable [find where name="SGP-VPN"]`} {
		if !strings.Contains(p.Rollback, want) {
			t.Fatalf("volta sem %q:\n%s", want, p.Rollback)
		}
	}
	if !strings.Contains(strings.Join(p.Warnings, " "), "/ppp secret") {
		t.Fatalf("avisa dos usuários locais: %v", p.Warnings)
	}
}

func TestMikrotikRepointSemCoAETunelNosso(t *testing.T) {
	export := "/radius\nadd address=192.0.2.9 comment=\"IXC Provedor\" secret=x service=ppp\n/radius add address=198.51.100.5 comment=nexoisp secret=y\n"
	ours := "/interface wireguard add name=nexoisp private-key=\"k\" comment=nexoisp\n/interface wireguard peers add interface=nexoisp public-key=\"p\" endpoint-address=198.51.100.1 comment=nexoisp\n/ip address add address=10.250.0.9/32 interface=nexoisp comment=nexoisp\n/radius add address=10.250.0.1 secret=\"s\" comment=nexoisp\n/radius incoming set accept=yes port=3799"
	p := MikrotikRepoint(export, ours)
	if p.ERP != "ixc" || p.CoA || len(p.Radius) != 1 {
		t.Fatalf("formato com cabeçalho / ignora o nosso já presente: %+v", p)
	}
	back := p.Rollback
	order := []string{"/radius remove", "/ip address remove", "/interface wireguard peers remove", "/interface wireguard remove", "/radius incoming set accept=no port=3799"}
	last := -1
	for _, o := range order {
		i := strings.Index(back, o)
		if i < 0 || i < last {
			t.Fatalf("volta fora de ordem (%q):\n%s", o, back)
		}
		last = i
	}
}

// RADIUS anterior que também serve login de administrador: só o PPP muda; RADIUS só de login fica intocado.
func TestMikrotikRepointPreservaOutrosServicos(t *testing.T) {
	export := "/radius add address=10.1.1.1 comment=IXC secret=x service=ppp,login\n/radius add address=10.1.1.2 secret=y service=login\n"
	p := MikrotikRepoint(export, "/radius add address=198.51.100.5 secret=\"s\" service=ppp comment=nexoisp")
	if !strings.Contains(p.Apply, `/radius set [find where address=10.1.1.1 and !(comment~"^nexoisp")] service=login`) ||
		!strings.Contains(p.Rollback, `/radius set [find where address=10.1.1.1 and !(comment~"^nexoisp")] service=ppp,login`) {
		t.Fatalf("serviço misto:\n%s\n%s", p.Apply, p.Rollback)
	}
	if strings.Contains(p.Apply, "address=10.1.1.2") || strings.Contains(p.Apply, "disabled=yes") {
		t.Fatalf("RADIUS só de login não pode ser tocado:\n%s", p.Apply)
	}
}

func TestPPPSecretsCSV(t *testing.T) {
	export := "/ppp secret\nadd name=joao password=s1 profile=100M remote-address=100.64.0.9 caller-id=aa:bb:cc:dd:ee:01 comment=\"Joao da Silva\"\n" +
		"add name=maria password=s2 profile=50M disabled=yes service=pppoe\nadd name=l2tp-site password=x service=l2tp\nadd name=semsenha profile=100M\n"
	r := PPPSecretsCSV(export)
	if r.Rows != 3 || r.Skipped != 1 || r.Profiles["100M"] != 2 || r.Profiles["50M"] != 1 {
		t.Fatalf("%+v", r)
	}
	want := []string{"id_externo,nome,pppoe_usuario,pppoe_senha,plano,ip_fixo,mac,situacao,observacoes",
		"mk:joao,Joao da Silva,joao,s1,100M,100.64.0.9,AA:BB:CC:DD:EE:01,ativo,importado do /ppp secret do concentrador",
		"mk:maria,maria,maria,s2,50M,,,inativo,importado do /ppp secret do concentrador"}
	for _, w := range want {
		if !strings.Contains(r.CSV, w+"\n") {
			t.Fatalf("CSV sem %q:\n%s", w, r.CSV)
		}
	}
	if !strings.Contains(strings.Join(r.Warnings, " "), "show-sensitive") {
		t.Fatalf("avisa senha ausente: %v", r.Warnings)
	}
}
