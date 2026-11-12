package network

import (
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Leitura da configuração de CGNAT que o provedor JÁ usa, para a migração (estudo do backup center, 2026-11-12):
//   - MikroTik: o padrão de mercado é netmap determinístico — um salto por bloco privado /29 (ou /30, /27...) para
//     uma cadeia CGNAT_n, e dentro dela netmap do bloco privado para um bloco público do mesmo tamanho numa faixa
//     de portas (1008 ou 2016 portas por assinante na maioria). 48 de 95 MikroTik com 100.64/10 seguem isso;
//   - Hillstone: snatrule ... mode dynamicport fixed-block start/end/size — bloco fixo de portas, mas ATRIBUÍDO
//     DINAMICAMENTE: o titular só sai do registro de NAT (logging traffic nat / syslog);
//   - A10: cgnv6 fixed-nat ... ports-per-user N offset random — determinístico para o equipamento, mas o
//     deslocamento aleatório impede o cálculo: o titular sai do arquivo de mapeamento (create-port-mapping-file).
// O analisador NÃO aplica nada: devolve as regras exatas e os planos sugeridos para o provedor conferir.

// CGNATRule é uma regra exata: o bloco privado sai pelo bloco público do mesmo tamanho na faixa de portas.
type CGNATRule struct {
	Private   string `json:"private_cidr"`
	Public    string `json:"public_cidr"`
	PortStart int    `json:"port_start"`
	PortEnd   int    `json:"port_end"`
}

// CGNATSuggestion segue o formato de cgnat_plans (layout netmap/external).
type CGNATSuggestion struct {
	PrivateCIDR        string `json:"private_cidr,omitempty"`
	PublicCIDR         string `json:"public_cidr,omitempty"`
	PortStart          int    `json:"port_start,omitempty"`
	PortEnd            int    `json:"port_end,omitempty"`
	PortsPerSubscriber int    `json:"ports_per_subscriber,omitempty"`
	Layout             string `json:"layout"`
	NatLog             string `json:"nat_log,omitempty"`
	NatLogDetail       string `json:"nat_log_detail,omitempty"`
	Rules              int    `json:"rules"`
}

type CGNATAnalysis struct {
	Vendor      string            `json:"vendor"`
	Kind        string            `json:"kind"` // deterministic | dynamic_block | deterministic_offset | dynamic | none
	Rules       []CGNATRule       `json:"rules"`
	Suggestions []CGNATSuggestion `json:"suggestions"`
	Traceable   bool              `json:"traceable_by_config"`
	Warnings    []string          `json:"warnings"`
}

var (
	reHillstoneSnat = regexp.MustCompile(`(?m)^\s*snatrule\b.*\bmode dynamicport\b(?:.*\bfixed-block start (\d+) end (\d+) size (\d+))?(.*)$`)
	reA10Fixed      = regexp.MustCompile(`(?m)^\s*cgnv6 fixed-nat inside\b(.*)$`)
	rePortsPerUser  = regexp.MustCompile(`ports-per-user (\d+)`)
)

func prefixOf(v string) (netip.Prefix, bool) {
	if !strings.Contains(v, "/") {
		v += "/32"
	}
	p, err := netip.ParsePrefix(v)
	if err != nil || !p.Addr().Is4() {
		return netip.Prefix{}, false
	}
	return p.Masked(), true
}

func isCGNATPrivate(p netip.Prefix) bool {
	for _, n := range []string{"100.64.0.0/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"} {
		if netip.MustParsePrefix(n).Overlaps(p) {
			return true
		}
	}
	return false
}

func addr4(a netip.Addr) uint64 { b := a.As4(); return uint64(b[0])<<24 | uint64(b[1])<<16 | uint64(b[2])<<8 | uint64(b[3]) }

func prefixSize(p netip.Prefix) uint64 { return uint64(1) << uint(32-p.Bits()) }

// AnalyzeCGNATConfig reconhece o fabricante pelo texto e extrai o que dá para saber da configuração.
func AnalyzeCGNATConfig(text string) CGNATAnalysis {
	a := CGNATAnalysis{Rules: []CGNATRule{}, Suggestions: []CGNATSuggestion{}, Warnings: []string{}}
	low := strings.ToLower(text)
	switch {
	case strings.Contains(low, "cgnv6 "):
		a.Vendor = "a10"
		analyzeA10(text, low, &a)
	case strings.Contains(low, "snatrule "):
		a.Vendor = "hillstone"
		analyzeHillstone(text, low, &a)
	case strings.Contains(low, "/ip firewall nat") || strings.Contains(low, "chain=srcnat"):
		a.Vendor = "mikrotik"
		analyzeMikrotikNAT(text, &a)
	default:
		a.Vendor, a.Kind = "desconhecido", "none"
		a.Warnings = append(a.Warnings, "configuração não reconhecida (esperado export do MikroTik, Hillstone ou A10)")
	}
	return a
}

func analyzeMikrotikNAT(text string, a *CGNATAnalysis) {
	sec := exportSections(text)
	seen := map[CGNATRule]bool{}
	dynamic := false
	for _, line := range sec["/ip firewall nat"] {
		if !strings.HasPrefix(line, "add ") {
			continue
		}
		at := exportAttrs(line)
		if at["disabled"] == "yes" {
			continue
		}
		src, okSrc := prefixOf(at["src-address"])
		if at["action"] == "masquerade" || (at["action"] == "src-nat" && at["to-ports"] == "") {
			if okSrc && isCGNATPrivate(src) && at["chain"] != "dstnat" {
				dynamic = true
			}
			continue
		}
		if at["action"] != "netmap" && at["action"] != "src-nat" {
			continue
		}
		dst, okDst := prefixOf(at["to-addresses"])
		ports := strings.SplitN(at["to-ports"], "-", 2)
		if !okSrc || !okDst || len(ports) != 2 || !isCGNATPrivate(src) {
			continue
		}
		ps, e1 := strconv.Atoi(ports[0])
		pe, e2 := strconv.Atoi(ports[1])
		if e1 != nil || e2 != nil || pe < ps {
			continue
		}
		if src.Bits() != dst.Bits() {
			a.Warnings = append(a.Warnings, fmt.Sprintf("regra com bloco privado /%d e público /%d de tamanhos diferentes: ignorada", src.Bits(), dst.Bits()))
			continue
		}
		r := CGNATRule{Private: src.String(), Public: dst.String(), PortStart: ps, PortEnd: pe}
		if !seen[r] { // tcp e udp repetem a mesma geometria
			seen[r] = true
			a.Rules = append(a.Rules, r)
		}
	}
	switch {
	case len(a.Rules) > 0:
		a.Kind, a.Traceable = "deterministic", true
		a.Suggestions = suggestNetmapPlans(a.Rules, &a.Warnings)
		if dynamic {
			a.Warnings = append(a.Warnings, "há também NAT dinâmico (masquerade/src-nat sem portas) para endereços privados: quem sair por ele só é rastreável por registro de NAT")
		}
	case dynamic:
		a.Kind = "dynamic"
		a.Suggestions = append(a.Suggestions, CGNATSuggestion{Layout: "external", NatLog: "none", NatLogDetail: "masquerade sem registro de NAT"})
		a.Warnings = append(a.Warnings, "NAT dinâmico (masquerade): sem regras determinísticas e sem registro, IP+porta não identificam o assinante. Ative log de NAT ou migre para o CGNAT determinístico")
	default:
		a.Kind = "none"
		a.Warnings = append(a.Warnings, "nenhuma regra de CGNAT para endereços privados")
	}
}

// suggestNetmapPlans agrupa as regras por bloco público. Quando os blocos privados são contíguos e cada um usa a
// faixa de portas seguinte, o grupo é exatamente o layout "netmap" de cgnat_plans; senão o rastreio usa as regras.
func suggestNetmapPlans(rules []CGNATRule, warnings *[]string) []CGNATSuggestion {
	groups := map[string][]CGNATRule{}
	order := []string{}
	for _, r := range rules {
		if _, ok := groups[r.Public]; !ok {
			order = append(order, r.Public)
		}
		groups[r.Public] = append(groups[r.Public], r)
	}
	out := []CGNATSuggestion{}
	irregular := 0
	for _, pub := range order {
		g := groups[pub]
		sort.Slice(g, func(i, j int) bool { return g[i].PortStart < g[j].PortStart })
		width := g[0].PortEnd - g[0].PortStart + 1
		p0, _ := prefixOf(g[0].Private)
		size := prefixSize(p0)
		ok := true
		for k, r := range g {
			p, _ := prefixOf(r.Private)
			if r.PortEnd-r.PortStart+1 != width || r.PortStart != g[0].PortStart+k*width || addr4(p.Addr()) != addr4(p0.Addr())+uint64(k)*size {
				ok = false
				break
			}
		}
		total := uint64(len(g)) * size
		bits := 32
		for uint64(1)<<uint(32-bits) < total {
			bits--
		}
		cover := netip.PrefixFrom(p0.Addr(), bits).Masked()
		if !ok || cover.Addr() != p0.Addr() {
			irregular++
			continue
		}
		out = append(out, CGNATSuggestion{PrivateCIDR: cover.String(), PublicCIDR: pub, PortStart: g[0].PortStart, PortEnd: g[0].PortStart + len(g)*width - 1,
			PortsPerSubscriber: width, Layout: "netmap", Rules: len(g)})
	}
	if irregular > 0 {
		*warnings = append(*warnings, fmt.Sprintf("%d bloco(s) público(s) com regras fora da ordem contígua: importe as regras exatas (o rastreio usa cada regra, sem fórmula)", irregular))
	}
	return out
}

func natLogHint(low string, ruleLogs bool) (string, string) {
	syslog := regexp.MustCompile(`logging syslog \S+.*type traffic nat|logging (host|syslog) `).MatchString(low)
	natOn := strings.Contains(low, "logging traffic nat on") || ruleLogs
	switch {
	case natOn && syslog:
		return "syslog", "registro de NAT enviado por syslog: importe o log de alocação de bloco"
	case natOn:
		return "equipment", "registro de NAT ligado só no equipamento: exporte e importe periodicamente"
	}
	return "none", ""
}

func analyzeHillstone(text, low string, a *CGNATAnalysis) {
	ms := reHillstoneSnat.FindAllStringSubmatch(text, -1)
	if len(ms) == 0 {
		a.Kind = "dynamic"
		a.Warnings = append(a.Warnings, "nenhuma snatrule em dynamicport")
		return
	}
	logged := 0
	s := CGNATSuggestion{Layout: "external", Rules: len(ms)}
	for _, m := range ms {
		if regexp.MustCompile(`\blog\b`).MatchString(m[4]) {
			logged++
		}
		if m[1] != "" && s.PortsPerSubscriber == 0 {
			s.PortStart, _ = strconv.Atoi(m[1])
			s.PortEnd, _ = strconv.Atoi(m[2])
			s.PortsPerSubscriber, _ = strconv.Atoi(m[3])
		}
	}
	a.Kind = "dynamic_block"
	s.NatLog, s.NatLogDetail = natLogHint(low, logged > 0)
	a.Suggestions = append(a.Suggestions, s)
	if logged < len(ms) {
		a.Warnings = append(a.Warnings, fmt.Sprintf("%d de %d snatrule sem 'log': as alocações por elas não ficam registradas", len(ms)-logged, len(ms)))
	}
	if s.NatLog == "none" {
		a.Warnings = append(a.Warnings, "sem registro de NAT: blocos fixos são atribuídos dinamicamente, então IP+porta não identificam o assinante. Ative 'log' nas snatrule e 'logging traffic nat'")
	}
	if strings.Contains(low, "no logging traffic nat to buffer") && s.NatLog == "equipment" {
		a.Warnings = append(a.Warnings, "o registro de NAT não fica no buffer do equipamento: confirme o destino (syslog)")
	}
}

func analyzeA10(text, low string, a *CGNATAnalysis) {
	ms := reA10Fixed.FindAllStringSubmatch(text, -1)
	if len(ms) == 0 {
		a.Kind = "dynamic"
		a.Suggestions = append(a.Suggestions, CGNATSuggestion{Layout: "external"})
		a.Suggestions[0].NatLog, a.Suggestions[0].NatLogDetail = natLogHint(low, false)
		a.Warnings = append(a.Warnings, "A10 em LSN (NAT dinâmico): o titular só sai do registro de NAT")
		return
	}
	for _, m := range ms {
		s := CGNATSuggestion{Layout: "external", Rules: 1, NatLog: "equipment",
			NatLogDetail: "arquivo de mapeamento do fixed-nat (create-port-mapping-file): importe-o a cada mudança"}
		if p := rePortsPerUser.FindStringSubmatch(m[1]); p != nil {
			s.PortsPerSubscriber, _ = strconv.Atoi(p[1])
		}
		a.Suggestions = append(a.Suggestions, s)
	}
	a.Kind = "deterministic_offset"
	if strings.Contains(low, "offset random") {
		a.Warnings = append(a.Warnings, "fixed-nat com 'offset random': a posição de cada assinante não é calculável pela configuração — use o arquivo de mapeamento do próprio A10")
	}
	if !strings.Contains(low, "create-port-mapping-file") {
		a.Warnings = append(a.Warnings, "o A10 não está gerando o arquivo de mapeamento (cgnv6 fixed-nat create-port-mapping-file)")
	}
}
