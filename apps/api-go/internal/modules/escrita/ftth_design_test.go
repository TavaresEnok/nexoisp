package escrita

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
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
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"
)

func TestParseKMLRecusaEntidadesEKMZ(t *testing.T) {
	for name, doc := range map[string]string{
		"xxe":        `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&xxe;</name></Placemark></kml>`,
		"laughs":     `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><kml><Placemark><name>&lol2;</name></Placemark></kml>`,
		"entidade":   `<kml><Placemark><name>&desconhecida;</name></Placemark></kml>`,
		"kmz":        "PK\x03\x04conteudo",
		"malformado": `<kml><Placemark><name>x</Placemark></kml>`,
		"raiz":       `<gpx><wpt/></gpx>`,
		"vazio":      ``,
		"latin1":     `<?xml version="1.0" encoding="ISO-8859-1"?><kml></kml>`,
		"aninhado":   `<kml><Placemark><Placemark/></Placemark></kml>`,
		"duas":       `<kml></kml><kml></kml>`,
	} {
		if _, err := parseKML([]byte(doc)); err == nil {
			t.Fatalf("%s: KML aceito", name)
		}
	}
	marks, err := parseKML([]byte("\xef\xbb\xbf" + `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name> P </name><Point><coordinates>-38,-3</coordinates></Point></Placemark><Placemark><name>M</name><MultiGeometry><Point><coordinates>1,1</coordinates></Point><LineString><coordinates>1,1 2,2</coordinates></LineString></MultiGeometry></Placemark><Placemark><name><![CDATA[L & C]]></name><LineString><coordinates>1,1,0 2,2,0</coordinates></LineString></Placemark></Document></kml>`))
	if err != nil || len(marks) != 3 || marks[0].geometry != "point" || marks[0].name != "P" || marks[1].geometry != "other" || marks[2].geometry != "line" || marks[2].name != "L & C" {
		t.Fatalf("%v %+v", err, marks)
	}
	if l := pathLength([]ftthPoint{{0, 0}, {0.001, 0}}); math.Abs(l-111.2) > 0.001 {
		t.Fatalf("haversine: %v", l)
	}
}

func TestFTTHDesignPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_FTTH_DESIGN_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; projeto físico FTTH não validado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	var database, session string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(),session_user::text`).Scan(&database, &session)
	})
	if err != nil || database != "nexo_test" || session != "nexo_go" {
		t.Fatalf("requer nexo_test/nexo_go: %s %s %v", database, session, err)
	}
	// Usa os provedores semeados: criar provedores com id aleatório alteraria a
	// ordem de nexo_go_directory(), da qual outros testes escolhem o primeiro.
	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	var tenants []string
	err = d.WithScope(ctx, op, func(tx *db.Tx) error {
		rows, e := tx.Objects(ctx, `select id::text from tenants where slug=any('{alfa,beta}') order by slug`)
		for _, r := range rows {
			tenants = append(tenants, r.Get("id").(string))
		}
		return e
	})
	if err != nil || len(tenants) != 2 {
		t.Fatalf("requer provedores semeados alfa e beta: %v %v", tenants, err)
	}
	tag := uuid.NewString()[:8]
	pops := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	exec := func(tenant, sql string, args ...any) string {
		t.Helper()
		var id string
		if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, sql, args...).Scan(&id)
		}); e != nil {
			t.Fatal(e)
		}
		return id
	}
	for i, id := range pops {
		tenant := tenants[0]
		if i == 2 {
			tenant = tenants[1]
		}
		exec(tenant, `insert into pops(id,tenant_id,name) values($1,$2,$3) returning id::text`, id, tenant, "POP "+id)
	}
	box := exec(tenants[0], `insert into ftth_boxes(tenant_id,name,kind,ports) values($1,$2,'cto',8) returning id::text`, tenants[0], "CTO projeto "+tag)
	foreignBox := exec(tenants[1], `insert into ftth_boxes(tenant_id,name,kind,ports) values($1,$2,'cto',8) returning id::text`, tenants[1], "CTO alheia "+tag)
	site := exec(tenants[0], `insert into network_sites(tenant_id,pop_id,kind,name) values($1,$2,'pole','Poste A') returning id::text`, tenants[0], pops[0])
	otherSite := exec(tenants[0], `insert into network_sites(tenant_id,pop_id,kind,name) values($1,$2,'pole','Poste B') returning id::text`, tenants[0], pops[1])
	count := func(table string) int {
		t.Helper()
		n := 0
		if e := d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select count(*)::int from `+table).Scan(&n)
		}); e != nil {
			t.Fatal(e)
		}
		return n
	}

	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, sub string, ps []string, modules ...string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: uuid.NewString(), TenantID: tenant, Role: role, SubscriberID: sub, PopIDs: ps, Permissions: auth.Permissions[role], Modules: modules, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, SubscriberID: sub, PopIDs: ps}}
	}
	add("a", tenants[0], "admin", "", nil, "ftth")
	add("b", tenants[1], "admin", "", nil, "ftth")
	add("limited", tenants[0], "noc", "", pops[:1], "ftth")
	add("read", tenants[0], "attendant", "", nil, "ftth")
	add("portal", tenants[0], "subscriber", uuid.NewString(), nil, "ftth")
	add("nomod", tenants[0], "admin", "", nil)
	a, err := auth.New(ftthLoader{actors}, 0, false, 10000, prometheus.NewRegistry()) // o cenário faz centenas de chamadas pela mesma sessão
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
	cfg := huma.DefaultConfig("ftth", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	Register(humachi.New(router, cfg), registry, Service{DB: d})
	raw := func(token, method, path string, body any) *httptest.ResponseRecorder {
		var reader *bytes.Reader
		if s, ok := body.(string); ok {
			reader = bytes.NewReader([]byte(s))
		} else {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
		req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	call := func(token, method, path string, body any, want int) map[string]any {
		t.Helper()
		rec := raw(token, method, path, body)
		if rec.Code != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
		out := map[string]any{}
		if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			_ = json.Unmarshal(rec.Body.Bytes(), &out)
		}
		return out
	}
	with := func(base map[string]any, changes ...any) map[string]any {
		out := map[string]any{}
		for k, v := range base {
			out[k] = v
		}
		for i := 0; i < len(changes); i += 2 {
			if changes[i+1] == "<remove>" {
				delete(out, changes[i].(string))
			} else {
				out[changes[i].(string)] = changes[i+1]
			}
		}
		return out
	}
	items := func(v map[string]any) []any { return v["items"].([]any) }

	// Cabos: cadastro, cálculo do comprimento e validação estrita.
	base := "/api/ftth/cables"
	line := []map[string]any{{"lat": -3.0, "lng": -38.0}, {"lat": -3.001, "lng": -38.0}}
	body := map[string]any{"pop_id": pops[0], "name": " Cabo tronco ", "kind": "aerial", "fiber_count": 12, "a_box_id": box, "b_site_id": site, "path": line, "notes": "projeto"}
	cable := call("a", "POST", base, body, 200)
	cid := cable["id"].(string)
	if cable["name"] != "Cabo tronco" || cable["a_box_name"] != "CTO projeto "+tag || cable["b_site_name"] != "Poste A" || math.Abs(cable["computed_length_m"].(float64)-111.2) > 0.001 || cable["declared_length_m"] != nil || len(cable["path"].([]any)) != 2 {
		t.Fatalf("cabo: %v", cable)
	}
	many := make([]map[string]any, 501)
	for i := range many {
		many[i] = map[string]any{"lat": -3 - float64(i)/10000, "lng": -38.0}
	}
	for _, invalid := range []map[string]any{
		with(body, "extra", 1),
		with(body, "fiber_count", 0),
		with(body, "fiber_count", 289),
		with(body, "fiber_count", 1.5),
		with(body, "kind", "aereo"),
		with(body, "name", "x"),
		with(body, "name", "<remove>"),
		with(body, "path", "<remove>"),
		with(body, "path", line[:1]),
		with(body, "path", many),
		with(body, "path", []map[string]any{{"lat": 91, "lng": 0}, {"lat": 0, "lng": 0}}),
		with(body, "path", []map[string]any{{"lat": 1}, {"lat": 0, "lng": 0}}),
		with(body, "path", []map[string]any{{"lat": 1, "lng": 1, "alt": 3}, {"lat": 0, "lng": 0}}),
		with(body, "a_site_id", site),
		with(body, "b_site_id", otherSite),
		with(body, "a_box_id", foreignBox),
		with(body, "declared_length_m", 0),
		with(body, "active", false),
	} {
		call("a", "POST", base, invalid, 400)
	}
	call("a", "POST", base, with(body, "name", "Cabo tronco"), 409)
	call("a", "POST", base, "[]", 400)
	// Permissões, módulo e isolamento.
	call("read", "POST", base, with(body, "name", "Leitura"), 403)
	call("portal", "GET", base, nil, 403)
	call("nomod", "GET", base, nil, 403)
	call("read", "GET", base+"/"+cid, nil, 200)
	call("b", "GET", base+"/"+cid, nil, 404)
	call("b", "PATCH", base+"/"+cid, map[string]any{"name": "Invadido"}, 404)
	call("a", "POST", base, with(body, "pop_id", pops[2], "a_box_id", nil, "b_site_id", nil), 404)
	call("limited", "POST", base, with(body, "pop_id", pops[1], "name", "Outro POP", "b_site_id", nil), 404)
	hidden := call("a", "POST", base, with(body, "pop_id", pops[1], "name", "Cabo oculto", "b_site_id", otherSite, "kind", "underground"), 200)
	hid := hidden["id"].(string)
	call("a", "POST", base, with(body, "pop_id", pops[1], "b_site_id", otherSite), 200) // mesmo nome em outro POP
	call("limited", "GET", base+"/"+hid, nil, 404)
	call("limited", "PATCH", base+"/"+hid, map[string]any{"name": "Não visível"}, 404)
	if list := call("limited", "GET", base+"?status=all", nil, 200); list["total"].(float64) != 1 || items(list)[0].(map[string]any)["id"] != cid {
		t.Fatalf("lista limitada: %v", list)
	}
	if list := call("a", "GET", base+"?kind=underground&q=oculto&pop_id="+pops[1], nil, 200); list["total"].(float64) != 1 {
		t.Fatalf("filtro: %v", list)
	}
	call("limited", "GET", base+"?pop_id="+pops[1], nil, 404)
	call("a", "GET", base+"?limit=0", nil, 400)
	call("a", "GET", base+"?zzz=1", nil, 400)
	if list := call("b", "GET", base+"?status=all", nil, 200); list["total"].(float64) != 0 {
		t.Fatalf("outro provedor: %v", list)
	}
	// Mapa por área, sem cabos de outros POPs para o operador limitado.
	area := base + "/map?south=-4&north=-2&west=-39&east=-37"
	if m := call("a", "GET", area, nil, 200); len(items(m)) != 3 || m["truncated"] != false {
		t.Fatalf("mapa: %v", m)
	}
	if m := call("limited", "GET", area, nil, 200); len(items(m)) != 1 || len(items(m)[0].(map[string]any)["path"].([]any)) != 2 {
		t.Fatalf("mapa limitado: %v", m)
	}
	call("a", "GET", base+"/map?south=-2&north=-4&west=-39&east=-37", nil, 400)
	call("a", "GET", base+"/map?south=-4&north=-2&west=-39", nil, 400)
	if m := call("a", "GET", base+"/map?south=10&north=20&west=10&east=20", nil, 200); len(items(m)) != 0 {
		t.Fatalf("mapa fora da área: %v", m)
	}
	// Edição parcial: novo traçado recalcula o comprimento e preserva o resto.
	longer := append(line, map[string]any{"lat": -3.002, "lng": -38.0})
	patched := call("a", "PATCH", base+"/"+cid, map[string]any{"path": longer, "declared_length_m": 250.5}, 200)
	if math.Abs(patched["computed_length_m"].(float64)-222.39) > 0.02 || patched["declared_length_m"] != 250.5 || patched["notes"] != "projeto" || patched["a_box_id"] != box {
		t.Fatalf("edição: %v", patched)
	}
	call("a", "PATCH", base+"/"+cid, map[string]any{"a_site_id": site}, 400)
	call("a", "PATCH", base+"/"+cid, map[string]any{"pop_id": pops[1]}, 400) // local da ponta B é do POP 0

	// Fusões dentro da caixa.
	branch := call("a", "POST", base, with(body, "name", "Cabo derivação", "fiber_count", 4, "a_box_id", nil, "b_site_id", nil), 200)
	bid := branch["id"].(string)
	hiddenBranch := call("a", "POST", base, with(body, "pop_id", pops[1], "name", "Derivação oculta", "a_box_id", nil, "b_site_id", nil), 200)
	fusions := "/api/ftth/boxes/" + box + "/fusions"
	first := call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 1, "b_cable_id": bid, "b_fiber": 1, "loss_db": 0.05, "notes": " bandeja 1 "}, 200)
	if first["a_cable_name"] != "Cabo tronco" || first["b_cable_name"] != "Cabo derivação" || first["loss_db"] != 0.05 || first["notes"] != "bandeja 1" {
		t.Fatalf("fusão: %v", first)
	}
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 1, "b_cable_id": bid, "b_fiber": 2}, 409)
	call("a", "POST", fusions, map[string]any{"a_cable_id": bid, "a_fiber": 1, "b_cable_id": cid, "b_fiber": 3}, 409)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 13, "b_cable_id": bid, "b_fiber": 2}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 2, "b_cable_id": bid, "b_fiber": 5}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5, "b_cable_id": cid, "b_fiber": 5}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5, "b_cable_id": bid, "b_fiber": 2, "b_port": 1}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5, "b_port": 1, "extra": true}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5, "b_port": 1, "loss_db": 9}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5, "b_cable_id": hiddenBranch["id"], "b_fiber": 1}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 5, "b_port": 9}, 400)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 2, "b_port": 3}, 200)
	call("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 4, "b_port": 3}, 409)
	call("a", "POST", "/api/ftth/boxes/"+foreignBox+"/fusions", map[string]any{"a_cable_id": cid, "a_fiber": 6, "b_port": 1}, 404)
	call("b", "GET", fusions, nil, 404)
	call("read", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 6, "b_port": 1}, 403)
	call("limited", "POST", fusions, map[string]any{"a_cable_id": hid, "a_fiber": 1, "b_port": 1}, 404)
	hiddenFusion := call("a", "POST", fusions, map[string]any{"a_cable_id": hid, "a_fiber": 1, "b_cable_id": hiddenBranch["id"], "b_fiber": 1}, 200)
	if list := call("a", "GET", fusions, nil, 200); len(items(list)) != 3 || list["box"].(map[string]any)["name"] != "CTO projeto "+tag {
		t.Fatalf("fusões: %v", list)
	}
	if list := call("limited", "GET", fusions, nil, 200); len(items(list)) != 2 {
		t.Fatalf("fusões limitadas: %v", list)
	}
	call("limited", "DELETE", "/api/ftth/fusions/"+hiddenFusion["id"].(string), nil, 404)
	// Concorrência: a mesma fibra em duas fusões simultâneas só grava uma.
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = raw("a", "POST", fusions, map[string]any{"a_cable_id": cid, "a_fiber": 7, "b_port": 5 + i}).Code
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 200)) {
		t.Fatalf("concorrência: %v", codes)
	}
	call("a", "PATCH", base+"/"+cid, map[string]any{"fiber_count": 6}, 409)
	call("a", "PATCH", base+"/"+bid, map[string]any{"pop_id": pops[1]}, 409)
	call("a", "DELETE", "/api/ftth/fusions/"+first["id"].(string), nil, 200)
	call("a", "DELETE", "/api/ftth/fusions/"+first["id"].(string), nil, 404)
	call("a", "POST", fusions, map[string]any{"a_cable_id": bid, "a_fiber": 1, "b_cable_id": cid, "b_fiber": 1}, 200)
	call("a", "PATCH", base+"/"+bid, map[string]any{"active": false}, 200)
	call("a", "POST", fusions, map[string]any{"a_cable_id": bid, "a_fiber": 2, "b_port": 7}, 409)
	if list := call("a", "GET", base+"?status=archived", nil, 200); list["total"].(float64) != 1 {
		t.Fatalf("arquivados: %v", list)
	}

	// OTDR com arquivo bruto privado.
	otdr := base + "/" + cid + "/otdr"
	sor := []byte("SOR\x00binario\x01\xff")
	measure := map[string]any{"fiber": 1, "measured_on": "2026-11-01", "wavelength_nm": 1550, "total_distance_m": 1200.5, "total_loss_db": 0.9, "events": []map[string]any{{"distance_m": 600, "loss_db": 0.1, "type": "splice"}, {"distance_m": 100, "loss_db": 0.3, "type": "connector"}}, "technician": " Técnica Ana ", "notes": "", "file_name": "medicao/1.sor", "file_content_base64": base64.StdEncoding.EncodeToString(sor)}
	m := call("a", "POST", otdr, measure, 200)
	mid := m["id"].(string)
	events := m["events"].([]any)
	if m["technician"] != "Técnica Ana" || m["file_name"] != "medicao_1.sor" || m["file_size"].(float64) != float64(len(sor)) || len(events) != 2 || events[0].(map[string]any)["type"] != "connector" || m["measured_on"] != "2026-11-01" {
		t.Fatalf("medição: %v", m)
	}
	rec := raw("read", "GET", otdr+"/"+mid+"/file", nil)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), sor) || rec.Header().Get("Content-Type") != "application/octet-stream" || !strings.Contains(rec.Header().Get("Content-Disposition"), "medicao_1.sor") || !strings.Contains(rec.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("download: %d %v", rec.Code, rec.Header())
	}
	plain := call("a", "POST", otdr, with(measure, "file_name", "<remove>", "file_content_base64", "<remove>", "events", []any{}, "wavelength_nm", 1310), 200)
	call("a", "GET", otdr+"/"+plain["id"].(string)+"/file", nil, 404)
	for _, invalid := range []map[string]any{
		with(measure, "wavelength_nm", 1490),
		with(measure, "fiber", 13),
		with(measure, "fiber", 0),
		with(measure, "measured_on", "2026-02-30"),
		with(measure, "measured_on", "2099-01-01"),
		with(measure, "total_distance_m", 0),
		with(measure, "total_loss_db", -1),
		with(measure, "events", []map[string]any{{"distance_m": 5000, "loss_db": 0.1, "type": "splice"}}),
		with(measure, "events", []map[string]any{{"distance_m": 5, "loss_db": 0.1, "type": "fusao"}}),
		with(measure, "events", []map[string]any{{"distance_m": 5, "loss_db": 0.1, "type": "splice", "x": 1}}),
		with(measure, "file_content_base64", "<remove>"),
		with(measure, "file_content_base64", "não é base64"),
		with(measure, "file_content_base64", ""),
		with(measure, "technician", "x"),
		with(measure, "extra", 1),
	} {
		call("a", "POST", otdr, invalid, 400)
	}
	call("a", "POST", otdr, with(measure, "file_content_base64", base64.StdEncoding.EncodeToString(make([]byte, otdrMaxFile+1))), 400)
	limit := call("a", "POST", otdr, with(measure, "file_content_base64", base64.StdEncoding.EncodeToString(make([]byte, otdrMaxFile))), 200)
	if limit["file_size"].(float64) != otdrMaxFile {
		t.Fatalf("limite: %v", limit["file_size"])
	}
	if list := call("read", "GET", otdr, nil, 200); len(items(list)) != 3 || list["cable"].(map[string]any)["name"] != "Cabo tronco" {
		t.Fatalf("lista OTDR: %v", list)
	}
	call("read", "POST", otdr, measure, 403)
	call("b", "GET", otdr, nil, 404)
	call("b", "GET", otdr+"/"+mid+"/file", nil, 404)
	call("limited", "GET", base+"/"+hid+"/otdr", nil, 404)
	call("a", "GET", base+"/"+bid+"/otdr/"+mid+"/file", nil, 404)
	call("a", "POST", base+"/"+bid+"/otdr", with(measure, "file_name", "<remove>", "file_content_base64", "<remove>"), 409)
	call("a", "PATCH", base+"/"+cid, map[string]any{"pop_id": pops[1], "b_site_id": nil}, 409)

	// Importação KML: prévia sem gravação, erros por item e aplicação atômica.
	kml := func(placemarks string) string {
		placemarks = strings.ReplaceAll(placemarks, "{t}", tag)
		return base64.StdEncoding.EncodeToString([]byte(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder>` + placemarks + `</Folder></Document></kml>`))
	}
	good := kml(`<Placemark><name>CTO KML 1 {t}</name><ExtendedData><Data name="portas"><value>16</value></Data></ExtendedData><Point><coordinates>-38.5,-3.7,0</coordinates></Point></Placemark>
<Placemark><name>CEO KML 2 {t}</name><ExtendedData><Data name="Tipo"><value>CEO</value></Data></ExtendedData><Point><coordinates>-38.5,-3.701</coordinates></Point></Placemark>
<Placemark><name>Cabo KML</name><ExtendedData><SchemaData schemaUrl="#s"><SimpleData name="fibras">24</SimpleData></SchemaData></ExtendedData><LineString><coordinates>-38.5,-3.7 -38.5,-3.7005 -38.5,-3.70100003</coordinates></LineString></Placemark>
<Placemark><name>Área de cobertura</name><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,1 1,0 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`)
	request := map[string]any{"pop_id": pops[0], "file_name": "projeto.kml", "content_base64": good, "box_kind": "cto", "box_ports": 8, "cable_kind": "underground", "cable_fibers": 12}
	boxes, cables := count("ftth_boxes"), count("ftth_cables")
	preview := call("a", "POST", "/api/ftth/gis/kml/preview", request, 200)
	if count("ftth_boxes") != boxes || count("ftth_cables") != cables {
		t.Fatal("a prévia gravou registros")
	}
	pb, pc := preview["boxes"].([]any), preview["cables"].([]any)
	if preview["valid"] != true || len(pb) != 2 || len(pc) != 1 || len(preview["ignored"].([]any)) != 1 || pb[0].(map[string]any)["ports"].(float64) != 16 || pb[1].(map[string]any)["kind"] != "ceo" {
		t.Fatalf("prévia: %v", preview)
	}
	pcable := pc[0].(map[string]any)
	if pcable["fiber_count"].(float64) != 24 || pcable["kind"] != "underground" || pcable["a_box_name"] != "CTO KML 1 "+tag || pcable["b_box_name"] != "CEO KML 2 "+tag || pcable["points"].(float64) != 3 {
		t.Fatalf("cabo da prévia: %v", pcable)
	}
	bad := with(request, "content_base64", kml(`<Placemark><name>CTO válida {t}</name><Point><coordinates>-38.5,-3.7</coordinates></Point></Placemark>
<Placemark><name>CTO ruim {t}</name><Point><coordinates>abc,def</coordinates></Point></Placemark>
<Placemark><name>CTO válida {t}</name><Point><coordinates>-38.5,-3.8</coordinates></Point></Placemark>
<Placemark><name>Cabo curto</name><LineString><coordinates>-38.5,-3.7</coordinates></LineString></Placemark>
<Placemark><name>Cabo tronco</name><ExtendedData><Data name="fibras"><value>500</value></Data></ExtendedData><LineString><coordinates>-38.5,-3.7 -38.5,-3.8</coordinates></LineString></Placemark>`))
	report := call("a", "POST", "/api/ftth/gis/kml/preview", bad, 200)
	errorsOf := func(list any, i int) []any { return list.([]any)[i].(map[string]any)["errors"].([]any) }
	if report["valid"] != false || len(errorsOf(report["boxes"], 0)) != 0 || len(errorsOf(report["boxes"], 1)) != 1 || len(errorsOf(report["boxes"], 2)) != 1 || len(errorsOf(report["cables"], 0)) != 1 || len(errorsOf(report["cables"], 1)) != 2 {
		t.Fatalf("erros por item: %v", report)
	}
	call("a", "POST", "/api/ftth/gis/kml/apply", bad, 400)
	if count("ftth_boxes") != boxes || count("ftth_cables") != cables {
		t.Fatal("aplicação com erro gravou parte do arquivo")
	}
	for _, doc := range []string{
		`<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&xxe;</name><Point><coordinates>0,0</coordinates></Point></Placemark></kml>`,
		"PK\x03\x04kmz",
		`<kml><Placemark>`,
		`<html></html>`,
	} {
		call("a", "POST", "/api/ftth/gis/kml/preview", with(request, "content_base64", base64.StdEncoding.EncodeToString([]byte(doc))), 400)
		call("a", "POST", "/api/ftth/gis/kml/apply", with(request, "content_base64", base64.StdEncoding.EncodeToString([]byte(doc))), 400)
	}
	call("a", "POST", "/api/ftth/gis/kml/preview", with(request, "file_name", "projeto.kmz"), 400)
	call("a", "POST", "/api/ftth/gis/kml/preview", with(request, "content_base64", base64.StdEncoding.EncodeToString(make([]byte, otdrMaxFile+1))), 400)
	call("a", "POST", "/api/ftth/gis/kml/preview", with(request, "box_ports", 0), 400)
	call("a", "POST", "/api/ftth/gis/kml/preview", with(request, "extra", 1), 400)
	call("a", "POST", "/api/ftth/gis/kml/apply", with(request, "content_base64", kml(`<Placemark><name>Só área</name><Polygon/></Placemark>`)), 400)
	call("read", "POST", "/api/ftth/gis/kml/preview", request, 403)
	call("limited", "POST", "/api/ftth/gis/kml/apply", with(request, "pop_id", pops[1]), 404)
	call("b", "POST", "/api/ftth/gis/kml/apply", request, 404)
	if count("ftth_boxes") != boxes || count("ftth_cables") != cables {
		t.Fatal("tentativas negadas gravaram registros")
	}
	applied := call("limited", "POST", "/api/ftth/gis/kml/apply", request, 200)
	if applied["boxes_created"].(float64) != 2 || applied["cables_created"].(float64) != 1 || count("ftth_boxes") != boxes+2 || count("ftth_cables") != cables+1 {
		t.Fatalf("aplicação: %v", applied)
	}
	imported := call("a", "GET", base+"/"+applied["cable_ids"].([]any)[0].(string), nil, 200)
	ids := applied["box_ids"].([]any)
	if imported["a_box_id"] != ids[0] || imported["b_box_id"] != ids[1] || imported["fiber_count"].(float64) != 24 || imported["pop_id"] != pops[0] || !strings.Contains(imported["notes"].(string), "projeto.kml") {
		t.Fatalf("cabo importado: %v", imported)
	}
	again := call("a", "POST", "/api/ftth/gis/kml/preview", request, 200)
	if again["valid"] != false || len(errorsOf(again["boxes"], 0)) != 1 || len(errorsOf(again["cables"], 0)) != 1 {
		t.Fatalf("reimportação: %v", again)
	}
	call("a", "POST", "/api/ftth/gis/kml/apply", request, 400)
	if count("ftth_boxes") != boxes+2 {
		t.Fatal("reaplicação duplicou caixas")
	}
	// Caixas com fusões ou pontas de cabo não perdem o projeto por edição ou exclusão.
	call("a", "PATCH", "/api/ftth/boxes/"+box, map[string]any{"ports": 2}, 409)
	call("a", "DELETE", "/api/ftth/boxes/"+box, nil, 409)
	call("a", "DELETE", "/api/ftth/boxes/"+ids[1].(string), nil, 409)
	free := exec(tenants[0], `insert into ftth_boxes(tenant_id,name,kind,ports) values($1,$2,'cto',4) returning id::text`, tenants[0], "CTO livre "+tag)
	call("a", "DELETE", "/api/ftth/boxes/"+free, nil, 200)
}
