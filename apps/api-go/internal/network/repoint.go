package network

import (
	"fmt"
	"regexp"
	"strings"
)

// Migração de concentrador MikroTik de outro ERP (SGP, IXC, MK-Auth...) para o RADIUS integrado.
//
// Estudo de campo (backup center, 2026-11): o ERP anterior não instala nada no equipamento além de /radius
// (use-radius, interim-update, CoA por /radius incoming) e, em ~38% dos MikroTik, um CLIENTE de VPN
// (l2tp/pptp/ovpn/sstp/wireguard) que o próprio equipamento disca até o servidor do ERP; o RADIUS privado do ERP
// é alcançado por esse túnel. Logo, migrar é: acrescentar o nosso RADIUS (e túnel, se houver), DESATIVAR — não
// apagar — o RADIUS do ERP anterior, e manter o túnel antigo até o fim da transição. Sessões PPPoE já
// conectadas não caem ao trocar o /radius: só as autenticações novas passam a vir para cá.

// RepointEntry descreve um objeto do ERP anterior encontrado no export (nunca carrega segredos).
type RepointEntry struct {
	Section string `json:"section"`
	Name    string `json:"name,omitempty"`
	Address string `json:"address,omitempty"`
	Comment string `json:"comment,omitempty"`
	ERP     string `json:"erp,omitempty"`
	Enabled bool   `json:"enabled"`
	// Services: serviços do /radius (ppp, login, hotspot, wireless, dhcp...). Só os de assinante passam para cá.
	Services []string `json:"services,omitempty"`
}

// RepointPlan é o resultado: o que existe hoje, o script de migração e o script de volta.
type RepointPlan struct {
	ERP      string         `json:"erp"`
	Radius   []RepointEntry `json:"radius"`
	VPN      []RepointEntry `json:"vpn"`
	CoA      bool           `json:"coa_enabled"`
	UseRadius bool           `json:"ppp_use_radius"`
	Apply    string         `json:"apply"`
	Rollback string         `json:"rollback"`
	Warnings []string       `json:"warnings"`
}

var (
	reTerseSection = regexp.MustCompile(`^(/[a-z0-9-]+(?: [a-z0-9-]+)*?)(?: ((?:add|set|remove)\b.*))?$`)
	reAttr         = regexp.MustCompile(`([a-z0-9-]+)=("(?:[^"\\]|\\.)*"|\S+)`)
	reOurComment   = regexp.MustCompile(`^nexoisp(-\d+)?$|^nexoisp:`)
	vpnSections    = []string{"/interface l2tp-client", "/interface pptp-client", "/interface ovpn-client", "/interface sstp-client", "/interface wireguard peers"}
)

// exportSections junta linhas de continuação ("\") e agrupa os comandos por seção; aceita o export "terse"
// (/secao add ... numa linha) e o formato com cabeçalho de seção.
func exportSections(text string) map[string][]string {
	out := map[string][]string{}
	var lines []string
	buf := ""
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		part := l
		if buf != "" {
			part = strings.TrimLeft(l, " ")
		}
		if strings.HasSuffix(l, "\\") {
			buf += strings.TrimSuffix(part, "\\")
			continue
		}
		lines = append(lines, buf+part)
		buf = ""
	}
	cur := ""
	for _, l := range lines {
		s := strings.TrimSpace(l)
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		if strings.HasPrefix(s, "/") {
			if m := reTerseSection.FindStringSubmatch(s); m != nil {
				cur = m[1]
				if m[2] != "" {
					out[cur] = append(out[cur], m[2])
				}
				continue
			}
		}
		if cur != "" {
			out[cur] = append(out[cur], s)
		}
	}
	return out
}

func exportAttrs(line string) map[string]string {
	attrs := map[string]string{}
	for _, m := range reAttr.FindAllStringSubmatch(line, -1) {
		attrs[m[1]] = strings.Trim(m[2], `"`)
	}
	return attrs
}

// erpOf classifica um rótulo/nome/destino pelo ERP que o criou.
func erpOf(texts ...string) string {
	low := strings.ToLower(strings.Join(texts, " "))
	switch {
	case strings.Contains(low, "sgp"):
		return "sgp"
	case strings.Contains(low, "ixc"):
		return "ixc"
	case strings.Contains(low, "mkauth") || strings.Contains(low, "mk-auth"):
		return "mkauth"
	case strings.Contains(low, "voalle"):
		return "voalle"
	case strings.Contains(low, "hubsoft"):
		return "hubsoft"
	}
	return ""
}

func quoteRos(v string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", `\$`).Replace(v) + `"`
}

// Padrões do RouterOS: o export omite o que está no padrão, então a volta usa estes valores.
var rosDefaults = map[string]string{"/radius incoming accept": "no", "/radius incoming port": "3799", "/ppp aaa use-radius": "no", "/ppp aaa accounting": "yes", "/ppp aaa interim-update": "0s"}

var subscriberService = map[string]bool{"ppp": true, "hotspot": true, "dhcp": true}

var safeRosValue = regexp.MustCompile(`^[A-Za-z0-9_.:/@\-]{1,128}$`)

// MikrotikRepoint lê o export do concentrador e monta a troca do RADIUS do ERP anterior pelo nosso.
// ours são os comandos do RADIUS integrado já renderizados para este concentrador (RadiusSetupData).
func MikrotikRepoint(export, ours string) RepointPlan {
	sec := exportSections(export)
	plan := RepointPlan{Radius: []RepointEntry{}, VPN: []RepointEntry{}, Warnings: []string{}}
	votes := map[string]int{}
	for _, line := range sec["/radius"] {
		if !strings.HasPrefix(line, "add ") {
			continue
		}
		a := exportAttrs(line)
		if reOurComment.MatchString(a["comment"]) {
			continue
		}
		e := RepointEntry{Section: "/radius", Address: a["address"], Comment: a["comment"], ERP: erpOf(a["comment"]), Enabled: a["disabled"] != "yes"}
		if v := a["service"]; v != "" {
			e.Services = strings.Split(v, ",")
		}
		plan.Radius = append(plan.Radius, e)
		if e.ERP != "" {
			votes[e.ERP]++
		}
	}
	for _, s := range vpnSections {
		for _, line := range sec[s] {
			if !strings.HasPrefix(line, "add ") {
				continue
			}
			a := exportAttrs(line)
			if reOurComment.MatchString(a["comment"]) || a["name"] == "nexoisp" {
				continue
			}
			dest := a["connect-to"]
			name := a["name"]
			if s == "/interface wireguard peers" {
				if a["endpoint-address"] == "" {
					continue // peer sem endpoint é servidor (alguém disca para cá), não cliente de ERP
				}
				dest, name = a["endpoint-address"], a["interface"]
			}
			e := RepointEntry{Section: s, Name: name, Address: dest, Comment: a["comment"], ERP: erpOf(a["comment"], name, dest), Enabled: a["disabled"] != "yes"}
			plan.VPN = append(plan.VPN, e)
			if e.ERP != "" {
				votes[e.ERP]++
			}
		}
	}
	plan.CoA = strings.Contains(strings.Join(sec["/radius incoming"], " "), "accept=yes")
	plan.UseRadius = strings.Contains(strings.Join(sec["/ppp aaa"], " "), "use-radius=yes")
	if low := strings.ToLower(export); votes["sgp"] == 0 && regexp.MustCompile(`sgpacesso|sgpolt|sgpsgp|importacao_sgp`).MatchString(low) {
		votes["sgp"]++
	}
	best := ""
	for erp, n := range votes {
		if best == "" || n > votes[best] || (n == votes[best] && erp < best) {
			best = erp
		}
	}
	if best == "" {
		best = "desconhecido"
	}
	plan.ERP = best

	var apply, rollback []string
	apply = append(apply,
		"# Migração do concentrador para o RADIUS integrado. Leia antes de colar:",
		"# - sessões PPPoE já conectadas NÃO caem; só os logins novos passam a autenticar aqui;",
		"# - o RADIUS do sistema anterior é DESATIVADO, não apagado (o script de volta o reativa);",
		"# - o túnel do sistema anterior continua de pé até o fim da transição (fase 2, abaixo).",
		"/export file=antes-da-migracao",
		"# 1. RADIUS integrado (e túnel, se houver)",
	)
	apply = append(apply, strings.Split(strings.TrimSpace(ours), "\n")...)
	apply = append(apply, "# 2. desativar o RADIUS do sistema anterior")
	disabled := 0
	for _, r := range plan.Radius {
		if !r.Enabled {
			continue
		}
		if !safeRosValue.MatchString(r.Address) {
			plan.Warnings = append(plan.Warnings, "RADIUS anterior com endereço não reconhecido: desative manualmente em /radius")
			continue
		}
		find := "/radius set [find where address=" + r.Address + " and !(comment~\"^nexoisp\")]"
		subscriber, other := []string{}, []string{}
		for _, sv := range r.Services {
			if subscriberService[sv] {
				subscriber = append(subscriber, sv)
			} else if safeRosValue.MatchString(sv) {
				other = append(other, sv)
			}
		}
		switch {
		case len(r.Services) > 0 && len(subscriber) == 0:
			// Ex.: RADIUS só de login de administrador ou de wireless: não é autenticação de assinante, fica como está.
			continue
		case len(other) > 0:
			// Atende assinante E outra coisa (login, wireless...): tira só os serviços de assinante, o resto continua.
			apply = append(apply, find+" service="+strings.Join(other, ","))
			rollback = append(rollback, find+" service="+strings.Join(r.Services, ","))
			plan.Warnings = append(plan.Warnings, "um RADIUS anterior também atende "+strings.Join(other, ",")+": só "+strings.Join(subscriber, ",")+" passa para o RADIUS integrado, o restante continua nele")
		default:
			apply = append(apply, find+" disabled=yes")
			rollback = append(rollback, find+" disabled=no")
		}
		disabled++
	}
	if len(plan.Radius) == 0 {
		plan.Warnings = append(plan.Warnings, "nenhum /radius do sistema anterior no export (usuários locais em /ppp secret? importe-os antes)")
	}
	if len(plan.VPN) > 0 {
		apply = append(apply, "# 3. fase 2 — só depois de validar logins e quedas por CoA vindos do RADIUS integrado:")
		for _, v := range plan.VPN {
			if !v.Enabled || !safeRosValue.MatchString(v.Name) {
				continue
			}
			iface := strings.TrimSuffix(v.Section, " peers")
			apply = append(apply, "# "+iface+" disable [find where name="+quoteRos(v.Name)+"]")
			rollback = append(rollback, iface+" enable [find where name="+quoteRos(v.Name)+"]")
		}
	}
	if !plan.CoA {
		plan.Warnings = append(plan.Warnings, "o concentrador não aceitava CoA/Disconnect: o sistema anterior suspendia por API/address-list; o RADIUS integrado passa a derrubar por CoA")
	}
	if len(sec["/ppp secret"]) > 0 {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("%d usuário(s) locais em /ppp secret: eles autenticam antes do RADIUS e continuam fora do NexoISP", len(sec["/ppp secret"])))
	}

	// Volta: apaga tudo o que o script criou (comment=nexoisp*) na ordem inversa e reativa o anterior.
	created := []string{}
	seen := map[string]bool{}
	for _, l := range strings.Split(ours, "\n") {
		m := reTerseSection.FindStringSubmatch(strings.TrimSpace(l))
		if m == nil || !strings.HasPrefix(m[2], "add ") || !strings.Contains(m[2], "comment=") || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		created = append(created, m[1])
	}
	back := []string{"# Volta ao sistema anterior: reativa o RADIUS antigo e remove o que a migração criou."}
	back = append(back, rollback...)
	for i := len(created) - 1; i >= 0; i-- {
		back = append(back, created[i]+" remove [find where comment~\"^nexoisp\"]")
	}
	// Restaura o que o script de migração muda por "set" (interim-update, porta/aceite de CoA), com os valores de antes.
	restore := func(section string, keys ...string) {
		if !strings.Contains(ours, section+" set ") {
			return
		}
		cur := map[string]string{}
		for _, l := range sec[section] {
			if strings.HasPrefix(l, "set ") || !strings.HasPrefix(l, "add ") {
				for k, v := range exportAttrs(l) {
					cur[k] = v
				}
			}
		}
		parts := []string{}
		for _, k := range keys {
			v, ok := cur[k]
			if !ok {
				v = rosDefaults[section+" "+k]
			}
			if v != "" && safeRosValue.MatchString(v) {
				parts = append(parts, k+"="+v)
			}
		}
		if len(parts) > 0 {
			back = append(back, section+" set "+strings.Join(parts, " "))
		}
	}
	restore("/radius incoming", "accept", "port")
	restore("/ppp aaa", "use-radius", "accounting", "interim-update")
	plan.Apply = strings.Join(apply, "\n") + "\n"
	plan.Rollback = strings.Join(back, "\n") + "\n"
	if disabled == 0 && len(plan.Radius) > 0 {
		plan.Warnings = append(plan.Warnings, "o RADIUS do sistema anterior já estava desativado")
	}
	return plan
}
