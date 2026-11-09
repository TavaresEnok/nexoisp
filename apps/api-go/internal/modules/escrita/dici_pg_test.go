package escrita

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

// Exportação DICI contra PostgreSQL real: leiaute exato por empresa e bloqueio
// com a lista do que corrigir (município sem IBGE, plano sem tecnologia, CNPJ).
func TestDICIExportPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_DICI_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; SQL não validado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	// Identificadores no fim da ordenação: outros testes usam o menor tenant do diretório.
	tenants := []string{lateTenantID(), lateTenantID()}
	if err = d.WithScope(ctx, op, func(tx *db.Tx) error {
		for _, id := range tenants {
			if e := tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste DICI',$2)`, id, "dici-"+strings.ReplaceAll(id, "-", "")[:20]); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=any($1::uuid[])`, tenants)
		}); e != nil {
			t.Error(e)
		}
	})
	tenant := tenants[0]
	ids := map[string]string{}
	exec := func(query string, args ...any) {
		t.Helper()
		if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error { return tx.Exec(ctx, query, args...) }); e != nil {
			t.Fatal(e)
		}
	}
	insert := func(key, query string, args ...any) {
		t.Helper()
		if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			var id string
			e := tx.QueryRow(ctx, query, args...).Scan(&id)
			ids[key] = id
			return e
		}); e != nil {
			t.Fatal(e)
		}
	}
	insert("companyA", `insert into companies(tenant_id,name,document,is_default) values($1,'Empresa Alfa','11222333000181',true) returning id`, tenant)
	insert("companyB", `insert into companies(tenant_id,name,document) values($1,'Empresa Beta','11222333000182') returning id`, tenant)
	plan := func(key, tech string, kbps int) {
		t.Helper()
		var technology any
		if tech != "" {
			technology = tech
		}
		insert(key, `insert into plans(tenant_id,name,access_technology) values($1,$2,$3) returning id`, tenant, "Plano "+key, technology)
		insert(key+"v", `insert into plan_versions(tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values($1,$2,1,9900,$3,$3,'dici') returning id`, tenant, ids[key], kbps)
	}
	plan("fibra", "FTTH", 300000)
	plan("radio", "RADIO", 10500)
	plan("semtec", "", 50000)
	exec(`insert into municipalities(tenant_id,name,state,ibge_code) values($1,'Fortaleza','CE','2304400')`, tenant)
	subscriber := func(key, document, city string) {
		t.Helper()
		var doc any
		if document != "" {
			doc = document
		}
		insert(key, `insert into subscribers(tenant_id,name,document,address_city,address_state) values($1,$2,$3,$4,'CE') returning id`, tenant, "Titular "+key, doc, city)
	}
	subscriber("pf", "12345678909", "fortaleza")
	subscriber("pj", "11444777000161", "Fortaleza")
	subscriber("semibge", "98765432100", "Cidade Sem Código")
	contract := func(key, sub, version string, company any, area string) {
		t.Helper()
		insert(key, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day,company_id,service_area) values($1,$2,$3,10,$4,$5) returning id`, tenant, ids[sub], ids[version], company, area)
	}
	contract("c1", "pf", "fibrav", ids["companyA"], "urban")
	contract("c2", "pj", "fibrav", ids["companyA"], "rural")
	contract("c3", "pf", "radiov", nil, "urban") // sem empresa: usa a padrão

	actors := map[string]*auth.Ctx{}
	for i, id := range tenants {
		actors[ftthHash("dici-"+string(rune('a'+i)))] = &auth.Ctx{UserID: uuid.NewString(), TenantID: id, Role: "admin", Permissions: auth.Permissions["admin"], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: id}}
	}
	actors[ftthHash("dici-atendimento")] = &auth.Ctx{UserID: uuid.NewString(), TenantID: tenant, Role: "attendant", Permissions: auth.Permissions["attendant"], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant}}
	a, err := auth.New(ftthLoader{actors}, 0, false, 1000, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	old := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	defer func() { huma.NewError = old }()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	cfg := huma.DefaultConfig("dici", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	Register(humachi.New(router, cfg), registry, Service{DB: d})
	var competence string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select to_char(current_date,'YYYY-MM')`).Scan(&competence)
	}); err != nil {
		t.Fatal(err)
	}
	year, month, _ := strings.Cut(competence, "-")
	get := func(token, query string, want int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/anatel/dici?competence="+competence+query, nil)
		req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("dici %s: got %d want %d: %s", query, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	report := func(query string) (bool, []string) {
		t.Helper()
		var out struct {
			Ready  bool     `json:"ready"`
			Issues []string `json:"issues"`
		}
		if e := json.Unmarshal(get("dici-a", query, 200).Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		return out.Ready, out.Issues
	}
	byCompany := "&company_id=" + ids["companyA"]
	want := "\ufeffCNPJ;ANO;MES;COD_IBGE;TIPO_CLIENTE;TIPO_ATENDIMENTO;TIPO_MEIO;TIPO_PRODUTO;TIPO_TECNOLOGIA;VELOCIDADE;ACESSOS\r\n" +
		"11222333000181;" + year + ";" + month + ";2304400;PF;URBANO;fibra;internet;FTTH;300;1\r\n" +
		"11222333000181;" + year + ";" + month + ";2304400;PF;URBANO;radio;internet;Wi-Fi;10,5;1\r\n" +
		"11222333000181;" + year + ";" + month + ";2304400;PJ;RURAL;fibra;internet;FTTH;300;1\r\n"
	if ready, issues := report(byCompany); !ready || len(issues) != 0 {
		t.Fatalf("coleta completa bloqueada: %v", issues)
	}
	rec := get("dici-a", byCompany+"&format=csv", 200)
	if rec.Body.String() != want || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/csv") || !strings.Contains(rec.Header().Get("Content-Disposition"), "dici-acessos-"+competence+".csv") {
		t.Fatalf("leiaute divergente:\n%q\n%q\n%v", rec.Body.String(), want, rec.Header())
	}
	get("dici-atendimento", byCompany, 403)
	get("dici-b", byCompany, 404)
	get("dici-a", "&company_id=nao-uuid", 400)

	// CNPJ inválido de outra empresa bloqueia a declaração geral, não a da empresa correta.
	contract("c5", "pf", "fibrav", ids["companyB"], "urban")
	ready, issues := report("")
	if ready || !strings.Contains(strings.Join(issues, "\n"), "Empresa Beta: CNPJ ausente ou inválido (1 contrato(s))") {
		t.Fatalf("CNPJ inválido não bloqueou: %v", issues)
	}
	rec = get("dici-a", "&format=csv", 409)
	if !strings.Contains(rec.Body.String(), "dici_blocked") || !strings.Contains(rec.Body.String(), "Empresa Beta") {
		t.Fatal(rec.Body.String())
	}
	if get("dici-a", byCompany+"&format=csv", 200).Body.String() != want {
		t.Fatal("declaração da empresa correta mudou")
	}

	// Município sem código e plano sem tecnologia bloqueiam com a lista do que corrigir.
	contract("c4", "semibge", "fibrav", ids["companyA"], "urban")
	contract("c6", "pf", "semtecv", ids["companyA"], "urban")
	ready, issues = report(byCompany)
	joined := strings.Join(issues, "\n")
	if ready || !strings.Contains(joined, "Município sem código IBGE: Cidade Sem Código/CE (1 contrato(s))") || !strings.Contains(joined, "Plano semtec sem tecnologia de acesso (1 contrato(s))") || strings.Contains(joined, "Empresa Beta") {
		t.Fatalf("pendências: %v", issues)
	}
	rec = get("dici-a", byCompany+"&format=csv", 409)
	if !strings.Contains(rec.Body.String(), "Cidade Sem Código") || !strings.Contains(rec.Body.String(), "Plano semtec") {
		t.Fatal(rec.Body.String())
	}
	exec(`update plans set access_technology='OUTRA' where id=$1`, ids["semtec"])
	if _, issues = report(byCompany); !strings.Contains(strings.Join(issues, "\n"), "Plano semtec com tecnologia sem código no leiaute") {
		t.Fatalf("tecnologia genérica aceita: %v", issues)
	}
	exec(`insert into municipalities(tenant_id,name,state,ibge_code) values($1,'Cidade Sem Codigo','CE','2300000')`, tenant)
	exec(`update plans set access_technology='FTTH' where id=$1`, ids["semtec"])
	if ready, issues = report(byCompany); !ready {
		t.Fatalf("correções não liberaram a exportação: %v", issues)
	}
	csv := get("dici-a", byCompany+"&format=csv", 200).Body.String()
	if !strings.Contains(csv, ";2300000;PF;URBANO;fibra;internet;FTTH;300;1\r\n") || !strings.Contains(csv, ";2304400;PF;URBANO;fibra;internet;FTTH;50;1\r\n") {
		t.Fatal(csv)
	}
}
