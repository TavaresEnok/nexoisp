package network

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"
)

// Usuários PPPoE locais do concentrador (/ppp secret) viram o CSV de assinantes do importador (docs/importacao-csv.md).
// Em campo, parte dos MikroTik ainda autentica alguns clientes localmente (antes do RADIUS do ERP): sem importá-los,
// eles ficam fora do NexoISP depois da troca do RADIUS. O formato do /export do RouterOS é conhecido e estável, ao
// contrário das planilhas de cada ERP — por isso este é o único "preset" automático: nada de adivinhar colunas do SGP/IXC.

type PPPSecretImport struct {
	CSV      string         `json:"csv"`
	Rows     int            `json:"rows"`
	Profiles map[string]int `json:"profiles"`
	Skipped  int            `json:"skipped"`
	Warnings []string       `json:"warnings"`
}

var reMAC = regexp.MustCompile(`^(?i)[0-9a-f]{2}(:[0-9a-f]{2}){5}$`)

// PPPSecretsCSV gera o CSV "subscribers": id_externo (mk:<usuário>), nome (comentário ou usuário), pppoe_usuario,
// pppoe_senha, plano (perfil do PPP), ip_fixo (remote-address quando é um IP), mac (caller-id quando é MAC) e situacao.
func PPPSecretsCSV(export string) PPPSecretImport {
	out := PPPSecretImport{Profiles: map[string]int{}, Warnings: []string{}}
	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"id_externo", "nome", "pppoe_usuario", "pppoe_senha", "plano", "ip_fixo", "mac", "situacao", "observacoes"})
	seen := map[string]bool{}
	noPassword := 0
	for _, line := range exportSections(export)["/ppp secret"] {
		if !strings.HasPrefix(line, "add ") {
			continue
		}
		a := exportAttrs(line)
		name := a["name"]
		if name == "" || seen[name] || (a["service"] != "" && a["service"] != "any" && a["service"] != "pppoe") {
			out.Skipped++
			continue
		}
		seen[name] = true
		profile := a["profile"]
		if profile == "" {
			profile = "default"
		}
		out.Profiles[profile]++
		ip := ""
		if v, err := netip.ParseAddr(a["remote-address"]); err == nil && v.Is4() {
			ip = v.String()
		}
		mac := ""
		if reMAC.MatchString(a["caller-id"]) {
			mac = strings.ToUpper(a["caller-id"])
		}
		status := "ativo"
		if a["disabled"] == "yes" {
			status = "inativo"
		}
		display := strings.TrimSpace(a["comment"])
		if display == "" {
			display = name
		}
		if a["password"] == "" {
			noPassword++
		}
		_ = w.Write([]string{"mk:" + name, display, name, a["password"], profile, ip, mac, status, "importado do /ppp secret do concentrador"})
		out.Rows++
	}
	w.Flush()
	out.CSV = buf.String()
	if out.Rows == 0 {
		out.Warnings = append(out.Warnings, "nenhum usuário PPPoE local (/ppp secret) no export")
	}
	if noPassword > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf("%d usuário(s) sem senha no export: exporte com 'show-sensitive' (RouterOS 7) para trazer as senhas", noPassword))
	}
	if len(out.Profiles) > 0 {
		names := make([]string, 0, len(out.Profiles))
		for p := range out.Profiles {
			names = append(names, p)
		}
		sort.Strings(names)
		out.Warnings = append(out.Warnings, "o plano de cada linha é o perfil do PPP ("+strings.Join(names, ", ")+"): crie planos com esses nomes ou ajuste a coluna antes de aplicar")
	}
	return out
}
