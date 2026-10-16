package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
	"nexoisp/api-go/internal/validate"
	"slices"
	"sort"
	"time"
)

func (s Service) nocOperations(ops map[string]operation) {
	ops["GET /api/noc/overview"] = operation{s.nocOverview, nil}
	ops["GET /api/contracts/:id/diagnosis"] = operation{s.diagnosis, nil}
}
func nocSettings(ctx context.Context, tx *db.Tx) (map[string]any, error) {
	r, err := one(ctx, tx, "helper:nocSettings", 0, auth.From(ctx).TenantID)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"onu_rx_min_dbm": nil, "pon_outage_min": float64(3), "onu_remove_on_contract_end": false}
	for k := range out {
		if v := r.Get(k); v != nil {
			out[k] = v
		}
	}
	if out["onu_rx_min_dbm"] != nil {
		out["onu_rx_min_dbm"] = validate.JSNumber(fmt.Sprint(out["onu_rx_min_dbm"]))
	}
	return out, nil
}
func outage(r jsonx.Object, threshold any) bool {
	return num(r.Get("down")) >= num(threshold) && num(r.Get("down"))*2 >= num(r.Get("total"))
}
func nocRank(value any) int {
	switch value {
	case "critical":
		return 0
	case "warning":
		return 1
	case "info":
		return 2
	default:
		return 3
	}
}
func (s Service) nocOverview(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	const key = "GET /api/noc/overview"
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	cfg, err := nocSettings(ctx, tx)
	if err != nil {
		return nil, err
	}
	data := make([][]jsonx.Object, 8)
	for i := range data {
		if i == 5 && cfg["onu_rx_min_dbm"] == nil {
			data[i] = []jsonx.Object{}
			continue
		}
		args := []any{}
		if i == 5 {
			args = append(args, cfg["onu_rx_min_dbm"])
		}
		data[i], err = rows(ctx, tx, key, i, args...)
		if err != nil {
			return nil, err
		}
	}
	agents, maintenance, ops, pons, down, weak, boxes := data[0], data[1], data[2], data[3], data[4], data[5], data[6]
	n := data[7][0]
	alerts := []map[string]any{}
	add := func(severity, kind, title, link string, detail any, items any) {
		a := map[string]any{"severity": severity, "kind": kind, "title": title}
		if link != "" {
			a["link"] = link
		}
		if detail != nil {
			a["detail"] = detail
		}
		if items != nil {
			a["items"] = items
		}
		alerts = append(alerts, a)
	}
	collective := map[string]bool{}
	for i, p := range pons {
		pons[i].Set("outage", outage(p, cfg["pon_outage_min"]))
		if outage(p, cfg["pon_outage_min"]) {
			collective[fmt.Sprint(p.Get("device_id"))+"|"+fmt.Sprint(p.Get("pon_port"))] = true
		}
	}
	for _, a := range agents {
		detail := "Nunca se conectou."
		if a.Get("last_seen_at") != nil {
			detail = fmt.Sprintf("Último contato em %v. Leituras e operações desse site estão paradas; o RADIUS local segue autenticando.", nocTime(a.Get("last_seen_at")))
		}
		add("critical", "agent_offline", fmt.Sprintf("Agente “%v” offline", a.Get("name")), "/rede", detail, nil)
	}
	for _, p := range pons {
		if outage(p, cfg["pon_outage_min"]) {
			add("critical", "pon_outage", fmt.Sprintf("Possível falha coletiva na PON %v de %v", p.Get("pon_port"), p.Get("device_name")), "/onus", fmt.Sprintf("%v de %v ONUs sem sinal (heurística: pelo menos %v e metade da porta). Última leitura em %v.", p.Get("down"), p.Get("total"), cfg["pon_outage_min"], nocTime(p.Get("read_at"))), nil)
		}
	}
	for _, b := range boxes {
		if b.Get("down") == b.Get("total") {
			add("critical", "box_down", fmt.Sprintf("Caixa %v: todas as %v ONUs sem sinal", b.Get("name"), b.Get("total")), "/ftth", nil, nil)
		}
	}
	uncertain, failed, isolated := []jsonx.Object{}, []jsonx.Object{}, []jsonx.Object{}
	for _, o := range ops {
		if o.Get("status") == "UNCERTAIN" {
			uncertain = append(uncertain, o)
		} else {
			failed = append(failed, o)
		}
	}
	for _, d := range down {
		if !collective[fmt.Sprint(d.Get("device_id"))+"|"+fmt.Sprint(d.Get("pon_port"))] {
			isolated = append(isolated, d)
		}
	}
	if len(uncertain) > 0 {
		add("critical", "ops_uncertain", fmt.Sprintf("%d operação(ões) com resultado incerto", len(uncertain)), "/operacoes?filter=problem", "O equipamento fica bloqueado para novas escritas até o agente verificar o que foi aplicado.", uncertain)
	}
	if len(isolated) > 0 {
		add("warning", "onu_down", fmt.Sprintf("%d ONU(s) sem sinal fora de falha coletiva", len(isolated)), "/onus", nil, isolated[:min(len(isolated), 50)])
	}
	if len(weak) > 0 {
		add("warning", "onu_weak", fmt.Sprintf("%d ONU(s) com sinal abaixo de %v dBm", len(weak), cfg["onu_rx_min_dbm"]), "/onus", nil, weak)
	}
	if num(n.Get("drift")) > 0 {
		add("warning", "drift", fmt.Sprintf("%v conta(s) PPPoE divergentes da intenção", n.Get("drift")), "/operacoes?filter=problem", "Possível alteração manual no RADIUS/NAS. Nada é corrigido sozinho.", nil)
	}
	if len(failed) > 0 {
		add("warning", "ops_failed", fmt.Sprintf("%d operação(ões) falharam ou expiraram em 24 h", len(failed)), "/operacoes?filter=problem", nil, failed)
	}
	if num(n.Get("work_orders_late")) > 0 {
		add("warning", "os_late", fmt.Sprintf("%v ordem(ns) de serviço com agendamento vencido", n.Get("work_orders_late")), "/ordens-servico", nil, nil)
	}
	if num(n.Get("stale")) > 0 {
		add("info", "stale", fmt.Sprintf("%v ONU(s) sem leitura há mais de 10 min com o agente online", n.Get("stale")), "", nil, nil)
	}
	for _, d := range maintenance {
		add("info", "maintenance", fmt.Sprintf("%v em modo manutenção", d.Get("name")), "/rede", "O ERP não envia escritas a este equipamento.", nil)
	}
	sort.SliceStable(alerts, func(i, j int) bool { return nocRank(alerts[i]["severity"]) < nocRank(alerts[j]["severity"]) })
	n.Set("onus_down", len(down))
	n.Set("agents_offline", len(agents))
	return map[string]any{"generated_at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "settings": cfg, "counters": n, "alerts": alerts, "pons": pons}, nil
}
func (s Service) diagnosis(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "GET /api/contracts/:id/diagnosis"
	if err := network.Sweep(ctx, tx); err != nil {
		return nil, err
	}
	k, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	cfg, err := nocSettings(ctx, tx)
	if err != nil {
		return nil, err
	}
	r, err := one(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	onu, err := one(ctx, tx, key, 2, id)
	if err != nil {
		return nil, err
	}
	last, err := one(ctx, tx, key, 3, r.Get("id"), onu.Get("id"))
	if err != nil {
		return nil, err
	}
	var pon jsonx.Object
	if onu != nil {
		pon, err = one(ctx, tx, key, 4, onu.Get("device_id"), onu.Get("pon_port"))
		if err != nil {
			return nil, err
		}
	}
	drop, err := one(ctx, tx, key, 5, id)
	if err != nil {
		return nil, err
	}
	var fin jsonx.Object
	if slices.Contains(auth.From(ctx).Permissions, "finance:read") {
		fin, err = one(ctx, tx, key, 6, id)
		if err != nil {
			return nil, err
		}
	}
	open, err := one(ctx, tx, key, 7, id)
	if err != nil {
		return nil, err
	}
	findings := []map[string]any{}
	add := func(severity, code, title string, evidence []map[string]any, suggestion string) {
		f := map[string]any{"severity": severity, "code": code, "title": title, "evidence": evidence}
		if suggestion != "" {
			f["suggestion"] = suggestion
		}
		findings = append(findings, f)
	}
	ev := func(label string, value, at any) map[string]any {
		return map[string]any{"label": label, "value": value, "at": at}
	}
	fallback := func(v any) string {
		if v == nil {
			return "—"
		}
		return jsonx.String(v)
	}
	if k.Get("status") != "active" {
		hint := ""
		if onu.Get("desired_state") == "authorized" {
			hint = "A ONU continua autorizada na OLT: desautorize se o equipamento foi retirado."
		}
		add("info", "contract_ended", "Contrato encerrado", []map[string]any{{"label": "Encerrado em", "value": fallback(k.Get("end_date"))}}, hint)
	}
	if r == nil || num(r.Get("desired_version")) == 0 {
		hint := ""
		if k.Get("status") == "active" {
			hint = "Use “Provisionar acesso” no contrato."
		}
		add("info", "not_provisioned", "Acesso PPPoE ainda não provisionado", []map[string]any{}, hint)
	}
	if r != nil {
		observed := "nunca lido"
		if r.Get("observed_at") != nil {
			observed = jsonx.String(r.Get("observed_policy"))
			if jsonx.Truthy(r.Get("observed_profile")) {
				observed += " · perfil " + jsonx.String(r.Get("observed_profile"))
			}
		}
		evidence := []map[string]any{ev("Intenção", fmt.Sprintf("%v · perfil %v · v%v", r.Get("desired_policy"), r.Get("desired_profile"), r.Get("desired_version")), r.Get("desired_at")), ev("Lido no RADIUS/NAS", observed, r.Get("observed_at"))}
		if r.Get("agent_online") != true {
			name := ""
			if jsonx.Truthy(r.Get("agent_name")) {
				name = fmt.Sprintf("“%v” ", r.Get("agent_name"))
			}
			value := "nunca"
			if r.Get("agent_last_seen") != nil {
				value = "ver data"
			}
			add("critical", "agent_offline", "Agente "+name+"offline: os dados abaixo podem estar desatualizados", []map[string]any{ev("Último contato do agente", value, r.Get("agent_last_seen"))}, "Verifique o servidor do agente no provedor. O RADIUS local continua autenticando com a última política conhecida.")
		}
		if r.Get("maintenance") == true {
			add("info", "maintenance", fmt.Sprintf("Equipamento %v em modo manutenção: operações aguardam", r.Get("device_name")), []map[string]any{}, "")
		}
		if last != nil && slices.Contains([]string{"UNCERTAIN", "FAILED", "EXPIRED"}, fmt.Sprint(last.Get("status"))) {
			severity, hint := "warning", "Veja as evidências da operação e use “Reaplicar”."
			if last.Get("status") == "UNCERTAIN" {
				severity, hint = "critical", "Aguarde o agente verificar o que foi aplicado; não repita manualmente."
			}
			add(severity, "operation_problem", fmt.Sprintf("Última operação (%v) terminou como %v", last.Get("action"), last.Get("status")), []map[string]any{ev("Nota", fallback(last.Get("note")), last.Get("updated_at"))}, hint)
		}
		if num(r.Get("desired_version")) > 0 && r.Get("desired_policy") == "suspended" {
			title := "Acesso suspenso pelo sistema"
			if jsonx.Truthy(r.Get("desired_reason")) {
				title += fmt.Sprintf(": %v", r.Get("desired_reason"))
			}
			financial := map[string]any{"label": "Financeiro", "value": "não visível para o seu perfil"}
			if fin != nil {
				financial = map[string]any{"label": "Faturas vencidas", "value": fmt.Sprintf("%v (mais antiga: %s)", fin.Get("overdue"), fallback(fin.Get("oldest_due")))}
			}
			add("warning", "suspended", title, append(slices.Clone(evidence), financial), "O assinante não navega enquanto a intenção for “suspenso”. Reative pelo contrato ou regularize o pagamento, conforme a política do provedor.")
		}
		if r.Get("drift") == true {
			add("warning", "drift", "O que está aplicado difere do que o sistema pediu", evidence, "Provável alteração manual no RADIUS ou no NAS. Use “Reaplicar” ou ajuste a intenção.")
		}
		if num(r.Get("desired_version")) > 0 && r.Get("desired_policy") == "active" && r.Get("observed_policy") == "active" && r.Get("drift") != true {
			ses, _ := r.Get("observed_session").(jsonx.Object)
			if jsonx.Truthy(ses.Get("online")) {
				evs := []map[string]any{ev("Endereço", fallback(ses.Get("ip")), r.Get("observed_at"))}
				if jsonx.Truthy(ses.Get("uptime")) {
					evs = append(evs, map[string]any{"label": "Tempo de conexão", "value": jsonx.String(ses.Get("uptime"))})
				}
				add("ok", "session_online", "Sessão PPPoE online", evs, "")
			} else if jsonx.Truthy(ses.Get("unknown")) {
				add("info", "session_unknown", "Não foi possível consultar sessões no NAS", []map[string]any{ev("Erro", fallback(ses.Get("error")), r.Get("observed_at"))}, "")
			} else {
				hint := "A autorização está correta: verifique o roteador do assinante (usuário/senha PPPoE, cabo, energia)."
				if onu != nil {
					hint = "A autorização está correta: veja o estado da ONU abaixo."
				}
				add("warning", "no_session", "Acesso liberado, mas sem sessão PPPoE", evidence, hint)
			}
		}
	}
	if onu != nil && onu.Get("desired_state") == "authorized" {
		evidence := []map[string]any{ev("ONU", fmt.Sprintf("%v · %v · PON %v", onu.Get("serial"), onu.Get("device_name"), onu.Get("pon_port")), onu.Get("observed_at"))}
		if drop != nil {
			evidence = append(evidence, map[string]any{"label": "Caixa / porta", "value": fmt.Sprintf("%v · %v", drop.Get("box_name"), drop.Get("port"))})
		}
		down := onu.Get("observed_at") != nil && (onu.Get("observed_state") == "absent" || onu.Get("observed_online") == false)
		ponEvidence := func() []map[string]any {
			out := slices.Clone(evidence)
			if pon != nil {
				out = append(out, ev(fmt.Sprintf("PON %v", onu.Get("pon_port")), fmt.Sprintf("%v de %v ONUs sem sinal", pon.Get("down"), pon.Get("total")), pon.Get("read_at")))
			}
			return out
		}
		switch {
		case onu.Get("observed_at") == nil:
			add("info", "onu_unread", "ONU ainda não foi lida na OLT", evidence, "")
		case onu.Get("observed_state") == "absent":
			add("warning", "onu_absent", "ONU não está autorizada na OLT, embora devesse", evidence, "Possível remoção manual na OLT. Use “Reaplicar” na ONU do contrato.")
		case down && pon != nil && outage(pon, cfg["pon_outage_min"]):
			add("critical", "pon_outage", "ONU offline junto com outras da mesma porta PON: provável problema na rede óptica", ponEvidence(), "Não adianta visita individual: verifique a fibra de alimentação, o splitter e a porta da OLT.")
		case down:
			add("warning", "onu_offline", "ONU offline; as vizinhas da mesma PON estão normais: provável problema no endereço do assinante", ponEvidence(), "Confirme energia da ONU e o cabo drop. Se persistir, abra uma ordem de serviço de reparo.")
		default:
			rx := onu.Get("observed_rx_dbm")
			weak := cfg["onu_rx_min_dbm"] != nil && rx != nil && validate.JSNumber(fmt.Sprint(rx)) < num(cfg["onu_rx_min_dbm"])
			if weak {
				add("warning", "onu_weak", fmt.Sprintf("Sinal óptico abaixo do limite do provedor (%v dBm)", cfg["onu_rx_min_dbm"]), append(slices.Clone(evidence), ev("RX", fmt.Sprintf("%.2f dBm", validate.JSNumber(fmt.Sprint(rx))), onu.Get("observed_at"))), "Verifique conectores, emendas e curvatura do drop.")
			} else {
				if rx != nil {
					value := fmt.Sprintf("%.2f dBm", validate.JSNumber(fmt.Sprint(rx)))
					if cfg["onu_rx_min_dbm"] == nil {
						value += " (o provedor não definiu limite)"
					}
					evidence = append(evidence, ev("RX", value, onu.Get("observed_at")))
				}
				add("ok", "onu_ok", "ONU online na OLT", evidence, "")
			}
		}
		at, _ := time.Parse(time.RFC3339Nano, nocTime(onu.Get("observed_at")))
		if onu.Get("agent_online") == true && !at.IsZero() && time.Since(at) > 10*time.Minute {
			add("info", "onu_stale", "Leitura da ONU com mais de 10 min", []map[string]any{ev("Lida em", "ver data", onu.Get("observed_at"))}, "")
		}
	}
	if num(open.Get("work_orders")) > 0 || num(open.Get("tickets")) > 0 {
		add("info", "already_open", "Já há atendimento em andamento para este assinante", []map[string]any{{"label": "Ordens de serviço abertas", "value": jsonx.String(open.Get("work_orders"))}, {"label": "Atendimentos abertos", "value": jsonx.String(open.Get("tickets"))}}, "")
	}
	sort.SliceStable(findings, func(i, j int) bool { return nocRank(findings[i]["severity"]) < nocRank(findings[j]["severity"]) })
	verdict, severity := "Sem dados suficientes para concluir", "ok"
	for _, f := range findings {
		if f["severity"] == "ok" {
			verdict = "Nenhum problema encontrado nos dados disponíveis"
		}
	}
	if len(findings) > 0 && nocRank(findings[0]["severity"]) < 2 {
		verdict = fmt.Sprint(findings[0]["title"])
		severity = fmt.Sprint(findings[0]["severity"])
	}
	return map[string]any{"generated_at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "subscriber_name": k.Get("subscriber_name"), "verdict": verdict, "severity": severity, "findings": findings, "limits": "Diagnóstico por regras fixas sobre leituras já coletadas; não testa a conexão em tempo real nem enxerga dentro da casa do assinante."}, nil
}

func nocTime(v any) string {
	if t, ok := v.(jsonx.Time); ok {
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return fmt.Sprint(v)
}
