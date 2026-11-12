package network

import (
	"encoding/csv"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Mapeamentos de CGNAT importados para responder ofícios quando o titular não sai de fórmula:
//   - config: regras exatas lidas do equipamento (netmap fora da ordem contígua), sem período;
//   - log:    registro de alocação/liberação de bloco de portas (Hillstone fixed-block, A10 LSN, syslog);
//   - mapping_file: arquivo de mapeamento do A10 fixed-nat (vale a partir da data informada);
//   - csv:    planilha neutra private_ip,public_ip,port_start,port_end,start,end.
// O leitor de log é tolerante de propósito (formatos variam por firmware): em cada linha procura um endereço
// privado, um público, uma faixa de portas e a data/hora; "release/free/withdraw/delete" fecha o período.
// Linhas que não têm tudo isso são contadas como rejeitadas — nunca adivinhadas.

type CGNATMapping struct {
	Private   string     `json:"private_cidr"`
	Public    string     `json:"public_cidr"`
	PortStart int        `json:"port_start"`
	PortEnd   int        `json:"port_end"`
	ValidFrom *time.Time `json:"valid_from"`
	ValidTo   *time.Time `json:"valid_to"`
}

type CGNATImport struct {
	Mappings []CGNATMapping `json:"-"`
	Lines    int            `json:"lines"`
	Accepted int            `json:"accepted"`
	Rejected int            `json:"rejected"`
	Samples  []string       `json:"rejected_samples"`
}

var (
	reIPv4      = regexp.MustCompile(`\b(\d{1,3}(?:\.\d{1,3}){3})\b`)
	rePortRange = regexp.MustCompile(`\b(\d{2,5})\s*(?:-|~|\bto\b)\s*(\d{2,5})\b`)
	reISOTime   = regexp.MustCompile(`\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?`)
	reSyslogTS  = regexp.MustCompile(`\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\b`)
	reRelease   = regexp.MustCompile(`(?i)\b(release[sd]?|free[sd]?|freed|withdraw\w*|delete[sd]?|dealloc\w*|expire[sd]?)\b`)
)

func parseLogTime(line string, year int, loc *time.Location) (time.Time, bool) {
	if m := reISOTime.FindStringSubmatch(line); m != nil {
		v, layout := m[1]+"T"+m[2], "2006-01-02T15:04:05"
		if m[3] != "" {
			z := m[3]
			if z != "Z" && !strings.Contains(z, ":") {
				z = z[:3] + ":" + z[3:]
			}
			if t, err := time.Parse(time.RFC3339, v+z); err == nil {
				return t.UTC(), true
			}
		}
		t, err := time.ParseInLocation(layout, v, loc)
		return t.UTC(), err == nil
	}
	if m := reSyslogTS.FindStringSubmatch(line); m != nil && year > 0 {
		t, err := time.ParseInLocation("2006 Jan 2 15:04:05", fmt.Sprintf("%d %s %s %s", year, m[1], m[2], m[3]), loc)
		return t.UTC(), err == nil
	}
	return time.Time{}, false
}

func public4(a netip.Addr) bool {
	p := netip.PrefixFrom(a, 32)
	return a.Is4() && !isCGNATPrivate(p) && !a.IsLoopback() && !a.IsUnspecified() && !a.IsMulticast()
}

// ParseCGNATLog lê o registro de NAT (ou o arquivo de mapeamento, quando fixedFrom != nil e as linhas não têm hora).
// year completa o carimbo do syslog tradicional (que não traz o ano); loc é o fuso do equipamento.
func ParseCGNATLog(text string, year int, loc *time.Location, fixedFrom *time.Time) CGNATImport {
	out := CGNATImport{Samples: []string{}}
	type key struct {
		priv, pub string
		ps, pe    int
	}
	open := map[key]int{} // índice da alocação ainda aberta
	reject := func(line string) {
		out.Rejected++
		if len(out.Samples) < 5 {
			out.Samples = append(out.Samples, maskLine(line))
		}
	}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		out.Lines++
		var priv, pub netip.Addr
		for _, m := range reIPv4.FindAllString(line, -1) {
			a, err := netip.ParseAddr(m)
			if err != nil {
				continue
			}
			if !priv.IsValid() && isCGNATPrivate(netip.PrefixFrom(a, 32)) && !strings.HasPrefix(m, "127.") {
				priv = a
			} else if !pub.IsValid() && public4(a) {
				pub = a
			}
		}
		pr := rePortRange.FindStringSubmatch(reTimeless(line))
		if !priv.IsValid() || !pub.IsValid() || pr == nil {
			reject(line)
			continue
		}
		ps, _ := strconv.Atoi(pr[1])
		pe, _ := strconv.Atoi(pr[2])
		if ps < 1 || pe > 65535 || pe < ps {
			reject(line)
			continue
		}
		at, okTime := parseLogTime(line, year, loc)
		if !okTime && fixedFrom == nil {
			reject(line)
			continue
		}
		k := key{priv.String(), pub.String(), ps, pe}
		if okTime && reRelease.MatchString(line) {
			if i, ok := open[k]; ok {
				t := at
				out.Mappings[i].ValidTo = &t
				delete(open, k)
				out.Accepted++
				continue
			}
			reject(line) // liberação sem a alocação correspondente neste arquivo
			continue
		}
		m := CGNATMapping{Private: priv.String() + "/32", Public: pub.String() + "/32", PortStart: ps, PortEnd: pe}
		if okTime {
			t := at
			m.ValidFrom = &t
		} else {
			t := *fixedFrom
			m.ValidFrom = &t
		}
		// O mesmo bloco público reatribuído encerra a alocação anterior desse bloco.
		for ok, i := range open {
			if ok.pub == k.pub && ok.ps == k.ps && ok.pe == k.pe && out.Mappings[i].ValidFrom.Before(*m.ValidFrom) {
				t := *m.ValidFrom
				out.Mappings[i].ValidTo = &t
				delete(open, ok)
			}
		}
		open[k] = len(out.Mappings)
		out.Mappings = append(out.Mappings, m)
		out.Accepted++
	}
	return out
}

// reTimeless tira hora e data da linha para a faixa de portas não casar com "10:00-11" ou "2026-11".
func reTimeless(line string) string {
	line = reISOTime.ReplaceAllString(line, " ")
	line = reSyslogTS.ReplaceAllString(line, " ")
	return reIPv4.ReplaceAllString(line, " ")
}

// maskLine devolve a linha rejeitada sem endereços (vai para a resposta da API como amostra do formato).
func maskLine(line string) string {
	line = reIPv4.ReplaceAllString(line, "IP")
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}

// ParseCGNATCSV lê a planilha neutra: private_ip,public_ip,port_start,port_end,start,end (start/end em RFC 3339;
// end vazio = vigente). Cabeçalho obrigatório, em qualquer ordem.
func ParseCGNATCSV(text string) (CGNATImport, error) {
	out := CGNATImport{Samples: []string{}}
	r := csv.NewReader(strings.NewReader(text))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return out, fmt.Errorf("CSV inválido: %w", err)
	}
	if len(rows) == 0 {
		return out, fmt.Errorf("CSV vazio")
	}
	col := map[string]int{}
	for i, h := range rows[0] {
		col[strings.ToLower(strings.TrimSpace(h))] = i
	}
	for _, need := range []string{"private_ip", "public_ip", "port_start", "port_end", "start"} {
		if _, ok := col[need]; !ok {
			return out, fmt.Errorf("coluna obrigatória ausente: %s", need)
		}
	}
	get := func(row []string, name string) string {
		if i, ok := col[name]; ok && i < len(row) {
			return strings.TrimSpace(row[i])
		}
		return ""
	}
	for _, row := range rows[1:] {
		out.Lines++
		priv, e1 := netip.ParseAddr(get(row, "private_ip"))
		pub, e2 := netip.ParseAddr(get(row, "public_ip"))
		ps, e3 := strconv.Atoi(get(row, "port_start"))
		pe, e4 := strconv.Atoi(get(row, "port_end"))
		from, e5 := time.Parse(time.RFC3339, get(row, "start"))
		if e1 != nil || e2 != nil || e3 != nil || e4 != nil || e5 != nil || !priv.Is4() || !public4(pub) || ps < 1 || pe > 65535 || pe < ps {
			out.Rejected++
			if len(out.Samples) < 5 {
				out.Samples = append(out.Samples, fmt.Sprintf("linha %d", out.Lines+1))
			}
			continue
		}
		f := from.UTC()
		m := CGNATMapping{Private: priv.String() + "/32", Public: pub.String() + "/32", PortStart: ps, PortEnd: pe, ValidFrom: &f}
		if v := get(row, "end"); v != "" {
			to, err := time.Parse(time.RFC3339, v)
			if err != nil || !to.After(from) {
				out.Rejected++
				continue
			}
			t := to.UTC()
			m.ValidTo = &t
		}
		out.Mappings = append(out.Mappings, m)
		out.Accepted++
	}
	return out, nil
}

// MappingsFromRules converte as regras exatas da configuração (sem período: valem enquanto a configuração valer).
func MappingsFromRules(rules []CGNATRule) []CGNATMapping {
	out := make([]CGNATMapping, 0, len(rules))
	for _, r := range rules {
		out = append(out, CGNATMapping{Private: r.Private, Public: r.Public, PortStart: r.PortStart, PortEnd: r.PortEnd})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Public != out[j].Public {
			return out[i].Public < out[j].Public
		}
		return out[i].PortStart < out[j].PortStart
	})
	return out
}

// CGNATMappingPrivate: dado o mapeamento que cobre o IP público, o endereço privado correspondente
// (mesmo deslocamento dentro dos blocos, como no netmap).
func CGNATMappingPrivate(privateCIDR, publicCIDR, ip string) (string, bool) {
	priv, ok1 := prefixOf(privateCIDR)
	pub, ok2 := prefixOf(publicCIDR)
	a, err := netip.ParseAddr(ip)
	if !ok1 || !ok2 || err != nil || !pub.Contains(a) || priv.Bits() != pub.Bits() {
		return "", false
	}
	return IPv4String(addr4(priv.Addr()) + addr4(a) - addr4(pub.Addr())), true
}
