package escrita

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

// Coleta de acessos SCM da ANATEL (DICI). O arquivo segue o leiaute de envio
// manual no sistema Coleta de Dados: CSV em UTF-8 com BOM, linhas CRLF,
// separador ponto e vírgula e cabeçalho na ordem abaixo. A ANATEL não oferece
// API pública de envio; o provedor importa o arquivo no sistema de coleta.
var diciHeader = []string{"CNPJ", "ANO", "MES", "COD_IBGE", "TIPO_CLIENTE", "TIPO_ATENDIMENTO", "TIPO_MEIO", "TIPO_PRODUTO", "TIPO_TECNOLOGIA", "VELOCIDADE", "ACESSOS"}

// Domínios do leiaute. Tipo de cliente: PF/PJ (AP, acesso próprio, não é gerado
// pelo ERP). Atendimento: URBANO/RURAL. Produto: internet (banda larga fixa).
// O meio e a tecnologia derivam da tecnologia cadastrada no plano.
var diciMedium = map[string]string{"FTTH": "fibra", "FTTB": "fibra", "HFC": "cabo_coaxial", "XDSL": "cabo_metalico", "ETHERNET": "cabo_metalico", "RADIO": "radio", "LTE": "radio", "SATELITE": "satelite"}
var diciTechnology = map[string]string{"FTTH": "FTTH", "FTTB": "FTTB", "HFC": "HFC", "XDSL": "xDSL", "ETHERNET": "ETHERNET", "RADIO": "Wi-Fi", "LTE": "LTE", "SATELITE": "VSAT"}

const diciProduct = "internet"

// Contratos em serviço no último dia da competência, com a empresa efetiva
// (contrato ou empresa padrão), município casado pelo nome normalizado e o
// plano da versão contratada. $2 restringe a uma empresa (declaração por CNPJ).
const diciBase = `with params as (select ($1::date + interval '1 month' - interval '1 day')::date as last_day),
ativos as (
  select k.id, k.service_area, s.document, coalesce(k.company_id, (select id from companies d where d.is_default and d.active)) as company_id,
         coalesce(nullif(k.install_city, ''), s.address_city) as city, upper(coalesce(nullif(k.install_state, ''), s.address_state)) as state,
         p.id as plan_id, p.name as plan_name, p.access_technology, pv.down_kbps
  from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id, params
  where k.start_date <= params.last_day and (k.status = 'active' or k.end_date > params.last_day)),
base as (
  select a.*, c.name as company_name, c.document as cnpj, m.ibge_code
  from ativos a left join companies c on c.id = a.company_id
  left join municipalities m on m.state = a.state and norm_city(m.name) = norm_city(a.city)
  where $2::uuid is null or a.company_id = $2::uuid)
`

type diciRow struct {
	CNPJ, IBGE, Client, Area, Medium, Technology string
	Mbps                                         float64
	Accesses                                     int
}

// diciCNPJ devolve só os dígitos e confere os dígitos verificadores.
func diciCNPJ(raw string) (string, bool) {
	var d []int
	digits := strings.Builder{}
	for _, c := range raw {
		if c >= '0' && c <= '9' {
			d = append(d, int(c-'0'))
			digits.WriteRune(c)
		}
	}
	if len(d) != 14 {
		return digits.String(), false
	}
	same := true
	for _, v := range d {
		same = same && v == d[0]
	}
	if same {
		return digits.String(), false
	}
	check := func(n int) int {
		weights := []int{6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2}[13-n:]
		sum := 0
		for i := 0; i < n; i++ {
			sum += d[i] * weights[i]
		}
		if r := sum % 11; r >= 2 {
			return 11 - r
		}
		return 0
	}
	return digits.String(), check(12) == d[12] && check(13) == d[13]
}

func diciSpeed(mbps float64) string {
	return strings.Replace(strconv.FormatFloat(mbps, 'f', -1, 64), ".", ",", 1)
}

// diciCSV gera o arquivo do leiaute. As linhas já chegam validadas.
func diciCSV(competence string, rows []diciRow) []byte {
	year, month, _ := strings.Cut(competence, "-")
	// Manual da coleta: um dígito de janeiro a setembro, dois de outubro a dezembro.
	month = strings.TrimLeft(month, "0")
	lines := []string{strings.Join(diciHeader, ";")}
	sorted := append([]diciRow(nil), rows...)
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		for _, pair := range [][2]string{{a.CNPJ, b.CNPJ}, {a.IBGE, b.IBGE}, {a.Client, b.Client}, {a.Area, b.Area}, {a.Medium, b.Medium}, {a.Technology, b.Technology}} {
			if pair[0] != pair[1] {
				return pair[0] < pair[1]
			}
		}
		return a.Mbps < b.Mbps
	})
	for _, r := range sorted {
		lines = append(lines, strings.Join([]string{r.CNPJ, year, month, r.IBGE, r.Client, r.Area, r.Medium, diciProduct, r.Technology, diciSpeed(r.Mbps), strconv.Itoa(r.Accesses)}, ";"))
	}
	return []byte("\ufeff" + strings.Join(lines, "\r\n") + "\r\n")
}

type diciCompany struct {
	ID, Name, Document string
	Contracts          int
}
type diciPlan struct {
	ID, Name, Technology string
	Contracts            int
}
type diciCity struct {
	City, State string
	Contracts   int
}

// diciIssues lista o que impede a geração do arquivo. Nenhuma linha é omitida
// em silêncio: com qualquer pendência a exportação é recusada.
func diciIssues(companies []diciCompany, plans []diciPlan, cities []diciCity, withoutCity int) []string {
	issues := []string{}
	for _, c := range companies {
		if c.ID == "" {
			issues = append(issues, fmt.Sprintf("%d contrato(s) sem empresa faturadora e sem empresa padrão: vincule uma empresa com CNPJ", c.Contracts))
			continue
		}
		if _, ok := diciCNPJ(c.Document); !ok {
			issues = append(issues, fmt.Sprintf("Empresa %s: CNPJ ausente ou inválido (%d contrato(s))", c.Name, c.Contracts))
		}
	}
	for _, c := range cities {
		if c.City == "" || c.State == "" {
			issues = append(issues, fmt.Sprintf("%d contrato(s) sem cidade ou UF no endereço de instalação ou do assinante", c.Contracts))
			continue
		}
		issues = append(issues, fmt.Sprintf("Município sem código IBGE: %s/%s (%d contrato(s))", c.City, c.State, c.Contracts))
	}
	listed := 0
	for _, c := range cities {
		listed += c.Contracts
	}
	if withoutCity > listed {
		issues = append(issues, fmt.Sprintf("Outros %d contrato(s) em municípios sem código IBGE", withoutCity-listed))
	}
	for _, p := range plans {
		if p.Technology == "" {
			issues = append(issues, fmt.Sprintf("Plano %s sem tecnologia de acesso (%d contrato(s))", p.Name, p.Contracts))
		} else {
			issues = append(issues, fmt.Sprintf("Plano %s com tecnologia sem código no leiaute da ANATEL (%d contrato(s)): escolha a tecnologia correspondente", p.Name, p.Contracts))
		}
	}
	return issues
}

func diciInt(v any) int {
	if v == nil {
		return 0
	}
	return int(num(v))
}

func (s Service) dici(ctx context.Context, tx *db.Tx, _ string, _ map[string]any) (any, error) {
	q := reportQuery(ctx)
	competence := q.String("competence", false, true)
	if len(q.Issues) == 0 && !diciCompetence.MatchString(competence) {
		q.Issues = append(q.Issues, "competence: competência AAAA-MM")
	}
	format := q.Enum("format", "json", "json", "csv")
	company := q.UUID("company_id", false)
	if err := q.Err(); err != nil {
		return nil, err
	}
	first := competence + "-01"
	companyArg := textNil(company)
	if company != "" {
		found, err := tx.Objects(ctx, `select 1 from companies where id = $1`, company)
		if err != nil {
			return nil, err
		}
		if len(found) == 0 {
			return nil, apierr.New(404, "empresa não encontrada")
		}
	}
	grouped, err := tx.Objects(ctx, diciBase+`select cnpj, ibge_code, case when length(coalesce(document, '')) = 14 then 'PJ' else 'PF' end as tipo_cliente,
       case service_area when 'rural' then 'RURAL' else 'URBANO' end as tipo_atendimento, access_technology,
       (down_kbps / 1000.0)::float8 as velocidade_mbps, count(*)::int as acessos
  from base where company_id is not null and ibge_code is not null and access_technology is not null
  group by 1, 2, 3, 4, 5, 6 order by 1, 2, 3, 4, 5, 6`, first, companyArg)
	if err != nil {
		return nil, err
	}
	counts, err := tx.Objects(ctx, diciBase+`select count(*) filter (where company_id is null or cnpj is null)::int as sem_cnpj, count(*) filter (where ibge_code is null)::int as sem_municipio,
       count(*) filter (where access_technology is null)::int as sem_tecnologia, count(*)::int as total from base`, first, companyArg)
	if err != nil {
		return nil, err
	}
	cityRows, err := tx.Objects(ctx, diciBase+`select city, state, count(*)::int as contratos from base where ibge_code is null group by 1, 2 order by 3 desc, 1, 2 limit 50`, first, companyArg)
	if err != nil {
		return nil, err
	}
	planRows, err := tx.Objects(ctx, diciBase+`select plan_id as id, plan_name as name, access_technology, count(*)::int as contratos from base where access_technology is null or access_technology not in ('FTTH','FTTB','HFC','XDSL','ETHERNET','RADIO','LTE','SATELITE') group by 1, 2, 3 order by 2, 1 limit 50`, first, companyArg)
	if err != nil {
		return nil, err
	}
	companyRows, err := tx.Objects(ctx, diciBase+`select company_id as id, company_name as name, cnpj as document, count(*)::int as contratos from base group by 1, 2, 3 order by 2 nulls first, 1`, first, companyArg)
	if err != nil {
		return nil, err
	}
	companies := []diciCompany{}
	companyList := []map[string]any{}
	for _, r := range companyRows {
		c := diciCompany{ID: jsonx.String(r.Get("id")), Name: jsonx.String(r.Get("name")), Document: jsonx.String(r.Get("document")), Contracts: diciInt(r.Get("contratos"))}
		if r.Get("id") == nil {
			c.ID = ""
		}
		if r.Get("document") == nil {
			c.Document = ""
		}
		companies = append(companies, c)
		digits, valid := diciCNPJ(c.Document)
		if c.ID != "" {
			companyList = append(companyList, map[string]any{"id": c.ID, "name": c.Name, "cnpj": digits, "cnpj_valid": valid, "contratos": c.Contracts})
		}
	}
	plans := []diciPlan{}
	planList := []map[string]any{}
	for _, r := range planRows {
		p := diciPlan{ID: jsonx.String(r.Get("id")), Name: jsonx.String(r.Get("name")), Contracts: diciInt(r.Get("contratos"))}
		if v := r.Get("access_technology"); v != nil {
			p.Technology = jsonx.String(v)
		}
		plans = append(plans, p)
		planList = append(planList, map[string]any{"id": p.ID, "name": p.Name, "access_technology": r.Get("access_technology"), "contratos": p.Contracts})
	}
	cities := []diciCity{}
	for _, r := range cityRows {
		c := diciCity{Contracts: diciInt(r.Get("contratos"))}
		if v := r.Get("city"); v != nil {
			c.City = strings.TrimSpace(jsonx.String(v))
		}
		if v := r.Get("state"); v != nil {
			c.State = strings.TrimSpace(jsonx.String(v))
		}
		cities = append(cities, c)
	}
	pending := counts[0]
	issues := diciIssues(companies, plans, cities, diciInt(pending.Get("sem_municipio")))
	layout := []diciRow{}
	preview := []map[string]any{}
	accesses := 0
	for _, r := range grouped {
		tech := jsonx.String(r.Get("access_technology"))
		code, mapped := diciTechnology[tech]
		cnpj, _ := diciCNPJ(jsonx.String(r.Get("cnpj")))
		row := diciRow{CNPJ: cnpj, IBGE: jsonx.String(r.Get("ibge_code")), Client: jsonx.String(r.Get("tipo_cliente")), Area: jsonx.String(r.Get("tipo_atendimento")), Medium: diciMedium[tech], Technology: code, Mbps: num(r.Get("velocidade_mbps")), Accesses: diciInt(r.Get("acessos"))}
		accesses += row.Accesses
		preview = append(preview, map[string]any{"cnpj": row.CNPJ, "ibge_code": row.IBGE, "tipo_cliente": row.Client, "tipo_atendimento": row.Area, "meio": row.Medium, "tecnologia": tech, "tipo_tecnologia": row.Technology, "tipo_produto": diciProduct, "velocidade_mbps": row.Mbps, "acessos": row.Accesses})
		if mapped {
			layout = append(layout, row)
		}
	}
	pending.Set("cities_without_code", cityRows)
	pending.Set("plans_without_technology", planList)
	pending.Set("companies", companyList)
	if err = record(ctx, tx, "anatel.dici", "report", nil, map[string]any{"competence": competence, "format": format, "accesses": accesses, "company_id": companyArg, "blocked": len(issues) > 0}); err != nil {
		return nil, err
	}
	if format == "json" {
		return map[string]any{"competence": competence, "company_id": companyArg, "rows": preview, "pending": pending, "issues": issues, "ready": len(issues) == 0, "header": diciHeader}, nil
	}
	if len(issues) > 0 {
		shown := issues
		if len(shown) > 5 {
			shown = append(append([]string{}, shown[:5]...), fmt.Sprintf("e mais %d pendência(s)", len(issues)-5))
		}
		return nil, &apierr.Error{Status: 409, Message: "exportação DICI bloqueada; corrija antes de gerar o arquivo: " + strings.Join(shown, "; "), Code: "dici_blocked"}
	}
	name := "dici-acessos-" + competence + ".csv"
	return endpoint.Result{Raw: diciCSV(competence, layout), ContentType: "text/csv; charset=utf-8", Disposition: `attachment; filename="` + name + `"`, CacheControl: "private, no-store"}, nil
}
