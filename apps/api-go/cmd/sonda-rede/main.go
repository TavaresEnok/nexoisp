// sonda-rede: validação de CAMPO, só leitura, do código de migração de rede (internal/network) contra a saída real
// de equipamentos. Lê a saída dos comandos de consulta na entrada padrão e imprime SÓ agregados (contagens, tamanhos
// de prefixo, tipos) — nenhum endereço, usuário, senha ou nome sai daqui. Feita para rodar perto do equipamento.
//
//	sonda-rede cgnat   < "export do NAT" + linha "### CONN" + linhas da tabela de conexões
//	sonda-rede repoint < /export do concentrador MikroTik
//	sonda-rede natlog  < registro de NAT (ano/fuso via -year/-tz)
//	sonda-rede analyze < configuração do equipamento de CGNAT
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
)

var reIP = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}\b`)

func mask(s string) string { return reIP.ReplaceAllString(s, "IP") }

func out(v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

func prefixLen(c string) string {
	if i := strings.Index(c, "/"); i >= 0 {
		return c[i:]
	}
	return "/32"
}

func main() {
	year := flag.Int("year", time.Now().Year(), "ano do syslog sem ano")
	oursFile := flag.String("ours", "", "plano: arquivo com os comandos do RADIUS integrado")
	vendor := flag.String("vendor", "mikrotik", "repoint: mikrotik|huawei|cisco")
	tz := flag.String("tz", "America/Sao_Paulo", "fuso do equipamento")
	flag.Parse()
	raw, _ := io.ReadAll(os.Stdin)
	text := strings.ReplaceAll(string(raw), "\r", "")
	switch flag.Arg(0) {
	case "analyze":
		a := network.AnalyzeCGNATConfig(text)
		sugg := []map[string]any{}
		for _, s := range a.Suggestions {
			sugg = append(sugg, map[string]any{"private": prefixLen(s.PrivateCIDR), "public": prefixLen(s.PublicCIDR), "ports": s.PortsPerSubscriber, "port_start": s.PortStart, "port_end": s.PortEnd, "layout": s.Layout, "nat_log": s.NatLog, "rules": s.Rules})
		}
		warn := []string{}
		for _, w := range a.Warnings {
			warn = append(warn, mask(w))
		}
		out(map[string]any{"vendor": a.Vendor, "kind": a.Kind, "rules": len(a.Rules), "suggestions": sugg, "warnings": warn})
	case "repoint":
		ours := "/radius add service=ppp address=198.51.100.5 secret=\"<SEGREDO>\" timeout=3s comment=nexoisp\n/radius incoming set accept=yes port=3799\n/ppp aaa set use-radius=yes accounting=yes interim-update=5m"
		var p network.RepointPlan
		switch *vendor {
		case "huawei":
			p = network.HuaweiRepoint(text, "radius-server group nexoisp\n radius-server authentication 198.51.100.5 1812 weight 0\nradius-server authorization 198.51.100.5 shared-key cipher <SEGREDO>")
		case "cisco":
			p = network.CiscoRepoint(text, "radius server nexoisp\n address ipv4 198.51.100.5 auth-port 1812 acct-port 1813\naaa group server radius NEXOISP\n server name nexoisp\naaa server radius dynamic-author\n client 198.51.100.5 server-key <SEGREDO>")
		default:
			p = network.MikrotikRepoint(text, ours)
		}
		kinds := map[string]int{}
		erps := map[string]int{}
		for _, v := range p.VPN {
			kinds[v.Section]++
			erps[v.ERP]++
		}
		rerp, svc := map[string]int{}, map[string]int{}
		for _, r := range p.Radius {
			rerp[r.ERP]++
			svc[strings.Join(r.Services, ",")]++
		}
		warn := []string{}
		for _, w := range p.Warnings {
			warn = append(warn, mask(w))
		}
		leak := regexp.MustCompile(`(?i)(password|secret)=("[^"<]|[^"<\s])`).MatchString(p.Apply + p.Rollback)
		out(map[string]any{"erp": p.ERP, "radius": len(p.Radius), "radius_erp": rerp, "radius_services": svc, "set_service_cmds": strings.Count(p.Apply, "] service="), "vpn": len(p.VPN), "vpn_kinds": kinds, "vpn_erp": erps, "coa": p.CoA, "use_radius": p.UseRadius,
			"apply_lines": strings.Count(p.Apply, "\n"), "rollback_lines": strings.Count(p.Rollback, "\n"), "disable_cmds": strings.Count(p.Apply, "disabled=yes"), "huawei_dominios": strings.Count(p.Apply, "  radius-server group nexoisp"), "cisco_listas": strings.Count(p.Apply, "group NEXOISP"), "secret_leak": leak, "warnings": warn})
	case "natlog":
		loc, err := time.LoadLocation(*tz)
		if err != nil {
			loc = time.UTC
		}
		r := network.ParseCGNATLog(text, *year, loc, nil)
		closed, single := 0, 0
		pubs, privs := map[string]bool{}, map[string]bool{}
		for _, m := range r.Mappings {
			if m.ValidTo != nil {
				closed++
			}
			if m.PortStart == m.PortEnd {
				single++
			}
			pubs[m.Public], privs[m.Private] = true, true
		}
		samples := []string{}
		for _, x := range r.Samples {
			samples = append(samples, regexp.MustCompile(`\d+`).ReplaceAllString(x, "N"))
		}
		out(map[string]any{"lines": r.Lines, "accepted": r.Accepted, "rejected": r.Rejected, "mappings": len(r.Mappings), "closed": closed, "porta_unica": single,
			"faixa": len(r.Mappings) - single, "publicos": len(pubs), "privados": len(privs), "rejected_samples": samples})
	case "cgnat":
		nat, conn, _ := strings.Cut(text, "### CONN")
		a := network.AnalyzeCGNATConfig(nat)
		plans := []jsonx.Object{}
		for _, s := range a.Suggestions {
			if s.Layout != "netmap" {
				continue
			}
			p := jsonx.Object{}
			p.Set("layout", s.Layout)
			p.Set("private_cidr", s.PrivateCIDR)
			p.Set("public_cidr", s.PublicCIDR)
			p.Set("port_start", float64(s.PortStart))
			p.Set("port_end", float64(s.PortEnd))
			p.Set("ports_per_subscriber", float64(s.PortsPerSubscriber))
			plans = append(plans, p)
		}
		// RouterOS até 7.1x: "src-address=IP:porta"; 7.2x: "src-address=IP src-port=porta".
		reSrc := regexp.MustCompile(`\bsrc-address=(\d+\.\d+\.\d+\.\d+)(?::| src-port=)(\d+)`)
		reRep := regexp.MustCompile(`\breply-dst-address=(\d+\.\d+\.\d+\.\d+)(?::| reply-dst-port=)(\d+)`)
		st := map[string]int{}
		for _, l := range strings.Split(conn, "\n") {
			s, r := reSrc.FindStringSubmatch(l), reRep.FindStringSubmatch(l)
			if s == nil || r == nil {
				continue
			}
			st["conexoes"]++
			if s[1] == r[1] {
				st["sem_traducao"]++
				continue
			}
			pa, _ := netip.ParseAddr(s[1])
			if !netip.MustParsePrefix("100.64.0.0/10").Contains(pa) {
				st["origem_fora_100_64"]++
				continue
			}
			st["traduzidas"]++
			port, _ := strconv.Atoi(r[2])
			if s[2] == r[2] {
				st["porta_preservada"]++
			}
			got := ""
			for _, rule := range a.Rules {
				if port < rule.PortStart || port > rule.PortEnd {
					continue
				}
				if v, ok := network.CGNATMappingPrivate(rule.Private, rule.Public, r[1]); ok {
					got = v
					break
				}
			}
			switch {
			case got == "":
				st["regra_nao_cobre"]++
			case got == s[1]:
				st["regra_acerta"]++
			default:
				st["regra_erra"]++
			}
			pg := ""
			for _, p := range plans {
				if network.CGNATCovers(p, r[1]) {
					if b := network.CGNATReverse(p, r[1], float64(port)); b != nil {
						pg = b["private_ip"].(string)
						break
					}
				}
			}
			switch {
			case pg == "":
				st["plano_nao_cobre"]++
			case pg == s[1]:
				st["plano_acerta"]++
			default:
				st["plano_erra"]++
			}
		}
		warn := []string{}
		for _, w := range a.Warnings {
			warn = append(warn, mask(w))
		}
		out(map[string]any{"kind": a.Kind, "rules": len(a.Rules), "plans": len(plans), "stats": st, "warnings": warn})
	case "plano":
		// SÓ para laboratório próprio: imprime os scripts de troca e de volta (com o que vier em -ours).
		ours, err := os.ReadFile(*oursFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "informe -ours com os comandos do RADIUS integrado")
			os.Exit(2)
		}
		p := network.MikrotikRepoint(text, string(ours))
		fmt.Print("### APLICAR\n" + p.Apply + "### VOLTAR\n" + p.Rollback)
	default:
		fmt.Fprintln(os.Stderr, "uso: sonda-rede cgnat|repoint|natlog|analyze|plano < entrada")
		os.Exit(2)
	}
}
