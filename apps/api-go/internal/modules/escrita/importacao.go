package escrita

import (
	"context"
	"errors"
	"fmt"
	"math"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/unicode/norm"
)

var importFields = map[string][]string{
	"subscribers": strings.Split("id_externo,nome,cpf_cnpj,email,telefone,logradouro,numero,bairro,cidade,uf,cep,observacoes,situacao,plano,vencimento_dia,pppoe_usuario,pppoe_senha,nascimento,rg,nome_mae,nome_fantasia,celular,whatsapp,aceita_avisos,inicio_contrato,mac,etiquetas,pop,fidelidade_ate,multa_valor,multa_modelo,indicado_por", ","),
	"invoices":    strings.Split("id_externo,id_externo_contrato,id_externo_assinante,vencimento,valor,competencia,descricao,situacao,pago_em,valor_pago,forma_pagamento", ","),
	"history":     strings.Split("id_externo,id_externo_assinante,tipo,data,assunto,descricao,situacao,encerrado_em,solucao,responsavel,categoria,tipo_os", ","),
}

func init() {
	importFields["contracts"] = strings.Split("id_externo,id_externo_assinante,plano,vencimento_dia,inicio_contrato,pppoe_usuario,pppoe_senha,equipamento,pop,etiquetas,fidelidade_ate,multa_valor,multa_modelo,indicado_por", ",")
	importFields["network"] = []string{"id_externo", "tipo", "pai", "dados"}
	importFields["documents"] = []string{"id_externo", "id_externo_assinante", "id_externo_contrato", "nome", "tipo", "conteudo_base64"}
	importFields["users"] = []string{"id_externo", "nome", "email", "perfil", "senha", "ativo", "pops"}
	importRequired["contracts"] = []string{"id_externo", "id_externo_assinante", "plano", "vencimento_dia"}
	importRequired["network"] = []string{"id_externo", "tipo", "dados"}
	importRequired["documents"] = []string{"id_externo", "id_externo_assinante", "nome", "tipo", "conteudo_base64"}
	importRequired["users"] = []string{"id_externo", "nome", "email", "perfil"}
}

var importRequired = map[string][]string{"subscribers": {"id_externo", "nome"}, "invoices": {"id_externo", "id_externo_assinante", "vencimento", "valor"}, "history": {"id_externo", "id_externo_assinante", "tipo", "data", "descricao"}}

type rowError string

func (e rowError) Error() string { return string(e) }
func parseCSV(src string) [][]string {
	src = strings.TrimPrefix(src, "\ufeff")
	first := strings.Split(strings.Split(src, "\n")[0], "\r")[0]
	delim := ','
	if strings.Count(first, ";") > strings.Count(first, ",") {
		delim = ';'
	}
	rows := [][]string{}
	row := []string{}
	var cur strings.Builder
	quoted := false
	runes := []rune(src)
	save := func() {
		row = append(row, cur.String())
		cur.Reset()
		nonempty := false
		for _, v := range row {
			nonempty = nonempty || validate.Trim(v) != ""
		}
		if nonempty {
			rows = append(rows, row)
		}
		row = []string{}
	}
	for i := 0; i < len(runes); i++ {
		ch := runes[i]
		if quoted {
			if ch == '"' && i+1 < len(runes) && runes[i+1] == '"' {
				cur.WriteRune('"')
				i++
			} else if ch == '"' {
				quoted = false
			} else {
				cur.WriteRune(ch)
			}
		} else if ch == '"' {
			quoted = true
		} else if ch == delim {
			row = append(row, cur.String())
			cur.Reset()
		} else if ch == '\n' || ch == '\r' {
			if ch == '\r' && i+1 < len(runes) && runes[i+1] == '\n' {
				i++
			}
			save()
		} else {
			cur.WriteRune(ch)
		}
	}
	save()
	return rows
}
func importDate(v string) any {
	v = validate.Trim(v)
	if regexp.MustCompile(`^\d{2}/\d{2}/\d{4}$`).MatchString(v) {
		p := strings.Split(v, "/")
		v = p[2] + "-" + p[1] + "-" + p[0]
	}
	t, e := time.Parse("2006-01-02", v)
	if e != nil || t.Format("2006-01-02") != v {
		return nil
	}
	return v
}
func importWhen(v string) any {
	m := regexp.MustCompile(`^(\S+)(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$`).FindStringSubmatch(validate.Trim(v))
	if m == nil {
		return nil
	}
	d := importDate(m[1])
	if d == nil {
		return nil
	}
	h, minute, second := 12, 0, 0
	if m[2] != "" {
		h, _ = strconv.Atoi(m[2])
		minute, _ = strconv.Atoi(m[3])
	}
	if m[4] != "" {
		second, _ = strconv.Atoi(m[4])
	}
	if h > 23 || minute > 59 || second > 59 {
		return nil
	}
	t, e := time.Parse(time.RFC3339, fmt.Sprintf("%vT%02d:%02d:%02d-03:00", d, h, minute, second))
	if e != nil {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func cents(v string) (float64, bool) {
	v = regexp.MustCompile(`^R\$\s*`).ReplaceAllString(validate.Trim(v), "")
	if strings.Contains(v, ",") {
		v = strings.ReplaceAll(v, ".", "")
		v = strings.Replace(v, ",", ".", 1)
	}
	m := regexp.MustCompile(`^(\d{1,9})(?:\.(\d{1,2}))?$`).FindStringSubmatch(v)
	if m == nil {
		return 0, false
	}
	n, _ := strconv.ParseFloat(m[1], 64)
	decimal := m[2]
	for len(decimal) < 2 {
		decimal += "0"
	}
	d, _ := strconv.ParseFloat(decimal, 64)
	return n*100 + d, true
}
func cut(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) > n {
		u = u[:n]
	}
	return string(utf16.Decode(u))
}
func importOne(ctx context.Context, tx *db.Tx, sql string, args ...any) (jsonx.Object, error) {
	rs, e := tx.Objects(ctx, sql, args...)
	if len(rs) > 0 {
		return rs[0], e
	}
	return nil, e
}
func importResult(ext, status string, id any, messages []string) map[string]any {
	r := map[string]any{"external_id": nilEmpty(ext), "status": status, "messages": messages}
	if id != nil {
		r["entity_id"] = id
	}
	return r
}
func inc(t map[string]any, key string, n float64) {
	if t[key] == nil {
		t[key] = float64(0)
	}
	t[key] = num(t[key]) + n
}
func bodyRecord(b map[string]any, key, name string) string {
	if o, ok := b[key].(jsonx.Object); ok {
		if v, ok := o.Get(name).(string); ok {
			return v
		}
	}
	return ""
}

var previewRollback = errors.New("prévia de importação concluída")

// beforeImportRows é nil em produção. O teste observa os locks depois dos savepoints e antes de import_rows.
var beforeImportRows func(context.Context, *db.Tx) error

type invoiceLockKey struct{}

func (s Service) importOperations(ops map[string]operation) {
	f, o, str := validate.F, validate.Object, validate.String
	schema := obj(o(f("kind", validate.Enum("subscribers", "contracts", "invoices", "history", "network", "documents", "users")), f("source", str().Pattern(`^[a-z0-9-]{2,40}$`, "origem: minúsculas, números e hífen").Def("csv-intermediario")), f("filename", str().Max(200).Opt()), f("csv", str().Min(1).Max(15*1024*1024)), f("mapping", validate.Record(str()).Opt()), f("plan_map", validate.Record(str().UUID()).Opt()), f("device_id", str().UUID().Nullish())))
	ops["POST /api/import/preview"] = operation{nil, schema}
	ops["POST /api/import/apply"] = operation{nil, schema}
}
func (s Service) importCSV(ctx context.Context, b map[string]any, apply bool) (any, error) {
	table := parseCSV(b["csv"].(string))
	if len(table) < 2 {
		return nil, apierr.New(400, "arquivo sem linhas de dados")
	}
	headers := table[0]
	for i := range headers {
		headers[i] = validate.Trim(headers[i])
	}
	kind := b["kind"].(string)
	fields := importFields[kind]
	mapping := map[string]any{}
	mapped := map[string]bool{}
	for _, f := range fields {
		var value any
		want := bodyRecord(b, "mapping", f)
		if object, ok := b["mapping"].(jsonx.Object); ok && object.Get(f) != nil {
			if slices.Contains(headers, want) {
				value = want
			}
		} else {
			for _, h := range headers {
				if strings.ToLower(validate.Trim(h)) == f {
					value = h
					break
				}
			}
		}
		mapping[f] = value
		mapped[f] = value != nil
	}
	missing := []string{}
	for _, f := range importRequired[kind] {
		if !mapped[f] {
			missing = append(missing, f)
		}
	}
	totals := map[string]any{"rows": float64(len(table) - 1), "plans_unmatched": []string{}, "pops_unmatched": []string{}}
	for _, key := range strings.Split("created,updated,unchanged,error,contracts_created,accounts_created,accounts_without_secret,amount_cents_total,contacts_created,tags_applied,loyalty_set,invoices_paid,invoices_partial,invoices_canceled,paid_cents_total", ",") {
		totals[key] = float64(0)
	}
	results := []map[string]any{}
	var batch any
	c := auth.From(ctx)
	if (kind == "network" || kind == "users" || kind == "contracts" || kind == "documents") && len(c.PopIDs) > 0 {
		return nil, apierr.New(403, "importação estrutural exige administrador sem restrição de POP")
	}
	e := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		if len(missing) == 0 {
			plans, e := tx.Objects(ctx, `select p.id,p.name,v.id as version_id,v.version,v.profile_name from plans p join lateral (select * from plan_versions x where x.plan_id=p.id order by version desc limit 1) v on true where p.active`)
			if e != nil {
				return e
			}
			if b["device_id"] != nil {
				device, e := importOne(ctx, tx, "select 1 from devices where id=$1", b["device_id"])
				if e != nil {
					return e
				}
				if device == nil {
					return apierr.New(400, "equipamento não encontrado")
				}
			}
			if kind == "invoices" {
				held, e := lockReferencedInvoices(ctx, tx, importSource(b), table, headers, mapping)
				if e != nil {
					return e
				}
				ctx = context.WithValue(ctx, invoiceLockKey{}, held)
			}
			seen := map[string]bool{}
			for n := 1; n < len(table); n++ {
				r := map[string]string{}
				for _, f := range fields {
					if mapping[f] != nil {
						index := slices.Index(headers, mapping[f].(string))
						if index >= 0 && index < len(table[n]) {
							r[f] = validate.Trim(table[n][index])
						}
					}
				}
				if e = tx.Exec(ctx, "savepoint import_row"); e != nil {
					return e
				}
				var result map[string]any
				var rowErr error
				rowKey := r["id_externo"]
				if kind == "network" {
					rowKey = r["tipo"] + ":" + rowKey
				}
				before := map[string]any{}
				for key, value := range totals {
					if _, ok := value.(float64); ok {
						before[key] = value
					}
				}
				if r["id_externo"] != "" && seen[rowKey] {
					rowErr = rowError(fmt.Sprintf("id_externo \"%s\" repetido no arquivo", r["id_externo"]))
				} else {
					seen[rowKey] = true
					switch kind {
					case "subscribers":
						result, rowErr = importSubscriber(ctx, tx, b, r, plans, totals, mapped)
					case "invoices":
						result, rowErr = importInvoice(ctx, tx, b, r, totals)
					case "history":
						result, rowErr = importHistory(ctx, tx, b, r, totals)
					default:
						result, rowErr = s.importExtended(ctx, tx, b, r, plans, totals, mapped)
					}
				}
				if rowErr != nil {
					for key, value := range before {
						totals[key] = value
					}
					if e = tx.Exec(ctx, "rollback to savepoint import_row"); e != nil {
						return e
					}
					var re rowError
					var pe *pgconn.PgError
					message := ""
					if errors.As(rowErr, &re) {
						message = re.Error()
					} else if errors.As(rowErr, &pe) {
						if pe.Code == "23505" {
							message = "conflito com registro existente (" + pe.ConstraintName + ")"
						} else {
							message = "erro de dados (" + pe.Code + ")"
						}
					} else {
						return rowErr
					}
					result = importResult(r["id_externo"], "error", nil, []string{message})
				}
				if e = tx.Exec(ctx, "release savepoint import_row"); e != nil {
					return e
				}
				result["row"] = n + 1
				inc(totals, result["status"].(string), 1)
				results = append(results, result)
			}
		}
		if kind == "invoices" && len(missing) == 0 {
			if e := rereadImportedInvoices(ctx, tx, importSource(b), results); e != nil {
				return e
			}
		}
		if apply && len(missing) == 0 {
			if kind == "invoices" && beforeImportRows != nil {
				if e := beforeImportRows(ctx, tx); e != nil {
					return e
				}
			}
			encoded, e := jsonx.Encode(totals)
			if e != nil {
				return e
			}
			row, e := importOne(ctx, tx, `insert into import_batches (tenant_id,source,kind,filename,totals,created_by) values ($1,$2,$3,$4,$5,$6) returning id`, c.TenantID, b["source"], kind, b["filename"], encoded, c.UserID)
			if e != nil {
				return e
			}
			batch = row.Get("id")
			for _, r := range results {
				messages, e := jsonx.Encode(r["messages"])
				if e != nil {
					return e
				}
				if e = tx.Exec(ctx, `insert into import_rows (tenant_id,batch_id,row_number,external_id,status,messages,entity_id) values ($1,$2,$3,$4,$5,$6,$7)`, c.TenantID, batch, r["row"], r["external_id"], r["status"], messages, r["entity_id"]); e != nil {
					return e
				}
			}
			return tx.Exec(ctx, `insert into audit_events (tenant_id,actor_type,actor_id,action,entity_type,entity_id,detail) values ($1,'user',$2,'import.apply','import_batch',$3,$4)`, c.TenantID, c.UserID, batch, encoded)
		}
		return previewRollback
	})
	if errors.Is(e, previewRollback) {
		e = nil
	}
	if e != nil {
		return nil, e
	}
	if apply && len(missing) > 0 {
		return nil, apierr.New(400, "colunas obrigatórias sem mapeamento: "+strings.Join(missing, ", "))
	}
	warnings := []map[string]any{}
	for _, r := range results {
		if r["status"] == "error" || len(r["messages"].([]string)) > 0 {
			warnings = append(warnings, r)
		}
	}
	return map[string]any{"applied": apply && len(missing) == 0, "batch_id": batch, "headers": headers, "fields": fields, "mapping": mapping, "missing_required": missing, "totals": totals, "rows": warnings[:min(500, len(warnings))], "sample": results[:min(20, len(results))]}, nil
}
func importSubscriber(ctx context.Context, tx *db.Tx, b map[string]any, r map[string]string, plans []jsonx.Object, t map[string]any, mapped map[string]bool) (map[string]any, error) {
	tenant := auth.From(ctx).TenantID
	source := b["source"]
	ext := r["id_externo"]
	msgs := []string{}
	fail := func(message string) (map[string]any, error) { return nil, rowError(message) }
	if ext == "" {
		return fail("id_externo ausente")
	}
	if len(utf16.Encode([]rune(r["nome"]))) < 2 {
		return fail("nome ausente")
	}
	doc := digits(r["cpf_cnpj"])
	if doc != "" && !validDocument(doc) {
		return fail("CPF/CNPJ inválido: " + r["cpf_cnpj"])
	}
	if r["email"] != "" && !regexp.MustCompile(`^[A-Za-z0-9.!#$%&'*+/=?^_`+"`"+`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$`).MatchString(r["email"]) {
		return fail("e-mail inválido: " + r["email"])
	}
	sit := strings.ToLower(r["situacao"])
	if sit == "" {
		sit = "ativo"
	}
	if sit != "ativo" && sit != "inativo" {
		return fail(fmt.Sprintf("situação desconhecida: \"%s\" (use ativo ou inativo)", r["situacao"]))
	}
	statusValue := "active"
	if sit == "inativo" {
		statusValue = "inactive"
	}
	cols := []string{"name", "document", "email", "phone", "address_street", "address_number", "address_district", "address_city", "address_state", "address_zip", "notes", "status"}
	vals := []any{r["nome"], nilEmpty(doc), nilEmpty(r["email"]), nilEmpty(r["telefone"]), nilEmpty(r["logradouro"]), nilEmpty(r["numero"]), nilEmpty(r["bairro"]), nilEmpty(r["cidade"]), nilEmpty(cut(strings.ToUpper(r["uf"]), 2)), nilEmpty(r["cep"]), nilEmpty(r["observacoes"]), statusValue}
	if mapped["nascimento"] {
		bd := importDate(r["nascimento"])
		if r["nascimento"] != "" && bd == nil {
			return fail(fmt.Sprintf("nascimento inválido: \"%s\" (use AAAA-MM-DD ou DD/MM/AAAA)", r["nascimento"]))
		}
		cols = append(cols, "birth_date")
		vals = append(vals, bd)
	}
	if mapped["rg"] {
		if r["rg"] != "" && !regexp.MustCompile(`^[0-9A-Za-z.\- /]{3,20}$`).MatchString(r["rg"]) {
			return fail(fmt.Sprintf("RG inválido: \"%s\"", r["rg"]))
		}
		cols = append(cols, "rg")
		vals = append(vals, nilEmpty(r["rg"]))
	}
	for _, v := range []struct{ field, col, label string }{{"nome_mae", "mother_name", "nome da mãe"}, {"nome_fantasia", "trade_name", "nome fantasia"}} {
		if mapped[v.field] {
			if len(utf16.Encode([]rune(r[v.field]))) > 200 {
				return fail(v.label + " acima de 200 caracteres")
			}
			cols = append(cols, v.col)
			vals = append(vals, nilEmpty(r[v.field]))
		}
	}
	sub, e := importOne(ctx, tx, "select * from subscribers where external_source=$1 and external_id=$2", source, ext)
	if e != nil {
		return nil, e
	}
	status := "created"
	if sub != nil {
		changed := false
		for i, k := range cols {
			if fmt.Sprint(sub.Get(k)) != fmt.Sprint(vals[i]) {
				changed = true
			}
		}
		status = "unchanged"
		if changed {
			assign := []string{}
			for i, col := range cols {
				assign = append(assign, fmt.Sprintf("%s=$%d", col, i+2))
			}
			args := append([]any{sub.Get("id")}, vals...)
			if e = tx.Exec(ctx, "update subscribers set "+strings.Join(assign, ",")+",updated_at=now() where id=$1", args...); e != nil {
				return nil, e
			}
			status = "updated"
		}
	} else {
		if doc != "" {
			clash, e := importOne(ctx, tx, "select name from subscribers where document=$1", doc)
			if e != nil {
				return nil, e
			}
			if clash != nil {
				return fail(fmt.Sprintf("documento já cadastrado para \"%v\" sem vínculo com esta origem; confira antes de importar", clash.Get("name")))
			}
		}
		params := []string{}
		for i := range vals {
			params = append(params, fmt.Sprintf("$%d", i+2))
		}
		args := append([]any{tenant}, vals...)
		args = append(args, source, ext)
		sub, e = importOne(ctx, tx, fmt.Sprintf("insert into subscribers (tenant_id,%s,external_source,external_id) values ($1,%s,$%d,$%d) returning *", strings.Join(cols, ","), strings.Join(params, ","), len(cols)+2, len(cols)+3), args...)
		if e != nil {
			return nil, e
		}
	}
	consent := strings.ToLower(validate.Trim(r["aceita_avisos"]))
	yes := slices.Contains([]string{"sim", "s", "yes", "y", "1", "true", "verdadeiro"}, consent)
	if mapped["aceita_avisos"] && !yes && !slices.Contains([]string{"nao", "não", "n", "no", "0", "false", "falso", ""}, consent) {
		return fail(fmt.Sprintf("aceita_avisos inválido: \"%s\" (use sim ou não)", r["aceita_avisos"]))
	}
	for _, contact := range []struct{ field, kind string }{{"celular", "mobile"}, {"whatsapp", "whatsapp"}} {
		v := r[contact.field]
		if !mapped[contact.field] || v == "" {
			continue
		}
		if len(v) < 3 || len(utf16.Encode([]rune(v))) > 200 {
			return fail(fmt.Sprintf("%s inválido: \"%s\"", contact.field, v))
		}
		found, e := importOne(ctx, tx, "select 1 from subscriber_contacts where subscriber_id=$1 and kind=$2 and value=$3", sub.Get("id"), contact.kind, v)
		if e != nil {
			return nil, e
		}
		if found == nil {
			if e = tx.Exec(ctx, `insert into subscriber_contacts (tenant_id,subscriber_id,kind,value,purpose,allow_notices) values ($1,$2,$3,$4,'general',$5)`, tenant, sub.Get("id"), contact.kind, v, yes); e != nil {
				return nil, e
			}
			inc(t, "contacts_created", 1)
			if status == "unchanged" {
				status = "updated"
			}
		}
	}
	if r["plano"] != "" {
		var plan jsonx.Object
		for _, p := range plans {
			if p.Get("id") == bodyRecord(b, "plan_map", r["plano"]) {
				plan = p
				break
			}
		}
		if plan == nil {
			for _, p := range plans {
				if strings.EqualFold(p.Get("name").(string), r["plano"]) {
					plan = p
					break
				}
			}
		}
		if plan == nil {
			unmatched := t["plans_unmatched"].([]string)
			if !slices.Contains(unmatched, r["plano"]) {
				t["plans_unmatched"] = append(unmatched, r["plano"])
			}
			return fail(fmt.Sprintf("plano \"%s\" não corresponde a nenhum plano cadastrado; mapeie-o antes de importar", r["plano"]))
		}
		k, e := importOne(ctx, tx, `select k.id,pv.plan_id from contracts k join plan_versions pv on pv.id=k.plan_version_id where k.external_source=$1 and k.external_id=$2`, source, ext)
		if e != nil {
			return nil, e
		}
		if k != nil {
			if k.Get("plan_id") != plan.Get("id") {
				msgs = append(msgs, "contrato já importado com outro plano; não foi alterado (troque pelo painel se necessário)")
			}
		} else if sit != "ativo" {
			msgs = append(msgs, "assinante inativo: contrato não criado")
		} else {
			due := validate.JSNumber(r["vencimento_dia"])
			if math.IsNaN(due) || math.Trunc(due) != due || due < 1 || due > 28 {
				return fail(fmt.Sprintf("vencimento_dia inválido: \"%s\" (aceito: 1 a 28; ajuste na origem ou no arquivo)", r["vencimento_dia"]))
			}
			var start any
			if mapped["inicio_contrato"] && r["inicio_contrato"] != "" {
				start = importDate(r["inicio_contrato"])
				if start == nil {
					return fail(fmt.Sprintf("inicio_contrato inválido: \"%s\" (use AAAA-MM-DD ou DD/MM/AAAA)", r["inicio_contrato"]))
				}
			}
			k, e = importOne(ctx, tx, `insert into contracts (tenant_id,subscriber_id,plan_version_id,due_day,start_date,external_source,external_id) values ($1,$2,$3,$4,coalesce($5::date,current_date),$6,$7) returning id`, tenant, sub.Get("id"), plan.Get("version_id"), due, start, source, ext)
			if e != nil {
				return nil, e
			}
			detail, _ := jsonx.Encode(map[string]any{"import": source, "plan": plan.Get("name"), "plan_version": plan.Get("version")})
			if e = tx.Exec(ctx, `insert into contract_history (tenant_id,contract_id,event,detail) values ($1,$2,'created',$3)`, tenant, k.Get("id"), detail); e != nil {
				return nil, e
			}
			inc(t, "contracts_created", 1)
			if status == "unchanged" {
				status = "updated"
			}
		}
		if k != nil && r["pppoe_usuario"] != "" {
			existing, e := importOne(ctx, tx, "select 1 from service_resources where contract_id=$1", k.Get("id"))
			if e != nil {
				return nil, e
			}
			if existing == nil {
				if b["device_id"] == nil {
					msgs = append(msgs, "conta PPPoE não criada: selecione o equipamento (NAS) de destino")
				} else {
					if !regexp.MustCompile(`^[A-Za-z0-9_.@-]{3,64}$`).MatchString(r["pppoe_usuario"]) {
						return fail(fmt.Sprintf("usuário PPPoE inválido: \"%s\"", r["pppoe_usuario"]))
					}
					var mac, secret any
					if mapped["mac"] && r["mac"] != "" {
						v := strings.NewReplacer("-", ":", ".", ":").Replace(strings.ToUpper(r["mac"]))
						plain := strings.ReplaceAll(v, ":", "")
						if regexp.MustCompile(`^[0-9A-F]{12}$`).MatchString(plain) {
							parts := []string{}
							for i := 0; i < 12; i += 2 {
								parts = append(parts, plain[i:i+2])
							}
							v = strings.Join(parts, ":")
						}
						if !regexp.MustCompile(`^([0-9A-F]{2}:){5}[0-9A-F]{2}$`).MatchString(v) {
							return fail(fmt.Sprintf("MAC inválido: \"%s\"", r["mac"]))
						}
						mac = v
					}
					if r["pppoe_senha"] != "" {
						secret, e = cryptox.EncryptSecret(r["pppoe_senha"])
						if e != nil {
							return nil, e
						}
					}
					if e = tx.Exec(ctx, `insert into service_resources (tenant_id,contract_id,device_id,pppoe_username,secret_enc,desired_profile,mac,external_source,external_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, tenant, k.Get("id"), b["device_id"], r["pppoe_usuario"], secret, plan.Get("profile_name"), mac, source, ext); e != nil {
						return nil, e
					}
					inc(t, "accounts_created", 1)
					if secret == nil {
						inc(t, "accounts_without_secret", 1)
						msgs = append(msgs, "sem senha PPPoE no arquivo: credencial indisponível, conta não poderá ser provisionada até informar a senha")
					}
					if status == "unchanged" {
						status = "updated"
					}
				}
			}
		}
		if k != nil {
			changed, e := importExtras(ctx, tx, b, k.Get("id"), r, mapped, t, &msgs)
			if e != nil {
				return nil, e
			}
			if changed && status == "unchanged" {
				status = "updated"
			}
		}
	} else if r["pppoe_usuario"] != "" {
		msgs = append(msgs, "pppoe_usuario ignorado: linha sem plano/contrato")
	}
	return importResult(ext, status, sub.Get("id"), msgs), nil
}
func importExtras(ctx context.Context, tx *db.Tx, b map[string]any, contract any, r map[string]string, mapped map[string]bool, t map[string]any, msgs *[]string) (bool, error) {
	const key = "helper:applyContractExtras"
	tenant := auth.From(ctx).TenantID
	changed := false
	if mapped["etiquetas"] && r["etiquetas"] != "" {
		for _, name := range strings.Split(r["etiquetas"], "|") {
			name = validate.Trim(name)
			if name == "" {
				continue
			}
			n := len(utf16.Encode([]rune(name)))
			if n < 2 || n > 40 {
				return false, rowError(fmt.Sprintf("etiqueta inválida: \"%s\" (2 a 40 caracteres)", name))
			}
			tag, e := one(ctx, tx, key, 0, tenant, name)
			if e != nil {
				return false, e
			}
			nrows, e := tx.Affected(ctx, query(key, 1), tenant, contract, tag.Get("id"))
			if e != nil {
				return false, e
			}
			if nrows > 0 {
				inc(t, "tags_applied", 1)
				changed = true
			}
		}
	}
	if mapped["pop"] && r["pop"] != "" {
		pop, e := one(ctx, tx, key, 2, r["pop"])
		if e != nil {
			return false, e
		}
		if pop == nil {
			unmatched := t["pops_unmatched"].([]string)
			if !slices.Contains(unmatched, r["pop"]) {
				t["pops_unmatched"] = append(unmatched, r["pop"])
			}
			*msgs = append(*msgs, fmt.Sprintf("POP \"%s\" não existe: cadastre-o e reimporte para vincular", r["pop"]))
		} else {
			n, e := tx.Affected(ctx, query(key, 3), contract, pop.Get("id"))
			if e != nil {
				return false, e
			}
			changed = changed || n > 0
		}
	}
	if mapped["fidelidade_ate"] && r["fidelidade_ate"] != "" {
		until := importDate(r["fidelidade_ate"])
		if until == nil {
			return false, rowError(fmt.Sprintf("fidelidade_ate inválida: \"%s\" (use AAAA-MM-DD ou DD/MM/AAAA)", r["fidelidade_ate"]))
		}
		fee, ok := cents(r["multa_valor"])
		if !ok {
			return false, rowError(fmt.Sprintf("multa_valor inválido ou ausente: \"%s\" (obrigatório com fidelidade_ate)", r["multa_valor"]))
		}
		model := strings.ToLower(r["multa_modelo"])
		if model == "" {
			model = "fixo"
		}
		if model != "fixo" && model != "mensal" {
			return false, rowError(fmt.Sprintf("multa_modelo desconhecido: \"%s\" (use fixo ou mensal)", r["multa_modelo"]))
		}
		m := "fixed"
		if model == "mensal" {
			m = "monthly"
		}
		n, e := tx.Affected(ctx, query(key, 4), contract, until, m, fee)
		if e != nil {
			return false, e
		}
		if n > 0 {
			inc(t, "loyalty_set", 1)
			changed = true
		}
	}
	if mapped["indicado_por"] && r["indicado_por"] != "" {
		ref, e := one(ctx, tx, key, 5, b["source"], r["indicado_por"])
		if e != nil {
			return false, e
		}
		if ref == nil {
			*msgs = append(*msgs, fmt.Sprintf("indicador \"%s\" não encontrado nesta origem: importe-o antes e reimporte", r["indicado_por"]))
		} else {
			n, e := tx.Affected(ctx, query(key, 6), contract, ref.Get("id"))
			if e != nil {
				return false, e
			}
			changed = changed || n > 0
		}
	}
	return changed, nil
}

func importSource(b map[string]any) string {
	source, _ := b["source"].(string)
	return source
}

func mappedCell(headers, row []string, mapping map[string]any, field string) string {
	if mapping[field] == nil {
		return ""
	}
	name, ok := mapping[field].(string)
	if !ok {
		return ""
	}
	index := slices.Index(headers, name)
	if index < 0 || index >= len(row) {
		return ""
	}
	return validate.Trim(row[index])
}

func canonicalHeldID(v any) string {
	parsed, err := uuid.Parse(strings.TrimSpace(fmt.Sprint(v)))
	if err != nil {
		return ""
	}
	return parsed.String()
}

func invoiceLockHeld(ctx context.Context, id any) bool {
	held, _ := ctx.Value(invoiceLockKey{}).(map[string]struct{})
	if len(held) == 0 {
		return false
	}
	_, ok := held[canonicalHeldID(id)]
	return ok
}

// lockReferencedInvoices trava, antes de qualquer savepoint, só as faturas que o CSV já pode reconhecer.
// A ordem é a do protocolo comum; o rollback da linha não solta esses locks.
func lockReferencedInvoices(ctx context.Context, tx *db.Tx, source string, table [][]string, headers []string, mapping map[string]any) (map[string]struct{}, error) {
	external := []string{}
	seen := map[string]struct{}{}
	for n := 1; n < len(table); n++ {
		ext := mappedCell(headers, table[n], mapping, "id_externo")
		if ext == "" {
			continue
		}
		if _, ok := seen[ext]; ok {
			continue
		}
		seen[ext] = struct{}{}
		external = append(external, ext)
	}
	held := map[string]struct{}{}
	ids, err := referencedInvoiceIDs(ctx, tx, source, external)
	if err != nil {
		return nil, err
	}
	if err = finance.LockInvoices(ctx, tx, auth.From(ctx).TenantID, ids...); err != nil {
		return nil, err
	}
	for _, id := range ids {
		held[id] = struct{}{}
	}
	again, err := referencedInvoiceIDs(ctx, tx, source, external)
	if err != nil {
		return nil, err
	}
	for _, id := range again {
		if _, ok := held[id]; !ok {
			return nil, apierr.New(409, "faturas referenciadas mudaram; repita a importação")
		}
	}
	return held, nil
}

func referencedInvoiceIDs(ctx context.Context, tx *db.Tx, source string, external []string) ([]string, error) {
	if source == "" || len(external) == 0 {
		return nil, nil
	}
	rows, err := tx.Objects(ctx, `select id::text as id from invoices where external_source = $1 and external_id = any($2::text[])`, source, external)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	seen := map[string]struct{}{}
	for _, row := range rows {
		id := canonicalHeldID(row.Get("id"))
		if id == "" {
			return nil, fmt.Errorf("id de fatura ilegível")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}

func rereadImportedInvoices(ctx context.Context, tx *db.Tx, source string, results []map[string]any) error {
	for _, r := range results {
		status, _ := r["status"].(string)
		if status != "unchanged" && status != "created" {
			continue
		}
		ext, _ := r["external_id"].(string)
		if ext == "" {
			return fmt.Errorf("linha %v sem id externo", r["row"])
		}
		ex, err := one(ctx, tx, "helper:importInvoiceRow", 1, source, ext)
		if err != nil {
			return err
		}
		if ex == nil || canonicalHeldID(ex.Get("id")) == "" || canonicalHeldID(ex.Get("id")) != canonicalHeldID(r["entity_id"]) {
			return apierr.New(409, "fatura reimportada mudou antes do registro")
		}
	}
	return nil
}

func importInvoice(ctx context.Context, tx *db.Tx, b map[string]any, r map[string]string, t map[string]any) (map[string]any, error) {
	const key = "helper:importInvoiceRow"
	ext := r["id_externo"]
	sit := strings.ToLower(r["situacao"])
	if sit == "" {
		sit = "aberto"
	}
	fail := func(s string) (map[string]any, error) { return nil, rowError(s) }
	if !slices.Contains([]string{"aberto", "pago", "cancelado"}, sit) {
		return fail(fmt.Sprintf("situação do título desconhecida: \"%s\" (use aberto, pago ou cancelado)", r["situacao"]))
	}
	if ext == "" {
		return fail("id_externo ausente")
	}
	amount, ok := cents(r["valor"])
	if !ok || amount <= 0 {
		return fail(fmt.Sprintf("valor inválido: \"%s\"", r["valor"]))
	}
	due := importDate(r["vencimento"])
	if due == nil {
		return fail(fmt.Sprintf("vencimento inválido: \"%s\" (use AAAA-MM-DD ou DD/MM/AAAA)", r["vencimento"]))
	}
	var comp any
	if r["competencia"] != "" {
		if !regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])$`).MatchString(r["competencia"]) {
			return fail(fmt.Sprintf("competência inválida: \"%s\" (use AAAA-MM)", r["competencia"]))
		}
		comp = r["competencia"] + "-01"
	}
	var k jsonx.Object
	var e error
	if r["id_externo_contrato"] != "" {
		k, e = importOne(ctx, tx, "select id,subscriber_id from contracts where external_source=$1 and external_id=$2", b["source"], r["id_externo_contrato"])
		if e == nil && k != nil && r["id_externo_assinante"] != "" {
			owner, oe := importOne(ctx, tx, "select id from subscribers where external_source=$1 and external_id=$2", b["source"], r["id_externo_assinante"])
			if oe != nil {
				return nil, oe
			}
			if owner == nil || owner.Get("id") != k.Get("subscriber_id") {
				return fail("contrato não pertence ao assinante informado")
			}
		}
	} else {
		matches, qe := tx.Objects(ctx, "select k.id,k.subscriber_id from contracts k join subscribers s on s.id=k.subscriber_id where s.external_source=$1 and s.external_id=$2 order by k.created_at,k.id", b["source"], r["id_externo_assinante"])
		e = qe
		if len(matches) > 1 {
			return fail("assinante possui múltiplos contratos; informe id_externo_contrato")
		}
		if len(matches) == 1 {
			k = matches[0]
		}
	}
	if e != nil {
		return nil, e
	}
	if k == nil {
		return fail(fmt.Sprintf("contrato do assinante \"%s\" não encontrado nesta origem; importe os assinantes antes", r["id_externo_assinante"]))
	}
	ex, e := one(ctx, tx, key, 1, b["source"], ext)
	if e != nil {
		return nil, e
	}
	if ex != nil {
		if !invoiceLockHeld(ctx, ex.Get("id")) {
			return nil, apierr.New(409, "fatura reconhecida fora da ordem de locks; repita a importação")
		}
		var paidAt any
		paid := float64(0)
		if sit == "pago" {
			var pe error
			paidAt, paid, pe = invoicePaid(r, amount)
			if pe != nil {
				return nil, pe
			}
		}
		msgs := invoiceDivergence(ex, sit, amount, due, paid, paidAt)
		if len(msgs) > 0 {
			inc(t, "conflicts", 1)
		}
		return importResult(ext, "unchanged", ex.Get("id"), msgs), nil
	}
	if comp != nil {
		found, e := one(ctx, tx, key, 2, k.Get("id"), comp)
		if e != nil {
			return nil, e
		}
		if found != nil {
			return fail(fmt.Sprintf("já existe mensalidade da competência %s para este contrato; título não importado para evitar cobrança em dobro", r["competencia"]))
		}
	}
	var paidAt any
	paid := float64(0)
	if sit == "pago" {
		var pe error
		paidAt, paid, pe = invoicePaid(r, amount)
		if pe != nil {
			return nil, pe
		}
	}
	full := sit == "pago" && paid >= amount
	status := "open"
	var paidValue, canceled, note any
	if sit == "cancelado" {
		status = "canceled"
		canceled = time.Now()
		note = fmt.Sprintf("cancelado na origem (%v)", b["source"])
	} else if full {
		status = "paid"
		paidValue = paidAt
	}
	kind := "manual"
	if comp != nil {
		kind = "monthly"
	}
	tenant := auth.From(ctx).TenantID
	i, e := one(ctx, tx, key, 3, tenant, k.Get("id"), k.Get("subscriber_id"), kind, comp, due, amount, status, paidValue, canceled, note, b["source"], ext)
	if e != nil {
		return nil, e
	}
	description := r["descricao"]
	if description == "" {
		description = fmt.Sprintf("Título importado (%v %s)", b["source"], ext)
	}
	if e = tx.Exec(ctx, query(key, 4), tenant, i.Get("id"), description, amount); e != nil {
		return nil, e
	}
	msgs := []string{}
	if sit == "pago" {
		if e = tx.Exec(ctx, query(key, 5), tenant, i.Get("id"), paid, paidAt, nilEmpty(r["forma_pagamento"]), fmt.Sprintf("Importado de %v (id %s)", b["source"], ext)); e != nil {
			return nil, e
		}
		inc(t, "paid_cents_total", paid)
		if full {
			inc(t, "invoices_paid", 1)
		} else {
			inc(t, "invoices_partial", 1)
			msgs = append(msgs, strings.ReplaceAll(fmt.Sprintf("pagamento parcial (%.2f de %.2f): título segue em aberto pelo saldo", paid/100, amount/100), ".", ","))
		}
	} else if sit == "cancelado" {
		inc(t, "invoices_canceled", 1)
	}
	if status == "open" {
		inc(t, "amount_cents_total", amount-paid)
	}
	return importResult(ext, "created", i.Get("id"), msgs), nil
}
func invoicePaid(r map[string]string, amount float64) (any, float64, error) {
	paidAt := importDate(r["pago_em"])
	if paidAt == nil {
		return nil, 0, rowError(fmt.Sprintf("pago_em inválido ou ausente: \"%s\" (obrigatório para título pago)", r["pago_em"]))
	}
	paid := amount
	if r["valor_pago"] != "" {
		var ok bool
		paid, ok = cents(r["valor_pago"])
		if !ok {
			paid = -1
		}
	}
	if paid <= 0 {
		return nil, 0, rowError(fmt.Sprintf("valor_pago inválido: \"%s\"", r["valor_pago"]))
	}
	if paid > amount*2 {
		return nil, 0, rowError(fmt.Sprintf("valor_pago (%s) muito acima do valor do título; confira o arquivo", r["valor_pago"]))
	}
	return paidAt, paid, nil
}
func asDate(v any) string {
	switch x := v.(type) {
	case string:
		if len(x) >= 10 && x[4] == '-' && x[7] == '-' {
			return x[:10]
		}
		return x
	case time.Time:
		return x.Format("2006-01-02")
	case jsonx.Time:
		return x.Format("2006-01-02")
	default:
		return fmt.Sprint(v)
	}
}
func brMoney(cents float64) string {
	sign := ""
	rounded := math.Round(cents)
	if rounded < 0 {
		sign = "-"
		rounded = -rounded
	}
	whole := int64(rounded) / 100
	frac := int64(rounded) % 100
	digits := strconv.FormatInt(whole, 10)
	grouped := make([]byte, 0, len(digits)+len(digits)/3)
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			grouped = append(grouped, '.')
		}
		grouped = append(grouped, digits[i])
	}
	return sign + "R$ " + string(grouped) + "," + fmt.Sprintf("%02d", frac)
}
func invoiceKeep(origin, current string) string {
	return fmt.Sprintf("origem: %s; Nexo: %s — título não alterado, conciliar manualmente", origin, current)
}
func importOriginState(sit string, paid, amount float64, paidAt any) (string, string) {
	switch sit {
	case "cancelado":
		return "cancelado", "cancelado"
	case "pago":
		when := ""
		if paidAt != nil {
			when = " em " + asDate(paidAt)
		}
		if paid < amount {
			return "parcial", "pago parcial" + when + " " + brMoney(paid)
		}
		return "pago", "pago" + when + " " + brMoney(paid)
	default:
		return "aberto", "em aberto"
	}
}
func importCurrentState(status string, received, amount float64) (string, string) {
	switch status {
	case "canceled":
		return "cancelado", "cancelado"
	case "paid":
		if received > 0 && received < amount {
			return "parcial", "pago parcial " + brMoney(received)
		}
		return "pago", "pago " + brMoney(received)
	default:
		if received > 0 && received < amount {
			label := "pago parcial " + brMoney(received)
			if status == "reconciling" {
				label += " (em conciliação)"
			}
			return "parcial", label
		}
		if received >= amount && received > 0 {
			return "pago", "pago " + brMoney(received)
		}
		if status == "reconciling" {
			return "reconciling", "em conciliação"
		}
		return "aberto", "em aberto"
	}
}
func invoiceDivergence(ex jsonx.Object, sit string, amount float64, due any, paid float64, paidAt any) []string {
	received := num(ex.Get("received_cents"))
	currentAmount := num(ex.Get("amount_cents"))
	status, _ := ex.Get("status").(string)
	originKind, originLabel := importOriginState(sit, paid, amount, paidAt)
	currentKind, currentLabel := importCurrentState(status, received, currentAmount)
	msgs := []string{}
	if originKind != currentKind {
		msgs = append(msgs, invoiceKeep(originLabel, currentLabel))
	} else if (originKind == "pago" || originKind == "parcial") && math.Round(paid) != math.Round(received) {
		msgs = append(msgs, invoiceKeep("valor pago "+brMoney(paid), "valor pago "+brMoney(received)))
	}
	if math.Round(currentAmount) != math.Round(amount) {
		msgs = append(msgs, invoiceKeep("valor "+brMoney(amount), "valor "+brMoney(currentAmount)))
	}
	originDue, currentDue := asDate(due), asDate(ex.Get("due_date"))
	if originDue != currentDue {
		msgs = append(msgs, invoiceKeep("vencimento "+originDue, "vencimento "+currentDue))
	}
	return msgs
}
func unaccent(s string) string {
	out := strings.Builder{}
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		if r < 0x300 || r > 0x36f {
			out.WriteRune(r)
		}
	}
	return out.String()
}
func importHistory(ctx context.Context, tx *db.Tx, b map[string]any, r map[string]string, t map[string]any) (map[string]any, error) {
	const key = "helper:importHistoryRow"
	ext, kind := r["id_externo"], unaccent(r["tipo"])
	fail := func(s string) (map[string]any, error) { return nil, rowError(s) }
	if ext == "" {
		return fail("id_externo ausente")
	}
	if !slices.Contains([]string{"atendimento", "ocorrencia", "os", "ordem de servico", "anotacao", "observacao"}, kind) {
		return fail(fmt.Sprintf("tipo desconhecido: \"%s\" (use atendimento, os ou anotacao)", r["tipo"]))
	}
	at := importWhen(r["data"])
	if at == nil {
		return fail(fmt.Sprintf("data inválida: \"%s\" (use AAAA-MM-DD [HH:MM] ou DD/MM/AAAA [HH:MM])", r["data"]))
	}
	if r["descricao"] == "" {
		return fail("descricao ausente")
	}
	if len(utf16.Encode([]rune(r["descricao"]))) > 8000 {
		return fail("descricao acima de 8000 caracteres")
	}
	sub, e := one(ctx, tx, key, 0, b["source"], r["id_externo_assinante"])
	if e != nil {
		return nil, e
	}
	if sub == nil {
		return fail(fmt.Sprintf("assinante \"%s\" não encontrado nesta origem; importe os assinantes antes", r["id_externo_assinante"]))
	}
	k, e := one(ctx, tx, key, 1, sub.Get("id"))
	if e != nil {
		return nil, e
	}
	sit := unaccent(r["situacao"])
	closed := slices.Contains([]string{"", "fechado", "fechada", "encerrado", "encerrada", "concluido", "concluida", "resolvido", "finalizado", "finalizada"}, sit)
	canceled := sit == "cancelado" || sit == "cancelada"
	if !closed && !canceled && !slices.Contains([]string{"aberto", "aberta", "pendente", "em andamento"}, sit) {
		return fail(fmt.Sprintf("situação desconhecida: \"%s\" (use aberto, fechado ou cancelado)", r["situacao"]))
	}
	end := at
	if r["encerrado_em"] != "" {
		end = importWhen(r["encerrado_em"])
		if end == nil {
			return fail(fmt.Sprintf("encerrado_em inválido: \"%s\"", r["encerrado_em"]))
		}
	}
	who := ""
	if r["responsavel"] != "" {
		who = " (responsável no sistema anterior: " + cut(r["responsavel"], 80) + ")"
	}
	table := "tickets"
	if strings.HasPrefix(kind, "anot") || kind == "observacao" {
		table = "subscriber_notes"
	} else if kind == "os" || strings.HasPrefix(kind, "ordem") {
		table = "work_orders"
	}
	existing, e := importOne(ctx, tx, "select id from "+table+" where external_source=$1 and external_id=$2", b["source"], ext)
	if e != nil {
		return nil, e
	}
	if existing != nil {
		return importResult(ext, "unchanged", existing.Get("id"), []string{}), nil
	}
	tenant := auth.From(ctx).TenantID
	var row jsonx.Object
	if table == "subscriber_notes" {
		row, e = one(ctx, tx, key, 3, tenant, sub.Get("id"), k.Get("id"), cut(r["descricao"]+who, 2000), at, b["source"], ext)
		if e != nil {
			return nil, e
		}
		inc(t, "history_notes", 1)
	} else if table == "tickets" {
		category := map[string]string{"tecnico": "technical", "técnico": "technical", "suporte": "technical", "financeiro": "financial", "cobranca": "financial", "cobrança": "financial", "comercial": "commercial", "vendas": "commercial"}[strings.ToLower(r["categoria"])]
		if category == "" {
			category = "other"
		}
		number, e := domain.NextNumber(ctx, tx, tenant, "ticket")
		if e != nil {
			return nil, e
		}
		status := "open"
		var ended any
		if closed || canceled {
			status = "closed"
			ended = end
		}
		subject := r["assunto"]
		if subject == "" {
			subject = r["descricao"]
		}
		row, e = one(ctx, tx, key, 4, tenant, number, sub.Get("id"), k.Get("id"), cut(subject, 200), category, status, at, end, ended, b["source"], ext)
		if e != nil {
			return nil, e
		}
		if e = tx.Exec(ctx, query(key, 5), tenant, row.Get("id"), at, r["descricao"]+who); e != nil {
			return nil, e
		}
		if r["solucao"] != "" {
			if e = tx.Exec(ctx, query(key, 6), tenant, row.Get("id"), end, "Solução: "+r["solucao"]); e != nil {
				return nil, e
			}
		}
		inc(t, "history_tickets", 1)
	} else {
		kind := map[string]string{"instalacao": "install", "instalação": "install", "reparo": "repair", "manutencao": "repair", "manutenção": "repair", "suporte": "repair", "mudanca": "address_change", "mudança": "address_change", "mudanca de endereco": "address_change", "mudança de endereço": "address_change", "retirada": "removal", "recolhimento": "removal"}[strings.ToLower(r["tipo_os"])]
		if kind == "" {
			kind = "other"
		}
		status := "open"
		if canceled {
			status = "canceled"
		} else if closed {
			status = "done"
		}
		number, e := domain.NextNumber(ctx, tx, tenant, "work_order")
		if e != nil {
			return nil, e
		}
		description := r["descricao"] + who
		if r["assunto"] != "" {
			description = r["assunto"] + ": " + description
		}
		resolution := nilEmpty(r["solucao"])
		if status == "done" && resolution == nil {
			resolution = "concluída no sistema anterior"
		}
		var ended any
		if status != "open" {
			ended = end
		}
		row, e = one(ctx, tx, key, 7, tenant, number, kind, status, sub.Get("id"), k.Get("id"), cut(description, 4000), resolution, at, end, ended, b["source"], ext)
		if e != nil {
			return nil, e
		}
		inc(t, "history_work_orders", 1)
	}
	return importResult(ext, "created", row.Get("id"), []string{}), nil
}
