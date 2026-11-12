package network

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Troca do RADIUS em concentrador Huawei (NE8000/NE20, VRP) e Cisco (ASR1000, IOS-XE), a partir da configuração
// atual. Estudo do backup center (12/11/2026, 57 Huawei e 2 Cisco com RADIUS):
//   - Huawei: o ERP cria "radius-server group <g>" (+ "radius-server authorization ... server-group <g>" para CoA) e
//     esquemas próprios; os domínios de assinante apontam para o grupo ("radius-server group <g>" dentro de "domain").
//     A troca cria o nosso grupo/esquemas e aponta SÓ os domínios que usam o grupo do ERP; o grupo do ERP fica.
//   - Cisco: o ERP usa listas NOMEADAS ("aaa authentication ppp <lista> group <grupo>"), referenciadas pelos
//     bba-group/virtual-template. A troca redefine as mesmas listas para o nosso grupo — nada nos templates muda.
// Sessões já conectadas seguem; logins novos usam o RADIUS integrado. Segredos do ERP nunca entram nos scripts.

var (
	reHwGroup  = regexp.MustCompile(`^radius-server group (\S+)`)
	reHwDomain = regexp.MustCompile(`^ domain (\S+)`)
	reHwInDom  = regexp.MustCompile(`^  (radius-server group|authentication-scheme|accounting-scheme) (\S+)`)
	reHwCoA    = regexp.MustCompile(`^radius-server authorization .*server-group (\S+)`)
	reCiscoGrp = regexp.MustCompile(`^aaa group server radius (\S+)`)
	reCiscoMl  = regexp.MustCompile(`^aaa (authentication ppp|authorization (?:network|subscriber-service|configuration)|accounting network) (\S+) (.*)$`)
	reCiscoCli = regexp.MustCompile(`^ client (\S+)`)
	safeName   = regexp.MustCompile(`^[A-Za-z0-9_.:@-]{1,64}$`)
)

type hwDomain struct{ name, group, auth, acct string }

// HuaweiRepoint: config é o "display current-configuration"; ours são os comandos do RADIUS integrado (vendor huawei).
func HuaweiRepoint(config, ours string) RepointPlan {
	plan := RepointPlan{Radius: []RepointEntry{}, VPN: []RepointEntry{}, Warnings: []string{}}
	groups := map[string]bool{}
	domains := []hwDomain{}
	inAAA := false
	var cur *hwDomain
	for _, raw := range strings.Split(strings.ReplaceAll(config, "\r", ""), "\n") {
		line := strings.TrimRight(raw, " ")
		if m := reHwGroup.FindStringSubmatch(line); m != nil {
			groups[m[1]] = true
		}
		if m := reHwCoA.FindStringSubmatch(line); m != nil && m[1] != "nexoisp" {
			plan.CoA = true
		}
		if line == "aaa" {
			inAAA = true
			continue
		}
		if inAAA && line != "" && !strings.HasPrefix(line, " ") {
			inAAA, cur = false, nil
		}
		if !inAAA {
			continue
		}
		if m := reHwDomain.FindStringSubmatch(line); m != nil {
			domains = append(domains, hwDomain{name: m[1]})
			cur = &domains[len(domains)-1]
			continue
		}
		if strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "  ") {
			cur = nil
		}
		if m := reHwInDom.FindStringSubmatch(line); m != nil && cur != nil {
			switch m[1] {
			case "radius-server group":
				cur.group = m[2]
			case "authentication-scheme":
				cur.auth = m[2]
			case "accounting-scheme":
				cur.acct = m[2]
			}
		}
	}
	names := make([]string, 0, len(groups))
	for g := range groups {
		if g != "nexoisp" {
			names = append(names, g)
		}
	}
	sort.Strings(names)
	votes := map[string]int{}
	for _, g := range names {
		e := RepointEntry{Section: "radius-server group", Name: g, ERP: erpOf(g), Enabled: true}
		plan.Radius = append(plan.Radius, e)
		if e.ERP != "" {
			votes[e.ERP]++
		}
	}
	plan.ERP = bestERP(votes, config)
	plan.UseRadius = len(names) > 0
	target := erpTargets(plan.Radius)
	if len(names) > 1 && len(target) == len(names) {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("nenhum dos %d grupos RADIUS tem o nome do sistema anterior: o plano redireciona todos os domínios que usam grupo RADIUS — confira a lista antes de aplicar", len(names)))
	}

	apply := []string{"# Troca do RADIUS (Huawei VRP). Sessões conectadas seguem; logins novos usam o RADIUS integrado.",
		"# O grupo do sistema anterior NÃO é apagado: o script de volta reaponta os domínios para ele.", "system-view"}
	apply = append(apply, strings.Split(strings.TrimSpace(ours), "\n")...)
	back := []string{"# Volta ao sistema anterior: reaponta os domínios e remove o que a migração criou.", "system-view", "aaa"}
	moved, kept := 0, 0
	apply = append(apply, "aaa")
	for _, d := range domains {
		if d.group == "" || d.group == "nexoisp" || !safeName.MatchString(d.name) || !safeName.MatchString(d.group) {
			continue
		}
		if !target[d.group] {
			kept++
			continue
		}
		apply = append(apply, " domain "+d.name, "  authentication-scheme nexoisp", "  accounting-scheme nexoisp", "  radius-server group nexoisp", " quit")
		back = append(back, " domain "+d.name)
		if safeName.MatchString(d.auth) {
			back = append(back, "  authentication-scheme "+d.auth)
		}
		if safeName.MatchString(d.acct) {
			back = append(back, "  accounting-scheme "+d.acct)
		}
		back = append(back, "  radius-server group "+d.group, " quit")
		moved++
	}
	apply = append(apply, "quit", "commit", "return")
	back = append(back, " undo domain nexoisp", " undo authentication-scheme nexoisp", " undo accounting-scheme nexoisp", "quit")
	for _, l := range strings.Split(ours, "\n") {
		if m := regexp.MustCompile(`^radius-server authorization (\S+)`).FindStringSubmatch(l); m != nil {
			back = append(back, "undo radius-server authorization "+m[1])
		}
	}
	back = append(back, "undo radius-server group nexoisp", "commit", "return")
	if moved == 0 {
		plan.Warnings = append(plan.Warnings, "nenhum domínio aponta para um grupo RADIUS: confira os domínios de assinante antes de aplicar")
	}
	if kept > 0 {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("%d domínio(s) usam grupo RADIUS que não é do sistema anterior e ficam como estão: confira se também são de assinante", kept))
	}
	if !plan.CoA {
		plan.Warnings = append(plan.Warnings, "o sistema anterior não usava CoA (radius-server authorization): o RADIUS integrado passa a desconectar por CoA")
	}
	plan.Warnings = append(plan.Warnings, "comandos para VRP com commit em dois estágios (NE8000/NE20); revise em janela, com acesso de console")
	plan.Apply = strings.Join(apply, "\n") + "\n"
	plan.Rollback = strings.Join(back, "\n") + "\n"
	return plan
}

// CiscoRepoint: config é o "show running-config"; ours são os comandos do RADIUS integrado (vendor cisco).
func CiscoRepoint(config, ours string) RepointPlan {
	plan := RepointPlan{Radius: []RepointEntry{}, VPN: []RepointEntry{}, Warnings: []string{}}
	groups := map[string]bool{}
	lists := []string{}
	inDyn := false
	clients := []string{}
	periodic := ""
	for _, raw := range strings.Split(strings.ReplaceAll(config, "\r", ""), "\n") {
		line := strings.TrimRight(raw, " ")
		if m := reCiscoGrp.FindStringSubmatch(line); m != nil && m[1] != "NEXOISP" {
			groups[m[1]] = true
		}
		if m := reCiscoMl.FindStringSubmatch(line); m != nil {
			lists = append(lists, line)
		}
		if strings.HasPrefix(line, "aaa accounting update periodic ") {
			periodic = line
		}
		if line == "aaa server radius dynamic-author" {
			inDyn = true
			continue
		}
		if inDyn && !strings.HasPrefix(line, " ") {
			inDyn = false
		}
		if m := reCiscoCli.FindStringSubmatch(line); m != nil && inDyn {
			clients = append(clients, m[1])
		}
	}
	plan.CoA = len(clients) > 0
	votes := map[string]int{}
	names := []string{}
	for g := range groups {
		names = append(names, g)
	}
	sort.Strings(names)
	for _, g := range names {
		e := RepointEntry{Section: "aaa group server radius", Name: g, ERP: erpOf(g), Enabled: true}
		plan.Radius = append(plan.Radius, e)
		if e.ERP != "" {
			votes[e.ERP]++
		}
	}
	plan.ERP = bestERP(votes, config)
	plan.UseRadius = len(names) > 0

	apply := []string{"! Troca do RADIUS (Cisco IOS-XE). As listas de método mantêm o nome: bba-group e virtual-template não mudam.",
		"! O grupo do sistema anterior NÃO é apagado: o script de volta redefine as listas como estavam.", "configure terminal"}
	for _, l := range strings.Split(strings.TrimSpace(ours), "\n") {
		if reCiscoMl.MatchString(l) || strings.HasPrefix(l, "aaa authentication ppp default") || strings.HasPrefix(l, "aaa authorization network default") || strings.HasPrefix(l, "aaa accounting network default") {
			continue // as listas são redefinidas abaixo a partir das que existem
		}
		apply = append(apply, l)
	}
	back := []string{"! Volta ao sistema anterior.", "configure terminal"}
	moved := 0
	target := erpTargets(plan.Radius)
	if len(names) > 1 && len(target) == len(names) {
		plan.Warnings = append(plan.Warnings, fmt.Sprintf("nenhum dos %d grupos RADIUS tem o nome do sistema anterior: o plano redireciona todas as listas que usam grupo RADIUS — confira antes de aplicar", len(names)))
	}
	for _, l := range lists {
		m := reCiscoMl.FindStringSubmatch(l)
		rest := m[3]
		changed := false
		for _, g := range names {
			if !target[g] {
				continue
			}
			if strings.Contains(" "+rest+" ", " group "+g+" ") {
				rest = strings.Replace(" "+rest+" ", " group "+g+" ", " group NEXOISP ", 1)
				rest = strings.TrimSpace(rest)
				changed = true
			}
		}
		if !changed || !safeName.MatchString(m[2]) {
			continue
		}
		apply = append(apply, "aaa "+m[1]+" "+m[2]+" "+rest)
		back = append(back, l)
		moved++
	}
	apply = append(apply, "end")
	if periodic != "" {
		back = append(back, periodic)
	}
	back = append(back, "no aaa group server radius NEXOISP", "no radius server nexoisp", "aaa server radius dynamic-author")
	for _, l := range strings.Split(ours, "\n") {
		if m := regexp.MustCompile(`^ client (\S+)`).FindStringSubmatch(l); m != nil {
			back = append(back, " no client "+m[1])
		}
	}
	back = append(back, "end")
	if moved == 0 {
		plan.Warnings = append(plan.Warnings, "nenhuma lista de método (aaa authentication ppp ...) usa um grupo RADIUS: confira antes de aplicar")
	}
	plan.Warnings = append(plan.Warnings, "Cisco não foi exercitado em equipamento: revise em janela, com acesso de console")
	plan.Apply = strings.Join(apply, "\n") + "\n"
	plan.Rollback = strings.Join(back, "\n") + "\n"
	return plan
}

// erpTargets: grupos a redirecionar. Havendo grupos com o nome do ERP, só eles; senão todos (com aviso no plano).
func erpTargets(entries []RepointEntry) map[string]bool {
	out, labeled := map[string]bool{}, false
	for _, e := range entries {
		if e.ERP != "" {
			labeled = true
		}
	}
	for _, e := range entries {
		if !labeled || e.ERP != "" {
			out[e.Name] = true
		}
	}
	return out
}

func bestERP(votes map[string]int, config string) string {
	if votes["sgp"] == 0 && regexp.MustCompile(`(?i)sgpacesso|sgpolt|sgpsgp|importacao_sgp`).MatchString(config) {
		votes["sgp"]++
	}
	best := ""
	for erp, n := range votes {
		if best == "" || n > votes[best] || (n == votes[best] && erp < best) {
			best = erp
		}
	}
	if best == "" {
		return "desconhecido"
	}
	return best
}
