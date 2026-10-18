package escrita

import (
	"context"
	"fmt"
	"net/url"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/csvx"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"sort"
	"strings"
	"time"
)

func (s Service) reportOperations(ops map[string]operation) {
	handlers := map[string]handler{"GET /api/anatel/dici": s.dici, "GET /api/contracts/:id/sessions": s.contractSessions, "GET /api/network/online": s.online, "GET /api/documents/:id/download": s.documentDownload, "GET /api/finance/export": s.financeExport, "GET /api/subscribers/:id/lgpd-export": s.lgpdExport, "GET /api/reports/commissions": s.commissions}
	for _, suffix := range []string{"aging", "receipts", "without-invoice", "to-cancel"} {
		key := "GET /api/finance/reports/" + suffix
		handlers[key] = func(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
			return s.financeReport(ctx, tx, key)
		}
	}
	for key, handler := range handlers {
		ops[key] = operation{handler, nil}
	}
}
func reportQuery(ctx context.Context) validate.Query {
	return validate.Query{Values: httpx.Request(ctx).URL.Query()}
}
func textNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func simpleCSV(columns []string, rows []jsonx.Object, money map[string]bool) []byte {
	lines := []string{strings.Join(columns, ";")}
	for _, row := range rows {
		cells := []string{}
		for _, col := range columns {
			value := row.Get(col)
			if value == nil {
				cells = append(cells, "")
				continue
			}
			if money[col] {
				cells = append(cells, brl(num(value)))
				continue
			}
			if date, ok := value.(jsonx.Time); ok {
				value = date.UTC().Format("Mon Jan 02 2006 15:04:05") + " GMT+0000 (Coordinated Universal Time)"
			}
			cells = append(cells, csvx.Cell(value))
		}
		lines = append(lines, strings.Join(cells, ";"))
	}
	return []byte("\ufeff" + strings.Join(lines, "\r\n") + "\r\n")
}
func brl(cents float64) string { return strings.ReplaceAll(fmt.Sprintf("%.2f", cents/100), ".", ",") }
func (s Service) documentDownload(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "GET /api/documents/:id/download", 0, "documento não encontrado", id)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "document.download", "document", id, map[string]any{"subscriber_id": row.Get("subscriber_id")}); err != nil {
		return nil, err
	}
	return endpoint.Result{Raw: row.Get("content").([]byte), ContentType: row.Get("mime").(string), CacheControl: "private, no-store", CSP: "default-src 'none'; sandbox", Disposition: "attachment; filename*=UTF-8''" + uriComponent(row.Get("name").(string))}, nil
}
func (s Service) lgpdExport(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "GET /api/subscribers/:id/lgpd-export"
	sub, err := mustRow(ctx, tx, key, 0, "assinante não encontrado", id)
	if err != nil {
		return nil, err
	}
	data := jsonx.Object{{Name: "generated_at", Value: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, {Name: "note", Value: "Cópia dos dados pessoais deste titular mantidos pelo provedor. Não inclui o que pertence a terceiros nem segredos de acesso."}, {Name: "subscriber", Value: sub}}
	for i, name := range []string{"contacts", "contracts", "invoices", "tickets", "work_orders", "notes", "documents", "acceptances", "connections", "portal_access"} {
		r, err := rows(ctx, tx, key, i+1, id)
		if err != nil {
			return nil, err
		}
		data.Set(name, r)
	}
	if err = record(ctx, tx, "subscriber.lgpd_export", "subscriber", id, nil); err != nil {
		return nil, err
	}
	return endpoint.Result{Value: data, Disposition: `attachment; filename="dados-do-titular-` + id[:8] + `.json"`}, nil
}
func (s Service) contractSessions(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "GET /api/contracts/:id/sessions"
	q := reportQuery(ctx)
	from, to := q.Date("from", false, "Invalid"), q.Date("to", false, "Invalid")
	format := q.Enum("format", "json", "json", "csv")
	if err := q.Err(); err != nil {
		return nil, err
	}
	list, err := rows(ctx, tx, key, 0, id, textNil(from), textNil(to))
	if err != nil {
		return nil, err
	}
	if format == "csv" {
		detail := map[string]any{"format": format}
		if from != "" {
			detail["from"] = from
		}
		if to != "" {
			detail["to"] = to
		}
		if err = record(ctx, tx, "contract.sessions_export", "contract", id, detail); err != nil {
			return nil, err
		}
		return endpoint.Result{CSV: simpleCSV([]string{"started_at", "stopped_at", "ip", "mac", "nas_ip", "seconds", "bytes_in", "bytes_out", "terminate_cause"}, list, nil), Filename: "sessoes-" + id[:8] + ".csv"}, nil
	}
	totals := map[string]any{"sessions": len(list), "seconds": float64(0), "bytes_in": float64(0), "bytes_out": float64(0)}
	for _, r := range list {
		for _, key := range []string{"seconds", "bytes_in", "bytes_out"} {
			totals[key] = totals[key].(float64) + num(r.Get(key))
		}
	}
	tz, err := one(ctx, tx, key, 1, auth.From(ctx).TenantID)
	if err != nil {
		return nil, err
	}
	daily, err := rows(ctx, tx, key, 2, id, tz.Get("tz"), textNil(from), textNil(to))
	if err != nil {
		return nil, err
	}
	return map[string]any{"rows": list, "totals": totals, "daily": daily, "truncated": len(list) == 1000}, nil
}
func (s Service) online(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	const key = "GET /api/network/online"
	q := reportQuery(ctx)
	term := q.Text("q", false, true, 0, 80)
	format := q.Enum("format", "json", "json", "csv")
	if err := q.Err(); err != nil {
		return nil, err
	}
	var like any
	if term != "" {
		like = "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(term) + "%"
	}
	list, err := rows(ctx, tx, key, 0, like)
	if err != nil {
		return nil, err
	}
	if format == "csv" {
		if err = record(ctx, tx, "network.online_export", "network", nil, map[string]any{"rows": len(list)}); err != nil {
			return nil, err
		}
		return endpoint.Result{CSV: simpleCSV([]string{"subscriber_name", "login", "ip", "mac", "uptime", "nas", "pop"}, list, nil), Filename: "usuarios-online.csv"}, nil
	}
	return map[string]any{"total": len(list), "rows": list}, nil
}
func (s Service) financeExport(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	const key = "GET /api/finance/export"
	q := reportQuery(ctx)
	kind := q.Enum("kind", "payments", "payments", "invoices")
	from, to := q.Date("from", true, "data inválida"), q.Date("to", true, "data inválida")
	company := q.UUID("company_id", false)
	if err := q.Err(); err != nil {
		return nil, err
	}
	if to < from {
		return nil, apierr.New(400, "período inválido")
	}
	settings, err := leitura.GetSettings(ctx, tx, auth.From(ctx).TenantID)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"kind": kind, "from": from, "to": to}
	if company != "" {
		detail["company_id"] = company
	}
	if err = record(ctx, tx, "finance.export", "finance", nil, detail); err != nil {
		return nil, err
	}
	index := 0
	columns := []string{"data_pagamento", "assinante", "cpf_cnpj", "tipo", "competencia", "vencimento", "valor_fatura", "valor_pago", "meio", "origem", "gateway", "id_pagamento", "fatura"}
	if kind == "invoices" {
		index = 1
		columns = []string{"vencimento", "assinante", "cpf_cnpj", "tipo", "competencia", "valor_fatura", "valor_pago", "situacao", "data_pagamento", "fatura"}
	}
	list, err := rows(ctx, tx, key, index, from, to, settings.Get("timezone"), textNil(company))
	if err != nil {
		return nil, err
	}
	return endpoint.Result{CSV: simpleCSV(columns, list, map[string]bool{"valor_fatura": true, "valor_pago": true}), Filename: "nexoisp-" + kind + "-" + from + "_" + to + ".csv"}, nil
}
func (s Service) dici(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	const key = "GET /api/anatel/dici"
	q := reportQuery(ctx)
	competence := q.String("competence", false, true)
	if len(q.Issues) == 0 && !diciCompetence.MatchString(competence) {
		q.Issues = append(q.Issues, "competence: competência AAAA-MM")
	}
	format := q.Enum("format", "json", "json", "csv")
	if err := q.Err(); err != nil {
		return nil, err
	}
	list, err := rows(ctx, tx, key, 0, competence+"-01")
	if err != nil {
		return nil, err
	}
	pending, err := one(ctx, tx, key, 1, competence+"-01")
	if err != nil {
		return nil, err
	}
	cities, err := rows(ctx, tx, key, 2, competence+"-01")
	if err != nil {
		return nil, err
	}
	plans, err := rows(ctx, tx, key, 3)
	if err != nil {
		return nil, err
	}
	pending.Set("cities_without_code", cities)
	pending.Set("plans_without_technology", plans)
	accesses := float64(0)
	for _, r := range list {
		accesses += num(r.Get("acessos"))
	}
	if err = record(ctx, tx, "anatel.dici", "report", nil, map[string]any{"competence": competence, "format": format, "accesses": accesses}); err != nil {
		return nil, err
	}
	if format == "json" {
		return map[string]any{"competence": competence, "rows": list, "pending": pending}, nil
	}
	split := strings.Split(competence, "-")
	lines := []string{"CNPJ;ANO;MES;COD_IBGE;TIPO_CLIENTE;TIPO_ATENDIMENTO;TIPO_MEIO;TIPO_PRODUTO;TIPO_TECNOLOGIA;VELOCIDADE;ACESSOS"}
	for _, r := range list {
		values := []any{r.Get("cnpj"), split[0], split[1], r.Get("ibge_code"), r.Get("tipo_cliente"), r.Get("tipo_atendimento"), r.Get("meio"), "internet", r.Get("tecnologia"), strings.Replace(jsonx.String(r.Get("velocidade_mbps")), ".", ",", 1), r.Get("acessos")}
		cells := []string{}
		for _, v := range values {
			if v == nil {
				cells = append(cells, "")
			} else {
				cells = append(cells, jsonx.String(v))
			}
		}
		lines = append(lines, strings.Join(cells, ";"))
	}
	return endpoint.Result{CSV: []byte(strings.Join(lines, "\r\n") + "\r\n"), Filename: "dici-acessos-" + competence + ".csv"}, nil
}
func (s Service) commissions(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	const key = "GET /api/reports/commissions"
	q := reportQuery(ctx)
	from, to := q.Date("from", true, "data inválida"), q.Date("to", true, "data inválida")
	if err := q.Err(); err != nil {
		return nil, err
	}
	if to < from {
		return nil, apierr.New(400, "o fim do período é anterior ao início")
	}
	tz, err := one(ctx, tx, key, 0, auth.From(ctx).TenantID)
	if err != nil {
		return nil, err
	}
	work, err := rows(ctx, tx, key, 1, from, to, tz.Get("tz"))
	if err != nil {
		return nil, err
	}
	sales, err := rows(ctx, tx, key, 2, from, to, tz.Get("tz"))
	if err != nil {
		return nil, err
	}
	people := []map[string]any{}
	positions := map[string]int{}
	for _, r := range append(work, sales...) {
		id := r.Get("user_id").(string)
		i, exists := positions[id]
		if !exists {
			i = len(people)
			positions[id] = i
			people = append(people, map[string]any{"user_id": id, "name": r.Get("name"), "os_assignee": float64(0), "os_assignee_cents": float64(0), "os_helper": float64(0), "os_helper_cents": float64(0), "sales": float64(0), "sales_cents": float64(0), "total_cents": float64(0)})
		}
		prefix := "sales"
		if r.Get("role") == "assignee" {
			prefix = "os_assignee"
		} else if r.Get("role") == "helper" {
			prefix = "os_helper"
		}
		people[i][prefix] = num(r.Get("n"))
		people[i][prefix+"_cents"] = num(r.Get("cents"))
		people[i]["total_cents"] = num(people[i]["os_assignee_cents"]) + num(people[i]["os_helper_cents"]) + num(people[i]["sales_cents"])
	}
	total := float64(0)
	for _, p := range people {
		total += num(p["total_cents"])
	}
	sort.SliceStable(people, func(i, j int) bool { return num(people[i]["total_cents"]) > num(people[j]["total_cents"]) })
	if err = record(ctx, tx, "report.commissions", "report", nil, map[string]any{"from": from, "to": to}); err != nil {
		return nil, err
	}
	return map[string]any{"from": from, "to": to, "timezone": tz.Get("tz"), "rows": people, "total_cents": total, "note": "Calculado com as regras vigentes hoje; mudar a regra muda a apuração de períodos passados ainda não pagos."}, nil
}
func queryFragments(key string, index int, fragments map[string]string) string {
	data, err := sourceFiles.ReadFile("sql/" + specs[key].Queries[index])
	if err != nil {
		panic(err)
	}
	sql := string(data)
	for name, value := range fragments {
		sql = strings.ReplaceAll(sql, "{{"+name+"}}", value)
	}
	if strings.Contains(sql, "{{") {
		panic("SQL de relatório não resolvido")
	}
	return sql
}
func (s Service) financeReport(ctx context.Context, tx *db.Tx, key string) (any, error) {
	name := strings.TrimPrefix(key, "GET /api/finance/reports/")
	q := reportQuery(ctx)
	args := []any{}
	from, to := "", ""
	days := 90
	switch name {
	case "aging":
		args = []any{textNil(q.UUID("plan_id", false)), textNil(q.UUID("pop_id", false)), textNil(q.UUID("tag", false))}
	case "receipts":
		from, to = q.Date("from", true, "data inválida"), q.Date("to", true, "data inválida")
	case "to-cancel":
		days = q.Integer("days", 90, 1, 730)
	}
	format := q.Enum("format", "json", "json", "csv")
	if err := q.Err(); err != nil {
		return nil, err
	}
	var list []jsonx.Object
	var value any
	var err error
	filename := ""
	columns := []string{}
	detail := map[string]any{"name": name}
	switch name {
	case "aging":
		today, err := one(ctx, tx, key, 0)
		if err != nil {
			return nil, err
		}
		list, err = rows(ctx, tx, key, 1, append(args, today.Get("d"))...)
		if err != nil {
			return nil, err
		}
		total := map[string]any{"faturas": float64(0), "cents": float64(0)}
		for _, r := range list {
			total["faturas"] = num(total["faturas"]) + num(r.Get("faturas"))
			total["cents"] = num(total["cents"]) + num(r.Get("cents"))
		}
		value = map[string]any{"rows": list, "total": total}
		filename = "aging.csv"
		columns = []string{"faixa", "faturas", "valor"}
	case "receipts":
		tz, err := one(ctx, tx, key, 0, auth.From(ctx).TenantID)
		if err != nil {
			return nil, err
		}
		args := []any{from, to, tz.Get("tz")}
		plans, err := tx.Objects(ctx, queryFragments(key, 1, map[string]string{"expr": "pl.name"}), args...)
		if err != nil {
			return nil, err
		}
		methods, err := tx.Objects(ctx, queryFragments(key, 1, map[string]string{"expr": "coalesce(nullif(p.method, ''), case p.source when 'manual' then 'manual' else 'gateway' end)"}), args...)
		if err != nil {
			return nil, err
		}
		total := float64(0)
		for _, r := range plans {
			total += num(r.Get("cents"))
		}
		value = map[string]any{"by_plan": plans, "by_method": methods, "total_cents": total}
		detail["from"], detail["to"] = from, to
		filename = "recebido-" + from + "_" + to + ".csv"
		columns = []string{"tipo", "grupo", "pagamentos", "valor"}
		list = []jsonx.Object{}
		for i, group := range [][]jsonx.Object{plans, methods} {
			for _, r := range group {
				kind := "plano"
				if i == 1 {
					kind = "forma"
				}
				r.Set("tipo", kind)
				list = append(list, r)
			}
		}
	case "without-invoice":
		list, err = rows(ctx, tx, key, 0)
		if err != nil {
			return nil, err
		}
		value = map[string]any{"rows": list}
		filename = "sem-fatura.csv"
		columns = []string{"subscriber_name", "plan_name", "valor", "due_day", "start_date"}
	case "to-cancel":
		today, err := one(ctx, tx, key, 0)
		if err != nil {
			return nil, err
		}
		list, err = rows(ctx, tx, key, 1, days, today.Get("d"))
		if err != nil {
			return nil, err
		}
		value = map[string]any{"days": days, "rows": list}
		detail["days"] = days
		filename = "a-cancelar.csv"
		columns = []string{"subscriber_name", "plan_name", "faturas", "valor", "dias_atraso"}
	}
	if format != "csv" {
		return value, nil
	}
	if err = record(ctx, tx, "finance.report_export", "report", nil, detail); err != nil {
		return nil, err
	}
	for i, r := range list {
		cents := r.Get("cents")
		if name == "without-invoice" {
			cents = r.Get("price_cents")
		}
		list[i].Set("valor", brl(num(cents)))
	}
	return endpoint.Result{CSV: simpleCSV(columns, list, nil), Filename: filename}, nil
}

var diciCompetence = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`)

func uriComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}
