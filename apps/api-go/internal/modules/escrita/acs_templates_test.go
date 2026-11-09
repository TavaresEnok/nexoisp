package escrita

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/acs"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

// ACS sintético: só responde à consulta de inventário; qualquer tentativa de
// criar tarefa é registrada para provar que nenhuma rota de template chama o
// ACS fora do diário durável.
type templateACS struct {
	mu      sync.Mutex
	devices []map[string]any
	writes  int
}

func (f *templateACS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodGet || r.URL.Path != "/devices/" {
		f.writes++
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{}`))
		return
	}
	var query struct {
		And []map[string]any `json:"$and"`
	}
	_ = json.Unmarshal([]byte(r.URL.Query().Get("query")), &query)
	out := []map[string]any{}
	if len(query.And) == 2 {
		for _, d := range f.devices {
			if d["_id"] == query.And[0]["_id"] && d["_tags"].([]any)[0] == query.And[1]["_tags"] {
				out = append(out, d)
			}
		}
	}
	_ = json.NewEncoder(w).Encode(out)
}

func templateDevice(id, tenant, model string) map[string]any {
	v := func(x any) map[string]any {
		return map[string]any{"_value": x, "_timestamp": time.Now().UTC().Format(time.RFC3339Nano)}
	}
	d := map[string]any{"_id": id, "_tags": []any{acs.TenantTag(tenant)}, "_lastInform": time.Now().UTC().Format(time.RFC3339Nano), "_deviceId": map[string]any{"_Manufacturer": "Fabricante Sintético", "_SerialNumber": id, "_ProductClass": "HG8245"}}
	info := map[string]any{"ModelName": v("HG8245H5"), "SoftwareVersion": v("V3R017"), "UpTime": v(100)}
	if model == "tr181" {
		d["Device"] = map[string]any{"DeviceInfo": info}
	} else {
		d["InternetGatewayDevice"] = map[string]any{"DeviceInfo": info, "LANDevice": map[string]any{"1": map[string]any{"WLANConfiguration": map[string]any{"1": map[string]any{"SSID": v("antigo")}}}}}
	}
	return d
}

type templateHarness struct {
	t      *testing.T
	router http.Handler
}

func (h templateHarness) call(token, method, path string, body any, want int) map[string]any {
	h.t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
	req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	if rec.Code != want {
		h.t.Fatalf("%s %s (%s): got %d want %d: %s", method, path, token, rec.Code, want, rec.Body.String())
	}
	out := map[string]any{}
	if strings.HasPrefix(strings.TrimSpace(rec.Body.String()), "{") {
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
	}
	out["_raw"] = rec.Body.String()
	return out
}

func templateTestDB(t *testing.T, flag string) *db.DB {
	t.Helper()
	dsn := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if dsn == "" {
		if os.Getenv(flag) == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; SQL não validado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, dsn, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var database, session string
	if err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(),session_user::text`).Scan(&database, &session)
	}); err != nil || database != "nexo_test" || session != "nexo_go" {
		t.Fatalf("requer nexo_test/nexo_go: %s %s %v", database, session, err)
	}
	return d
}

type templateTenant struct {
	id, popA, popB, admin, contract, unlinked, device, subscriber string
}

// Cria um provedor descartável com dois POPs, contrato PPPoE vinculado a um CPE
// e um segundo contrato sem CPE.
func newTemplateTenant(t *testing.T, d *db.DB, mark, device string) templateTenant {
	t.Helper()
	ctx := context.Background()
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	out := templateTenant{id: uuid.NewString(), device: device}
	if err := d.WithScope(ctx, op, func(tx *db.Tx) error {
		return tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste templates ACS',$2)`, out.id, "acs-tpl-"+strings.ReplaceAll(out.id, "-", ""))
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=$1`, out.id)
		}); e != nil {
			t.Error(e)
		}
	})
	secret, err := cryptox.EncryptSecret("senha-pppoe-secreta")
	if err != nil {
		t.Fatal(err)
	}
	err = d.WithScope(ctx, tenancy.Scope{TenantID: out.id}, func(tx *db.Tx) error {
		var plan, version, agent, nas string
		steps := []struct {
			sql  string
			args []any
			dest *string
		}{
			{`insert into pops(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"POP A " + mark}, &out.popA},
			{`insert into pops(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"POP B " + mark}, &out.popB},
			{`insert into users(tenant_id,email,name,password_hash,role) values(app_tenant(),$1,'Admin templates','!','admin') returning id::text`, []any{uuid.NewString() + "@example.invalid"}, &out.admin},
			{`insert into subscribers(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"Assinante Ação " + mark}, &out.subscriber},
			{`insert into plans(tenant_id,name) values(app_tenant(),$1) returning id::text`, []any{"Plano " + mark}, &plan},
			{`insert into plan_versions(tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values(app_tenant(),$1,1,10000,1000,1000,'tpl') returning id::text`, nil, &version},
		}
		for i := range steps {
			if steps[i].args == nil {
				steps[i].args = []any{plan}
			}
			if e := tx.QueryRow(ctx, steps[i].sql, steps[i].args...).Scan(steps[i].dest); e != nil {
				return e
			}
		}
		if e := tx.QueryRow(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day,pop_id,external_id,external_source) values(app_tenant(),$1,$2,10,$3,$4,'teste') returning id::text`, out.subscriber, version, out.popA, "CT-"+mark).Scan(&out.contract); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day,pop_id) values(app_tenant(),$1,$2,10,$3) returning id::text`, out.subscriber, version, out.popA).Scan(&out.unlinked); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `insert into agents(tenant_id,name,token_hash,version) values(app_tenant(),$1,$2,'0.6.0') returning id::text`, "Agente "+mark, uuid.NewString()).Scan(&agent); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `insert into devices(tenant_id,name,driver,agent_id) values(app_tenant(),$1,'demo',$2) returning id::text`, "NAS "+mark, agent).Scan(&nas); e != nil {
			return e
		}
		if e := tx.Exec(ctx, `insert into service_resources(tenant_id,contract_id,device_id,pppoe_username,secret_enc,desired_profile) values(app_tenant(),$1,$2,$3,$4,'tpl')`, out.contract, nas, "tpl-"+mark, secret); e != nil {
			return e
		}
		return tx.Exec(ctx, `insert into cpe_links(tenant_id,contract_id,acs_device_id) values(app_tenant(),$1,$2)`, out.contract, device)
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func templateRouter(t *testing.T, d *db.DB, actors map[string]*auth.Ctx, register func(huma.API, *endpoint.Registry, Service)) http.Handler {
	t.Helper()
	a, err := auth.New(ftthLoader{actors}, 0, false, 100, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	old := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	t.Cleanup(func() { huma.NewError = old })
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	cfg := huma.DefaultConfig("templates", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	register(humachi.New(router, cfg), registry, Service{DB: d})
	return router
}

func TestACSTemplatesPG(t *testing.T) {
	d := templateTestDB(t, "NEXO_ACS_TEMPLATES_PG_REQUIRED")
	ctx := context.Background()
	if os.Getenv("NEXO_SECRET_KEY") == "" {
		t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("t", 32))))
	}
	t.Setenv("NEXO_ACS_INSTANCE_ID", "synthetic-template-instance")
	t.Setenv("NEXO_GO_JOBS", "0")
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fake := &templateACS{}
	server := httptest.NewServer(fake)
	defer server.Close()
	t.Setenv("NEXO_ACS_URL", server.URL)
	a := newTemplateTenant(t, d, mark, "TPL-098-"+mark)
	b := newTemplateTenant(t, d, mark, "TPL-B-"+mark)
	fake.devices = []map[string]any{templateDevice(a.device, a.id, "tr098"), templateDevice(b.device, b.id, "tr098")}

	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user, sub string, pops []string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: user, TenantID: tenant, Role: role, SubscriberID: sub, PopIDs: pops, Permissions: auth.Permissions[role], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, SubscriberID: sub, PopIDs: pops}}
	}
	add("a", a.id, "admin", a.admin, "", nil)
	add("b", b.id, "admin", b.admin, "", nil)
	add("attendant", a.id, "attendant", a.admin, "", nil)
	add("finance", a.id, "finance", a.admin, "", nil)
	add("limited", a.id, "noc", a.admin, "", []string{a.popB})
	add("portal", a.id, "subscriber", a.admin, a.subscriber, nil)
	h := templateHarness{t, templateRouter(t, d, actors, func(api huma.API, r *endpoint.Registry, s Service) {
		registerACSTemplates(api, r, s)
		registerACSTasks(api, r, s)
	})}
	base := "/api/acs/templates"
	ssid := func(v string) acs.TemplateParam {
		return acs.TemplateParam{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", Value: v, Type: "xsd:string"}
	}

	// Validação de caminhos, tipos e variáveis.
	for name, params := range map[string][]acs.TemplateParam{
		"variável desconhecida": {ssid("{{senha_root}}")},
		"variável malformada":   {ssid("{{wifi_ssid")},
		"curinga no caminho":    {{Path: "InternetGatewayDevice.LANDevice.*.WLANConfiguration.1.SSID", Value: "x", Type: "xsd:string"}},
		"instância":             {{Path: "InternetGatewayDevice.LANDevice.1", Value: "x", Type: "xsd:string"}},
		"ManagementServer":      {{Path: "InternetGatewayDevice.ManagementServer.URL", Value: "http://acs.invalid", Type: "xsd:string"}},
		"modelos misturados":    {ssid("x"), {Path: "Device.WiFi.SSID.1.SSID", Value: "y", Type: "xsd:string"}},
		"senha literal":         {{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", Value: "senha-fixa-123", Type: "xsd:string"}},
		"senha concatenada":     {{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", Value: "x{{wifi_senha}}", Type: "xsd:string"}},
		"variável em booleano":  {{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable", Value: "{{wifi_ssid}}", Type: "xsd:boolean"}},
		"tipo desconhecido":     {{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable", Value: "1", Type: "xsd:hexBinary"}},
	} {
		res := h.call("a", "POST", base, map[string]any{"name": "Inválido " + name, "parameters": params}, 400)
		if !strings.Contains(res["_raw"].(string), "template ACS") {
			t.Fatal(name, res["_raw"])
		}
	}
	h.call("a", "POST", base, map[string]any{"name": "Vazio"}, 400)
	h.call("a", "POST", base, map[string]any{"name": "Inform curto", "inform_interval": 30}, 400)
	h.call("a", "POST", base, map[string]any{"name": "Campo extra", "inform_interval": 300, "senha": "x"}, 400)

	// Permissões: leitura de rede consulta, escrita exige network:write sem restrição de POP.
	specific := map[string]any{"name": "Específico " + mark, "manufacturer": "fabricante*", "model": "HG8245H?", "firmware": "V3R*", "inform_interval": 300, "parameters": []acs.TemplateParam{
		ssid("{{wifi_ssid}}"),
		{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", Value: "{{wifi_senha}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable", Value: "1", Type: "xsd:boolean"},
		{Path: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username", Value: "{{pppoe_usuario}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password", Value: "{{pppoe_senha}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.DeviceInfo.ProvisioningCode", Value: "{{contrato_codigo}}|{{assinante_nome}}", Type: "xsd:string"},
	}}
	h.call("finance", "POST", base, specific, 403)
	h.call("portal", "GET", base, nil, 403)
	h.call("attendant", "POST", base, specific, 403)
	h.call("limited", "POST", base, specific, 403)
	t1 := h.call("a", "POST", base, specific, 200)
	if t1["data_model"] != "tr098" || t1["revision"] != float64(1) || len(t1["variables"].([]any)) != 6 {
		t.Fatal(t1["_raw"])
	}
	if params := t1["parameters"].([]any); params[2].(map[string]any)["value"] != "true" {
		t.Fatal("booleano não normalizado", params[2])
	}
	h.call("a", "POST", base, map[string]any{"name": strings.ToUpper("Específico " + mark), "inform_interval": 300}, 409)
	generic := h.call("a", "POST", base, map[string]any{"name": "Genérico " + mark, "parameters": []acs.TemplateParam{{Path: "InternetGatewayDevice.DeviceInfo.ProvisioningCode", Value: "{{contrato_codigo}}", Type: "xsd:string"}}}, 200)
	tr181 := h.call("a", "POST", base, map[string]any{"name": "TR-181 " + mark, "parameters": []acs.TemplateParam{{Path: "Device.WiFi.SSID.1.SSID", Value: "{{wifi_ssid}}", Type: "xsd:string"}}}, 200)
	other := h.call("a", "POST", base, map[string]any{"name": "Outro fabricante " + mark, "manufacturer": "Outro*", "inform_interval": 600}, 200)
	id1, idGeneric, id181, idOther := t1["id"].(string), generic["id"].(string), tr181["id"].(string), other["id"].(string)
	list := h.call("limited", "GET", base+"?status=active&q="+url.QueryEscape(mark), nil, 200)
	if list["total"] != float64(4) {
		t.Fatal(list["_raw"])
	}
	h.call("limited", "PATCH", base+"/"+id1, map[string]any{"name": "x"}, 403)
	h.call("a", "GET", base+"?limit=1", nil, 400)

	// Isolamento entre provedores.
	h.call("b", "GET", base+"/"+id1, nil, 404)
	h.call("b", "PATCH", base+"/"+id1, map[string]any{"active": false}, 404)
	h.call("b", "DELETE", base+"/"+id1, nil, 404)
	if res := h.call("b", "GET", base+"?q="+url.QueryEscape(mark), nil, 200); res["total"] != float64(0) {
		t.Fatal("vazamento entre provedores", res["_raw"])
	}
	h.call("b", "GET", "/api/contracts/"+a.contract+"/cpe/templates", nil, 404)
	h.call("b", "POST", "/api/contracts/"+a.contract+"/cpe/template/preview", map[string]any{"template_id": id1}, 404)

	// Sugestão: o mais específico que casa com fabricante/modelo/firmware e modelo de dados.
	suggest := h.call("a", "GET", "/api/contracts/"+a.contract+"/cpe/templates", nil, 200)
	if suggest["suggested_id"] != id1 || suggest["linked"] != true {
		t.Fatal(suggest["_raw"])
	}
	ids := []string{}
	for _, item := range suggest["templates"].([]any) {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	if strings.Join(ids, ",") != id1+","+idGeneric {
		t.Fatal("casamento por modelo", ids, suggest["_raw"])
	}
	if res := h.call("a", "GET", "/api/contracts/"+a.unlinked+"/cpe/templates", nil, 200); res["linked"] != false || res["suggested_id"] != nil {
		t.Fatal(res["_raw"])
	}
	h.call("limited", "GET", "/api/contracts/"+a.contract+"/cpe/templates", nil, 404)

	// Pré-visualização: valores resolvidos, senhas mascaradas.
	preview := h.call("a", "POST", "/api/contracts/"+a.contract+"/cpe/template/preview", map[string]any{"template_id": id1, "wifi_ssid": "Rede Teste", "wifi_senha": "wifi-segredo-9"}, 200)
	raw := preview["_raw"].(string)
	if strings.Contains(raw, "senha-pppoe-secreta") || strings.Contains(raw, "wifi-segredo-9") || !strings.Contains(raw, acs.MaskedValue) || !strings.Contains(raw, "tpl-"+mark) || !strings.Contains(raw, "CT-"+mark+"|Assinante Ação "+mark) || preview["ready"] != true || preview["matches"] != true {
		t.Fatal("pré-visualização", raw)
	}
	if !strings.Contains(raw, "InternetGatewayDevice.ManagementServer.PeriodicInformInterval") {
		t.Fatal("inform periódico ausente", raw)
	}
	partial := h.call("attendant", "POST", "/api/contracts/"+a.contract+"/cpe/template/preview", map[string]any{"template_id": id1}, 200)
	if partial["ready"] != false || len(partial["missing"].([]any)) != 2 {
		t.Fatal(partial["_raw"])
	}
	if res := h.call("a", "POST", "/api/contracts/"+a.unlinked+"/cpe/template/preview", map[string]any{"template_id": idGeneric}, 200); res["linked"] != false || res["device"] != nil || res["ready"] != false {
		t.Fatal(res["_raw"])
	}
	h.call("finance", "POST", "/api/contracts/"+a.contract+"/cpe/template/preview", map[string]any{"template_id": id1}, 403)
	h.call("a", "POST", "/api/contracts/"+a.contract+"/cpe/template/preview", map[string]any{"template_id": id1, "wifi_senha": "curta"}, 400)

	// Aplicação: casamento, modelo de dados, variáveis e situação conferidos antes da intenção.
	apply := "/api/contracts/" + a.contract + "/cpe/template"
	wifi := map[string]any{"wifi_ssid": "Rede Teste", "wifi_senha": "wifi-segredo-9"}
	body := func(template, intent string, extra map[string]any) map[string]any {
		out := map[string]any{"template_id": template, "intent_id": intent}
		for k, v := range extra {
			out[k] = v
		}
		return out
	}
	h.call("a", "POST", apply, body(idOther, uuid.NewString(), nil), 409)
	h.call("a", "POST", apply, body(id181, uuid.NewString(), wifi), 409)
	h.call("a", "POST", apply, body(id1, uuid.NewString(), nil), 400)
	h.call("a", "PATCH", base+"/"+idGeneric, map[string]any{"active": false}, 200)
	h.call("a", "POST", apply, body(idGeneric, uuid.NewString(), nil), 409)
	h.call("a", "PATCH", base+"/"+idGeneric, map[string]any{"active": true}, 200)
	h.call("finance", "POST", apply, body(id1, uuid.NewString(), wifi), 403)
	h.call("limited", "POST", apply, body(id1, uuid.NewString(), wifi), 404)
	h.call("a", "POST", "/api/contracts/"+a.unlinked+"/cpe/template", body(idGeneric, uuid.NewString(), nil), 404)
	intent := uuid.NewString()
	first := h.call("attendant", "POST", apply, body(id1, intent, wifi), 200)
	if first["result"] != "prepared" || first["task_id"] == nil || strings.Contains(first["_raw"].(string), "segredo") {
		t.Fatal(first["_raw"])
	}
	again := h.call("attendant", "POST", apply, body(id1, intent, wifi), 200)
	if again["task_id"] != first["task_id"] || again["replayed"] != true {
		t.Fatal("repetição criou outra intenção", again["_raw"])
	}
	h.call("attendant", "POST", apply, body(id1, intent, map[string]any{"wifi_ssid": "Outra rede", "wifi_senha": "wifi-segredo-9"}), 409)
	h.call("attendant", "POST", apply, body(id1, uuid.NewString(), wifi), 409)
	h.call("a", "PATCH", base+"/"+id1, map[string]any{"inform_interval": 900}, 200)
	if replay := h.call("attendant", "POST", apply, body(id1, intent, wifi), 200); replay["task_id"] != first["task_id"] {
		t.Fatal("repetição após edição do template", replay["_raw"])
	}
	tasks := h.call("a", "GET", "/api/contracts/"+a.contract+"/cpe/tasks", nil, 200)["_raw"].(string)
	if !strings.Contains(tasks, `"kind":"template"`) || strings.Contains(tasks, "segredo") {
		t.Fatal(tasks)
	}
	if fake.writes != 0 {
		t.Fatal("rota de template chamou o ACS fora do diário", fake.writes)
	}
	err := d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, func(tx *db.Tx) error {
		var count, audits int
		var detail string
		if e := tx.QueryRow(ctx, `select count(*) from acs_task_intents where contract_id=$1 and kind='template'`, a.contract).Scan(&count); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*),coalesce(max(detail::text),'') from audit_events where action='cpe.template.prepared' and entity_id=$1::text`, a.contract).Scan(&audits, &detail); e != nil {
			return e
		}
		if count != 1 || audits != 1 || strings.Contains(detail, "segredo") || strings.Contains(detail, "senha-pppoe") || !strings.Contains(detail, id1) {
			t.Fatalf("intenções %d auditorias %d %s", count, audits, detail)
		}
		var encoded string
		if e := tx.QueryRow(ctx, `select acs_task_payload($1)`, first["task_id"]).Scan(&encoded); e != nil {
			return e
		}
		if strings.Contains(encoded, "segredo") {
			t.Fatal("envelope em claro")
		}
		plain, e := cryptox.DecryptSecret(encoded)
		if e != nil {
			return e
		}
		var envelope struct {
			Request acs.TaskRequest
			Payload struct {
				Name   string  `json:"name"`
				Values [][]any `json:"parameterValues"`
			}
		}
		if e = json.Unmarshal([]byte(plain), &envelope); e != nil {
			return e
		}
		values := map[string]any{}
		for _, v := range envelope.Payload.Values {
			values[v[0].(string)] = v[1]
		}
		if envelope.Payload.Name != "setParameterValues" || envelope.Request.TemplateRevision != 1 || values["InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password"] != "senha-pppoe-secreta" || values["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable"] != true || values["InternetGatewayDevice.ManagementServer.PeriodicInformInterval"] != float64(300) || values["InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID"] != "Rede Teste" {
			t.Fatalf("envelope %+v", envelope)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Exclusão auditada; contrato do outro provedor continua intocado.
	h.call("attendant", "DELETE", base+"/"+idOther, nil, 403)
	h.call("a", "DELETE", base+"/"+idOther, nil, 200)
	h.call("a", "GET", base+"/"+idOther, nil, 404)
	h.call("b", "GET", "/api/contracts/"+b.contract+"/cpe/templates", nil, 200)
	if err = d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, func(tx *db.Tx) error {
		var n int
		if e := tx.QueryRow(ctx, `select count(*) from audit_events where action in ('acs.template_created','acs.template_updated','acs.template_deleted') and entity_id=any($1::text[])`, []string{id1, idGeneric, id181, idOther}).Scan(&n); e != nil {
			return e
		}
		if n != 8 {
			t.Fatalf("auditoria de templates: %d", n)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
