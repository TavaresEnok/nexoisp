package escrita

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
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

// Viabilidade pública contra PostgreSQL real: raio, porta livre, CTO x CEO,
// isolamento entre provedores, desativação sem enumeração, limite por IP e
// prospecto no CRM.
func TestViabilityPublicPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_VIABILITY_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; SQL não validado")
	}
	t.Setenv("NEXO_TRUST_PROXY", "")
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
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
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	// a: provedor principal; b: outro provedor com caixa livre no ponto testado;
	// c: sem módulo FTTH; s: suspenso com consulta ativa.
	tenants := map[string]string{"a": lateTenantID(), "b": lateTenantID(), "c": lateTenantID(), "s": lateTenantID()}
	slugs := map[string]string{}
	for key, id := range tenants {
		slugs[key] = "viab-" + key + "-" + suffix
		modules := []string{"ftth", "crm"}
		if key == "c" {
			modules = []string{"crm"}
		}
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `insert into tenants(id,name,slug,modules) values($1,$2,$3,$4)`, id, "Provedor viabilidade "+key, slugs[key], modules)
		}); e != nil {
			t.Fatal(e)
		}
	}
	t.Cleanup(func() {
		ids := []string{}
		for _, id := range tenants {
			ids = append(ids, id)
		}
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=any($1::uuid[])`, ids)
		}); e != nil {
			t.Error(e)
		}
	})
	in := func(key string, fn func(tx *db.Tx) error) {
		t.Helper()
		if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[key]}, fn); e != nil {
			t.Fatal(e)
		}
	}
	box := func(key, name, kind string, ports int, lat, lng any, used int) {
		t.Helper()
		in(key, func(tx *db.Tx) error {
			var id string
			if e := tx.QueryRow(ctx, `insert into ftth_boxes(tenant_id,name,kind,ports,latitude,longitude) values($1,$2,$3,$4,$5,$6) returning id`, tenants[key], name, kind, ports, lat, lng).Scan(&id); e != nil {
				return e
			}
			for port := 1; port <= used; port++ {
				if e := tx.Exec(ctx, `insert into ftth_drops(tenant_id,box_id,port,note) values($1,$2,$3,'ocupada no teste')`, tenants[key], id, port); e != nil {
					return e
				}
			}
			return nil
		})
	}
	// Ponto de referência P = (-3.740000, -38.530000). 0,001° de latitude ≈ 111 m.
	box("a", "CTO cheia", "cto", 2, -3.7200, -38.5300, 2)          // cheia: nunca atende
	box("a", "CTO livre", "cto", 8, -3.7409, -38.5300, 3)          // ~100 m de P
	box("a", "CEO emenda", "ceo", 12, -3.7600, -38.5300, 0)        // emenda: não atende
	box("a", "CTO sem coordenada", "cto", 8, nil, nil, 0)          // sem posição: ignorada
	box("a", "CTO cheia no ponto", "cto", 1, -3.7600, -38.5400, 1) // cheia exatamente em Q
	box("b", "CTO do outro provedor", "cto", 8, -3.7800, -38.5300, 0)
	box("c", "CTO sem módulo", "cto", 8, -3.7400, -38.5300, 0)
	box("s", "CTO suspenso", "cto", 8, -3.7400, -38.5300, 0)

	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, sub string, pops []string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: uuid.NewString(), TenantID: tenant, Role: role, SubscriberID: sub, PopIDs: pops, Permissions: auth.Permissions[role], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, SubscriberID: sub, PopIDs: pops}}
	}
	for key, id := range tenants {
		add("admin-"+key, id, "admin", "", nil)
	}
	add("attendant", tenants["a"], "attendant", "", nil)
	add("portal", tenants["a"], "subscriber", uuid.NewString(), nil)
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
	cfg := huma.DefaultConfig("viabilidade", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	registerViability(humachi.New(router, cfg), registry, Service{DB: d})

	ipSeq := 0
	newIP := func() string {
		ipSeq++
		return "[2001:db8:" + suffix[:4] + ":" + suffix[4:8] + "::" + itoa(ipSeq) + "]:5555"
	}
	ip := newIP()
	do := func(token, address, method, path string, body any, want int) *httptest.ResponseRecorder {
		t.Helper()
		var reader *bytes.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			reader = bytes.NewReader(raw)
		} else {
			reader = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, reader)
		req.RemoteAddr = address
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
			req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	// Cada chamada pública usa um endereço novo; o limite é testado à parte.
	call := func(token, method, path string, body any, want int) *httptest.ResponseRecorder {
		t.Helper()
		if token == "" {
			return do(token, newIP(), method, path, body, want)
		}
		return do(token, ip, method, path, body, want)
	}
	settings := func(token string, enabled bool, radius int, lead bool, want int) {
		t.Helper()
		call(token, "PUT", "/api/settings/viability", map[string]any{"enabled": enabled, "radius_m": radius, "message": "Consulte a cobertura na sua rua.", "phone": "(85) 4000-0000", "whatsapp": "+55 (85) 99999-0000", "create_lead": lead}, want)
	}
	page := func(key string) string { return "/public/viabilidade/" + slugs[key] }
	P := map[string]any{"latitude": -3.74, "longitude": -38.53, "address": "Rua Sintética, 100"}
	far := map[string]any{"latitude": -3.7436, "longitude": -38.53}    // ~300 m da CTO livre
	full := map[string]any{"latitude": -3.72, "longitude": -38.53}     // em cima da CTO cheia
	splice := map[string]any{"latitude": -3.76, "longitude": -38.53}   // em cima da CEO
	fullHere := map[string]any{"latitude": -3.76, "longitude": -38.54} // CTO de 1 porta ocupada
	otherTenant := map[string]any{"latitude": -3.78, "longitude": -38.53}
	covered := func(key string, point map[string]any) bool {
		t.Helper()
		rec := call("", "POST", page(key)+"/consulta", point, 200)
		var out map[string]any
		if e := json.Unmarshal(rec.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		for k := range out {
			if k != "covered" && k != "lead_capture" && k != "phone" && k != "whatsapp" {
				t.Fatalf("resposta expõe %q: %s", k, rec.Body.String())
			}
		}
		return out["covered"] == true
	}

	// Antes de ativar: indisponível, igual a provedor inexistente.
	unknown := call("", "GET", "/public/viabilidade/inexistente-"+suffix, nil, 404).Body.String()
	if got := call("", "GET", page("a"), nil, 404).Body.String(); got != unknown {
		t.Fatalf("desativado difere de inexistente: %s / %s", got, unknown)
	}
	if got := call("", "GET", "/public/viabilidade/Maiusculo_Invalido", nil, 404).Body.String(); got != unknown {
		t.Fatalf("identificador inválido difere: %s", got)
	}
	if got := call("", "POST", "/public/viabilidade/inexistente-"+suffix+"/consulta", P, 404).Body.String(); got != unknown {
		t.Fatalf("consulta inexistente difere: %s", got)
	}
	if got := call("", "POST", page("a")+"/consulta", P, 404).Body.String(); got != unknown {
		t.Fatalf("consulta desativada difere: %s", got)
	}

	// Configuração: autorização, validação estrita e padrão de 250 m.
	rec := call("admin-a", "GET", "/api/settings/viability", nil, 200)
	if !strings.Contains(rec.Body.String(), `"radius_m":250`) || !strings.Contains(rec.Body.String(), `"enabled":false`) || !strings.Contains(rec.Body.String(), `"public_path":"/viabilidade/`+slugs["a"]+`"`) {
		t.Fatal(rec.Body.String())
	}
	call("attendant", "GET", "/api/settings/viability", nil, 403)
	call("attendant", "PUT", "/api/settings/viability", map[string]any{}, 403)
	call("portal", "GET", "/api/settings/viability", nil, 403)
	call("admin-a", "PUT", "/api/settings/viability", map[string]any{"enabled": true, "radius_m": 10, "message": nil, "phone": nil, "whatsapp": nil, "create_lead": false}, 400)
	call("admin-a", "PUT", "/api/settings/viability", map[string]any{"enabled": true, "radius_m": 250.5, "message": nil, "phone": nil, "whatsapp": nil, "create_lead": false}, 400)
	call("admin-a", "PUT", "/api/settings/viability", map[string]any{"enabled": true, "radius_m": 250, "message": nil, "phone": nil, "whatsapp": nil}, 400)
	call("admin-a", "PUT", "/api/settings/viability", map[string]any{"enabled": true, "radius_m": 250, "message": nil, "phone": nil, "whatsapp": nil, "create_lead": false, "extra": 1}, 400)
	call("admin-a", "PUT", "/api/settings/viability", map[string]any{"enabled": true, "radius_m": 250, "message": nil, "phone": nil, "whatsapp": "abc", "create_lead": false}, 400)
	settings("admin-a", true, 250, true, 200)
	settings("admin-b", true, 250, true, 200)
	settings("admin-c", true, 250, true, 200)
	settings("admin-s", true, 250, true, 200)
	rec = call("admin-a", "GET", "/api/settings/viability", nil, 200)
	if !strings.Contains(rec.Body.String(), `"whatsapp":"5585999990000"`) || !strings.Contains(rec.Body.String(), `"create_lead":true`) {
		t.Fatal(rec.Body.String())
	}
	if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update tenants set status='suspended' where id=$1`, tenants["s"])
	}); e != nil {
		t.Fatal(e)
	}

	// Página pública: marca e contato, sem dados internos.
	rec = call("", "GET", page("a"), nil, 200)
	body := rec.Body.String()
	for _, forbidden := range []string{tenants["a"], "radius", "CTO", "latitude", "ports"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("página pública expõe %q: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"name":"Provedor viabilidade a"`) || !strings.Contains(body, `"lead_capture":true`) || !strings.Contains(body, `"logo":null`) {
		t.Fatal(body)
	}
	for _, key := range []string{"c", "s"} {
		if got := call("", "GET", page(key), nil, 404).Body.String(); got != unknown {
			t.Fatalf("provedor %s enumerável: %s", key, got)
		}
		if got := call("", "POST", page(key)+"/consulta", P, 404).Body.String(); got != unknown {
			t.Fatalf("consulta %s enumerável: %s", key, got)
		}
	}

	// Raio, porta livre, tipo de caixa e isolamento entre provedores.
	if !covered("a", P) {
		t.Fatal("CTO com porta livre a ~100 m não atende")
	}
	if covered("a", far) || covered("a", full) || covered("a", splice) || covered("a", fullHere) {
		t.Fatal("ponto fora do raio, CTO cheia ou CEO marcados como atendidos")
	}
	if covered("a", otherTenant) {
		t.Fatal("caixa de outro provedor atende o provedor a")
	}
	if !covered("b", otherTenant) || covered("b", P) {
		t.Fatal("provedor b sem isolamento")
	}
	settings("admin-a", true, 500, true, 200)
	if !covered("a", far) {
		t.Fatal("raio configurado de 500 m ignorado")
	}
	settings("admin-a", true, 250, true, 200)
	if covered("a", far) {
		t.Fatal("raio de volta a 250 m ignorado")
	}

	// Validação estrita do corpo público (antes de resolver o provedor).
	call("", "POST", page("a")+"/consulta", map[string]any{"latitude": 91, "longitude": -38.53}, 400)
	call("", "POST", page("a")+"/consulta", map[string]any{"latitude": "-3.74", "longitude": -38.53}, 400)
	call("", "POST", page("a")+"/consulta", map[string]any{"latitude": -3.74}, 400)
	call("", "POST", page("a")+"/consulta", map[string]any{"latitude": -3.74, "longitude": -38.53, "radius_m": 5000}, 400)
	call("", "POST", "/public/viabilidade/inexistente-"+suffix+"/consulta", map[string]any{"latitude": 91, "longitude": 0}, 400)
	req := httptest.NewRequest("POST", page("a")+"/consulta", strings.NewReader(`{"latitude":-3.74,"longitude":-38.53}`))
	req.RemoteAddr = newIP()
	req.Header.Set("Content-Type", "text/plain")
	raw := httptest.NewRecorder()
	router.ServeHTTP(raw, req)
	if raw.Code != 415 {
		t.Fatalf("content-type não JSON aceito: %d", raw.Code)
	}

	// Prospecto: só com resultado positivo, consentimento e captura ativa.
	leadAt := func(address, key string, point map[string]any, extra map[string]any, want int) {
		t.Helper()
		b := map[string]any{"name": "Interessado sintético", "phone": "(85) 98888-7777", "consent": true}
		for k, v := range point {
			b[k] = v
		}
		for k, v := range extra {
			b[k] = v
		}
		do("", address, "POST", page(key)+"/interesse", b, want)
	}
	lead := func(key string, point map[string]any, extra map[string]any, want int) {
		t.Helper()
		leadAt(newIP(), key, point, extra, want)
	}
	countLeads := func(key string) (n int, phone, source, street string, creator any) {
		t.Helper()
		in(key, func(tx *db.Tx) error {
			if e := tx.QueryRow(ctx, `select count(*)::int from leads where source='viabilidade'`).Scan(&n); e != nil {
				return e
			}
			if n > 0 {
				return tx.QueryRow(ctx, `select phone, source, coalesce(address_street,''), created_by from leads where source='viabilidade' order by created_at desc limit 1`).Scan(&phone, &source, &street, &creator)
			}
			return nil
		})
		return
	}
	lead("a", far, nil, 409)
	lead("a", P, map[string]any{"consent": false}, 400)
	lead("a", P, map[string]any{"phone": "123"}, 400)
	lead("a", P, map[string]any{"name": "x"}, 400)
	if n, _, _, _, _ := countLeads("a"); n != 0 {
		t.Fatal("prospecto criado sem resultado positivo ou consentimento")
	}
	lead("a", P, nil, 200)
	n, phone, source, street, creator := countLeads("a")
	if n != 1 || phone != "85988887777" || source != "viabilidade" || street != "Rua Sintética, 100" || creator != nil {
		t.Fatalf("prospecto incorreto: %d %s %s %s %v", n, phone, source, street, creator)
	}
	in("a", func(tx *db.Tx) error {
		var events, audits int
		if e := tx.QueryRow(ctx, `select count(*)::int from lead_events e join leads l on l.id=e.lead_id where l.source='viabilidade' and e.event='created' and e.actor_id is null`).Scan(&events); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `select count(*)::int from audit_events where tenant_id=$1 and action='lead.create' and actor_type='system' and actor_id='viabilidade-publica'`, tenants["a"]).Scan(&audits); e != nil {
			return e
		}
		if events != 1 || audits != 1 {
			t.Fatalf("histórico/auditoria do prospecto: %d %d", events, audits)
		}
		return nil
	})
	if n, _, _, _, _ := countLeads("b"); n != 0 {
		t.Fatal("prospecto vazou para outro provedor")
	}
	settings("admin-a", true, 250, false, 200)
	if strings.Contains(call("", "GET", page("a"), nil, 200).Body.String(), `"lead_capture":true`) {
		t.Fatal("captura desativada continua anunciada")
	}
	lead("a", P, map[string]any{"phone": "(85) 97777-6666"}, 409)
	settings("admin-a", true, 250, true, 200)
	lead("a", P, nil, 200) // mesmo telefone no mesmo dia: não duplica
	if n, _, _, _, _ := countLeads("a"); n != 1 {
		t.Fatalf("prospecto duplicado: %d", n)
	}
	// Sem o módulo CRM o provedor não anuncia captura.
	if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update tenants set modules=array['ftth'] where id=$1`, tenants["b"])
	}); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(call("", "GET", page("b"), nil, 200).Body.String(), `"lead_capture":false`) {
		t.Fatal("captura sem módulo CRM")
	}

	// Logotipo da marca existente, servido só com a consulta ativa.
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	var logo bytes.Buffer
	if e := png.Encode(&logo, img); e != nil {
		t.Fatal(e)
	}
	in("a", func(tx *db.Tx) error {
		return tx.Exec(ctx, `insert into tenant_branding(tenant_id,display_name,logo_png,logo_sha256,logo_width,logo_height) values($1,'Marca Sintética',$2,$3,2,2)`, tenants["a"], logo.Bytes(), strings.Repeat("a", 64))
	})
	body = call("", "GET", page("a"), nil, 200).Body.String()
	if !strings.Contains(body, `"name":"Marca Sintética"`) || !strings.Contains(body, strings.Repeat("a", 64)) {
		t.Fatal(body)
	}
	rec = call("", "GET", page("a")+"/logo", nil, 200)
	if rec.Header().Get("Content-Type") != "image/png" || !bytes.Equal(rec.Body.Bytes(), logo.Bytes()) {
		t.Fatal("logotipo incorreto")
	}
	if got := call("", "GET", page("b")+"/logo", nil, 404).Body.String(); got != unknown {
		t.Fatalf("logo ausente difere: %s", got)
	}

	// Desativar devolve exatamente a resposta de provedor inexistente.
	settings("admin-a", false, 250, true, 200)
	for _, path := range []string{page("a"), page("a") + "/logo"} {
		if got := call("", "GET", path, nil, 404).Body.String(); got != unknown {
			t.Fatalf("%s desativado enumerável: %s", path, got)
		}
	}
	if got := call("", "POST", page("a")+"/consulta", P, 404).Body.String(); got != unknown {
		t.Fatalf("consulta desativada enumerável: %s", got)
	}
	settings("admin-a", true, 250, true, 200)

	// Limite por IP: igual para provedor existente e inexistente; outro IP segue livre.
	limited := newIP()
	for i := 0; i < viabilityLimits["check"].limit; i++ {
		path := page("a") + "/consulta"
		want := 200
		if i%2 == 1 {
			path = "/public/viabilidade/inexistente-" + suffix + "/consulta"
			want = 404
		}
		do("", limited, "POST", path, P, want)
	}
	for _, path := range []string{page("a") + "/consulta", "/public/viabilidade/inexistente-" + suffix + "/consulta"} {
		rec = do("", limited, "POST", path, P, 429)
		if rec.Header().Get("Retry-After") == "" || !strings.Contains(rec.Body.String(), "rate_limited") {
			t.Fatalf("429 sem Retry-After: %v %s", rec.Header(), rec.Body.String())
		}
	}
	do("", newIP(), "POST", page("a")+"/consulta", P, 200)
	burst := newIP()
	for i := 0; i < viabilityLimits["interest"].limit; i++ {
		leadAt(burst, "a", P, nil, 200)
	}
	leadAt(burst, "a", P, nil, 429)
	if n, _, _, _, _ := countLeads("a"); n != 1 {
		t.Fatalf("limite de interesse criou prospectos: %d", n)
	}
}

// lateTenantID nunca é o menor tenant do diretório, que outros testes PostgreSQL
// escolhem como provedor de referência com dados de demonstração.
func lateTenantID() string { return "f" + uuid.NewString()[1:] }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}
