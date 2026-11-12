package network

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"nexoisp/api-go/internal/jsonx"
)

// Geometria medida no backup center (48 MikroTik): salto por /29 privado para CGNAT_n e, dentro da cadeia,
// netmap /29 -> /29 público em faixas de 1008 portas a partir da 1024 (tcp e udp) + uma regra sem portas.
func netmapExport() string {
	var b strings.Builder
	b.WriteString("# by RouterOS 7.16\n")
	for k := 0; k < 4; k++ {
		priv := IPv4String(0x64400000 + uint64(k*8)) // 100.64.0.0 + k*8
		start := 1024 + k*1008
		b.WriteString("/ip firewall nat add action=jump chain=srcnat jump-target=CGNAT_" + itoa(k+1) + " src-address=" + priv + "/29\n")
		for _, proto := range []string{"tcp", "udp"} {
			b.WriteString("/ip firewall nat add action=netmap chain=CGNAT_" + itoa(k+1) + " protocol=" + proto + " src-address=" + priv + "/29 to-addresses=203.0.113.8/29 to-ports=" + itoa(start) + "-" + itoa(start+1007) + "\n")
		}
		b.WriteString("/ip firewall nat add action=netmap chain=CGNAT_" + itoa(k+1) + " src-address=" + priv + "/29 to-addresses=203.0.113.8/29\n")
	}
	b.WriteString("/ip firewall nat add action=dst-nat chain=dstnat dst-address=203.0.113.1 dst-port=8080 protocol=tcp to-addresses=10.0.0.5 to-ports=80\n")
	return b.String()
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestAnalyzeMikrotikNetmapDeterministico(t *testing.T) {
	a := AnalyzeCGNATConfig(netmapExport())
	if a.Vendor != "mikrotik" || a.Kind != "deterministic" || !a.Traceable || len(a.Rules) != 4 {
		t.Fatalf("%+v", a)
	}
	if len(a.Suggestions) != 1 {
		t.Fatalf("um plano por bloco público: %+v", a.Suggestions)
	}
	s := a.Suggestions[0]
	if s.PrivateCIDR != "100.64.0.0/27" || s.PublicCIDR != "203.0.113.8/29" || s.PortStart != 1024 || s.PortEnd != 1024+4*1008-1 || s.PortsPerSubscriber != 1008 || s.Layout != "netmap" {
		t.Fatalf("sugestão: %+v", s)
	}
	// A sugestão, gravada como plano, devolve o MESMO titular que a regra do equipamento.
	plan := jsonx.Object{}
	plan.Set("layout", s.Layout)
	plan.Set("private_cidr", s.PrivateCIDR)
	plan.Set("public_cidr", s.PublicCIDR)
	plan.Set("port_start", float64(s.PortStart))
	plan.Set("port_end", float64(s.PortEnd))
	plan.Set("ports_per_subscriber", float64(s.PortsPerSubscriber))
	for _, c := range []struct {
		ip   string
		port float64
		want string
	}{{"203.0.113.8", 1024, "100.64.0.0"}, {"203.0.113.13", 2040, "100.64.0.13"}, {"203.0.113.15", 5055, "100.64.0.31"}} {
		got := CGNATReverse(plan, c.ip, c.port)
		if got == nil || got["private_ip"] != c.want {
			t.Fatalf("%s:%v -> %v, quer %s", c.ip, c.port, got, c.want)
		}
		priv, ok := CGNATMappingPrivate(a.Rules[int(c.port-1024)/1008].Private, "203.0.113.8/29", c.ip)
		if !ok || priv != c.want {
			t.Fatalf("regra exata %s:%v -> %s", c.ip, c.port, priv)
		}
	}
}

func TestAnalyzeMikrotikForaDeOrdemEMasquerade(t *testing.T) {
	export := "/ip firewall nat\nadd action=netmap chain=CGNAT_1 protocol=tcp src-address=100.64.0.8/29 to-addresses=203.0.113.8/29 to-ports=1024-2031\n" +
		"add action=netmap chain=CGNAT_2 protocol=tcp src-address=100.64.0.0/29 to-addresses=203.0.113.8/29 to-ports=2032-3039\n" +
		"add action=masquerade chain=srcnat src-address=100.64.8.0/22\n"
	a := AnalyzeCGNATConfig(export)
	if a.Kind != "deterministic" || len(a.Rules) != 2 || len(a.Suggestions) != 0 {
		t.Fatalf("fora de ordem não vira fórmula: %+v", a)
	}
	w := strings.Join(a.Warnings, " | ")
	if !strings.Contains(w, "regras exatas") || !strings.Contains(w, "NAT dinâmico") {
		t.Fatalf("avisos: %s", w)
	}
	only := AnalyzeCGNATConfig("/ip firewall nat add action=masquerade chain=srcnat src-address=100.64.0.0/10 out-interface=wan\n")
	if only.Kind != "dynamic" || only.Suggestions[0].NatLog != "none" {
		t.Fatalf("%+v", only)
	}
}

func TestAnalyzeHillstoneEA10(t *testing.T) {
	hs := `logging traffic nat on
logging syslog 192.0.2.50 vrouter "trust-vr" udp 514 type traffic nat
nat
  snatrule id 1 from address-book "CGNAT" to address-book "Any" service "Any" trans-to address-book "POOL" mode dynamicport fixed-block start 1024 end 65535 size 2016 log
  snatrule id 2 from address-book "CGNAT2" to address-book "Any" service "Any" trans-to address-book "POOL2" mode dynamicport fixed-block start 1024 end 65535 size 2016
exit`
	a := AnalyzeCGNATConfig(hs)
	if a.Vendor != "hillstone" || a.Kind != "dynamic_block" || a.Suggestions[0].PortsPerSubscriber != 2016 || a.Suggestions[0].NatLog != "syslog" || a.Suggestions[0].Layout != "external" {
		t.Fatalf("%+v", a)
	}
	if !strings.Contains(strings.Join(a.Warnings, " "), "1 de 2 snatrule sem 'log'") {
		t.Fatalf("%v", a.Warnings)
	}
	a10 := AnalyzeCGNATConfig("cgnv6 fixed-nat create-port-mapping-file\ncgnv6 fixed-nat inside ip-list IN nat ip-list OUT method use-all-nat-ips offset random ports-per-user 2000 respond-to-user-mac\nlogging host 192.0.2.9 use-mgmt-port\n")
	if a10.Vendor != "a10" || a10.Kind != "deterministic_offset" || a10.Suggestions[0].PortsPerSubscriber != 2000 || !strings.Contains(strings.Join(a10.Warnings, " "), "offset random") {
		t.Fatalf("%+v", a10)
	}
}

func TestParseCGNATLog(t *testing.T) {
	log := `2026-11-01T10:00:00-03:00 hs01 NAT444: port-block allocated src 100.64.1.2 trans 203.0.113.9 ports 3040-5055
2026-11-01T12:30:00-03:00 hs01 NAT444: port-block released src 100.64.1.2 trans 203.0.113.9 ports 3040-5055
Nov  1 13:00:00 hs01 NAT444: port-block allocated src 100.64.1.7 trans 203.0.113.9 ports 3040-5055
linha sem nada útil 2026-11-01T10:00:00Z
2026-11-01T17:00:00Z port-block allocated src 100.64.1.9 trans 203.0.113.9 ports 3040-5055`
	loc, _ := time.LoadLocation("America/Sao_Paulo")
	r := ParseCGNATLog(log, 2026, loc, nil)
	if r.Lines != 5 || r.Accepted != 4 || r.Rejected != 1 || len(r.Mappings) != 3 {
		t.Fatalf("%+v", r)
	}
	m0, m1, m2 := r.Mappings[0], r.Mappings[1], r.Mappings[2]
	if m0.Private != "100.64.1.2/32" || m0.Public != "203.0.113.9/32" || m0.PortStart != 3040 || m0.ValidTo == nil || !m0.ValidTo.Equal(time.Date(2026, 11, 1, 15, 30, 0, 0, time.UTC)) {
		t.Fatalf("alocação fechada pela liberação: %+v", m0)
	}
	if !m1.ValidFrom.Equal(time.Date(2026, 11, 1, 16, 0, 0, 0, time.UTC)) || m1.ValidTo == nil || !m1.ValidTo.Equal(*m2.ValidFrom) || m2.ValidTo != nil {
		t.Fatalf("syslog sem ano usa o ano/fuso informados e o mesmo bloco reatribuído fecha o anterior: %+v %+v", m1, m2)
	}
	if strings.Contains(strings.Join(r.Samples, ""), "100.64") {
		t.Fatal("amostra rejeitada não pode carregar endereço")
	}
	from := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	f := ParseCGNATLog("Inside 100.64.0.1  NAT 203.0.113.1  ports 1024-3023\nInside 100.64.0.2 NAT 203.0.113.1 ports 3024-5023\n", 0, time.UTC, &from)
	if f.Accepted != 2 || !f.Mappings[1].ValidFrom.Equal(from) {
		t.Fatalf("arquivo de mapeamento: %+v", f)
	}
	c, err := ParseCGNATCSV("public_ip,private_ip,port_start,port_end,start,end\n203.0.113.1,100.64.0.9,1024,2047,2026-11-01T00:00:00Z,\n10.0.0.1,100.64.0.9,1,2,x,\n")
	if err != nil || c.Accepted != 1 || c.Rejected != 1 || c.Mappings[0].ValidTo != nil {
		t.Fatalf("csv: %+v %v", c, err)
	}
}
