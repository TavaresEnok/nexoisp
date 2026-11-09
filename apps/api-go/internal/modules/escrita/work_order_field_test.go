package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
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
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

func fieldPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		img.Set(x, height/2, color.Black)
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestWorkOrderFieldHelpers(t *testing.T) {
	// Fortaleza: ~111 m por milésimo de grau de latitude.
	if d := distanceMeters(-3.731, -38.526, -3.732, -38.526); d < 110 || d > 112 {
		t.Fatalf("distância: %v", d)
	}
	if distanceMeters(10, 20, 10, 20) != 0 {
		t.Fatal("mesmo ponto deve ter distância zero")
	}
	base := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	at := func(minutes int) jsonx.Time { return jsonx.Time{Time: base.Add(time.Duration(minutes) * time.Minute)} }
	items := []jsonx.Object{
		{{Name: "check_in_at", Value: at(0)}, {Name: "check_out_at", Value: at(30)}},
		{{Name: "check_in_at", Value: at(10)}, {Name: "check_out_at", Value: at(40)}},
		{{Name: "check_in_at", Value: at(60)}, {Name: "check_out_at", Value: nil}},
	}
	// 0–40 unidos (sobreposição conta uma vez) + 60–70 em aberto até "agora".
	if got := attendanceSeconds(items, base.Add(70*time.Minute)); got != 50*60 {
		t.Fatalf("tempo em atendimento: %d", got)
	}
	valid := base64.StdEncoding.EncodeToString(fieldPNG(t, 300, 120))
	if _, err := signatureContent(valid); err != nil {
		t.Fatal(err)
	}
	for name, input := range map[string]string{
		"jpeg":       base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff, 1, 2, 3}),
		"pequena":    base64.StdEncoding.EncodeToString(fieldPNG(t, 20, 20)),
		"truncada":   base64.StdEncoding.EncodeToString(fieldPNG(t, 300, 120)[:20]),
		"base64":     valid + "\n",
		"acima 1MiB": base64.StdEncoding.EncodeToString(append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, make([]byte, signatureMaxBytes)...)),
	} {
		if _, err := signatureContent(input); err == nil || apierr.Map(err).Status != 400 {
			t.Fatalf("%s aceito: %v", name, err)
		}
	}
}

func TestWorkOrderFieldPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_WORK_FIELD_PG_REQUIRED") == "1" || os.Getenv("PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com PostgreSQL obrigatório")
		}
		t.Skip("PostgreSQL ausente: trabalho de campo da OS não comprovado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var database, session string
	var tenants []string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select current_database(), session_user::text`).Scan(&database, &session); e != nil {
			return e
		}
		rows, e := tx.Objects(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id`)
		if e != nil {
			return e
		}
		for _, r := range rows {
			tenants = append(tenants, r.Get("tenant_id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if database != "nexo_test" || session != "nexo_go" || len(tenants) < 2 {
		t.Fatal("requer nexo_test/nexo_go descartável com dois tenants")
	}
	// Usuários: A administra, B é o técnico atribuído só com leitura, C lê sem estar atribuído, X é de outro provedor.
	var userA, userB, userC, userX, subscriber, order, waiting, closed, foreign string
	newUser := func(tx *db.Tx, tenant string) (string, error) {
		var id string
		return id, tx.QueryRow(ctx, `insert into users (tenant_id,email,name,password_hash,role) values ($1,$2,$3,'!','noc') returning id::text`, tenant, uuid.NewString()+"@example.invalid", "Campo "+uuid.NewString()[:8]).Scan(&id)
	}
	newOrder := func(tx *db.Tx, tenant, sub string, contract, assignee any) (string, error) {
		var id string
		return id, tx.QueryRow(ctx, `insert into work_orders (tenant_id,number,kind,subscriber_id,contract_id,assignee_id,description) values ($1,(select coalesce(max(number),0)+1 from work_orders),'install',$2,$3,$4,'campo teste') returning id::text`, tenant, sub, contract, assignee).Scan(&id)
	}
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var e error
		for _, target := range []*string{&userA, &userB, &userC} {
			if *target, e = newUser(tx, tenants[0]); e != nil {
				return e
			}
		}
		var pop, version, contract string
		if e = tx.QueryRow(ctx, `insert into pops (tenant_id,name) values ($1,$2) returning id::text`, tenants[0], "campo-"+uuid.NewString()).Scan(&pop); e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `select id::text from plan_versions limit 1`).Scan(&version); e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `insert into subscribers (tenant_id,name) values ($1,'Cliente campo') returning id::text`, tenants[0]).Scan(&subscriber); e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `insert into contracts (tenant_id,subscriber_id,plan_version_id,due_day,pop_id,latitude,longitude) values ($1,$2,$3,10,$4,-3.731000,-38.526000) returning id::text`, tenants[0], subscriber, version, pop).Scan(&contract); e != nil {
			return e
		}
		if order, e = newOrder(tx, tenants[0], subscriber, contract, userB); e != nil {
			return e
		}
		if waiting, e = newOrder(tx, tenants[0], subscriber, nil, userB); e != nil {
			return e
		}
		closed, e = newOrder(tx, tenants[0], subscriber, nil, userB)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		var e error
		if userX, e = newUser(tx, tenants[1]); e != nil {
			return e
		}
		var sub string
		if e = tx.QueryRow(ctx, `insert into subscribers (tenant_id,name) values ($1,'Cliente outro provedor') returning id::text`, tenants[1]).Scan(&sub); e != nil {
			return e
		}
		foreign, e = newOrder(tx, tenants[1], sub, nil, userX)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	actor := func(user, tenant string, perms []string, scope tenancy.Scope) *auth.Ctx {
		scope.TenantID = tenant
		return &auth.Ctx{UserID: user, TenantID: tenant, Role: "noc", Permissions: perms, Modules: []string{"field"}, ExpiresAt: time.Now().Add(time.Hour), Scope: scope}
	}
	actors := map[string]*auth.Ctx{
		ftthHash("campo-a"):       actor(userA, tenants[0], auth.Permissions["admin"], tenancy.Scope{}),
		ftthHash("campo-b"):       actor(userB, tenants[0], []string{"os:read"}, tenancy.Scope{}),
		ftthHash("campo-c"):       actor(userC, tenants[0], []string{"os:read"}, tenancy.Scope{}),
		ftthHash("campo-x"):       actor(userX, tenants[1], auth.Permissions["admin"], tenancy.Scope{}),
		ftthHash("campo-pop"):     actor(userA, tenants[0], auth.Permissions["admin"], tenancy.Scope{PopIDs: []string{uuid.NewString()}}),
		ftthHash("campo-portal"):  actor(userA, tenants[0], []string{"os:read", "os:write"}, tenancy.Scope{SubscriberID: subscriber}),
		ftthHash("campo-finance"): actor(userA, tenants[0], auth.Permissions["finance"], tenancy.Scope{}),
	}
	a, err := auth.New(ftthLoader{actors}, 0, false, 10000, prometheus.NewRegistry())
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
	config := huma.DefaultConfig("campo", "1")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	Register(humachi.New(router, config), registry, Service{DB: d})
	type response struct {
		code int
		raw  []byte
		body map[string]any
	}
	call := func(token, method, path string, body any) response {
		t.Helper()
		var reader *bytes.Reader
		if body == nil {
			reader = bytes.NewReader(nil)
		} else {
			b, _ := json.Marshal(body)
			reader = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, reader)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
			req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		out := response{code: w.Code, raw: w.Body.Bytes()}
		_ = json.Unmarshal(w.Body.Bytes(), &out.body)
		return out
	}
	expect := func(r response, code int, label string) response {
		t.Helper()
		if r.code != code {
			t.Fatalf("%s: HTTP %d esperado %d: %s", label, r.code, code, r.raw)
		}
		return r
	}
	scalar := func(scope tenancy.Scope, sql string, args ...any) int {
		t.Helper()
		var n int
		if e := d.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.QueryRow(ctx, sql, args...).Scan(&n) }); e != nil {
			t.Fatal(e)
		}
		return n
	}
	tenant0 := tenancy.Scope{TenantID: tenants[0]}
	wo := "/api/work-orders/" + order

	// Autenticação, CSRF, autorização e isolamento por provedor, POP e portal.
	expect(call("", "POST", wo+"/check-in", map[string]any{}), 401, "sem sessão")
	noCSRF := httptest.NewRequest("POST", wo+"/check-in", bytes.NewReader([]byte(`{}`)))
	noCSRF.Header.Set("Content-Type", "application/json")
	noCSRF.AddCookie(&http.Cookie{Name: "nexo_session", Value: "campo-a"})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, noCSRF)
	if rec.Code != 403 {
		t.Fatalf("sem CSRF: HTTP %d", rec.Code)
	}
	expect(call("campo-finance", "GET", wo+"/visits", nil), 403, "perfil sem os:read")
	expect(call("campo-c", "POST", wo+"/check-in", map[string]any{}), 403, "leitor não atribuído")
	if r := expect(call("campo-c", "GET", wo+"/visits", nil), 200, "leitor consulta"); r.body["can_check_in"] != false {
		t.Fatalf("leitor não atribuído pode check-in: %s", r.raw)
	}
	for _, token := range []string{"campo-x", "campo-pop", "campo-portal"} {
		expect(call(token, "GET", wo+"/visits", nil), 404, token+" consulta")
		expect(call(token, "POST", wo+"/check-in", map[string]any{}), 404, token+" check-in")
		expect(call(token, "POST", wo+"/signature", map[string]any{"signer_name": "Fulano", "content_base64": base64.StdEncoding.EncodeToString(fieldPNG(t, 300, 120))}), 404, token+" assinatura")
	}
	expect(call("campo-b", "GET", "/api/work-orders/"+foreign+"/visits", nil), 404, "OS de outro provedor")

	// Validação estrita de geolocalização.
	for label, body := range map[string]map[string]any{
		"latitude sem longitude": {"latitude": -3.7},
		"latitude fora":          {"latitude": 91, "longitude": 0},
		"longitude fora":         {"latitude": 0, "longitude": -181},
		"precisão sem posição":   {"accuracy_m": 10},
		"precisão negativa":      {"latitude": 0, "longitude": 0, "accuracy_m": -1},
		"horário inválido":       {"device_at": "ontem"},
		"chave inválida":         {"idempotency_key": "abc"},
	} {
		expect(call("campo-b", "POST", wo+"/check-in", body), 400, label)
	}
	expect(call("campo-b", "POST", wo+"/check-out", map[string]any{}), 409, "check-out sem check-in")

	// Check-in do técnico atribuído inicia a execução e mede a distância até a instalação.
	device := "2026-11-09T07:00:00-03:00"
	r := expect(call("campo-b", "POST", wo+"/check-in", map[string]any{"latitude": -3.732, "longitude": -38.526, "accuracy_m": 12.5, "device_at": device}), 200, "check-in")
	if dist, _ := r.body["check_in_distance_m"].(float64); dist < 100 || dist > 125 || r.body["check_in_located"] != true || r.body["check_out_at"] != nil {
		t.Fatalf("check-in: %s", r.raw)
	}
	visitB := r.body["id"].(string)
	var status string
	var started bool
	if e := d.WithScope(ctx, tenant0, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select status, started_at is not null from work_orders where id=$1`, order).Scan(&status, &started)
	}); e != nil || status != "in_progress" || !started {
		t.Fatalf("check-in não iniciou a execução: %s %v %v", status, started, e)
	}
	expect(call("campo-b", "POST", wo+"/check-in", map[string]any{}), 409, "segundo check-in aberto")
	r = expect(call("campo-b", "POST", wo+"/check-out", map[string]any{"device_at": device}), 200, "check-out")
	if r.body["id"] != visitB || r.body["check_out_reason"] != "technician" || r.body["check_out_located"] != false || r.body["check_out_distance_m"] != nil {
		t.Fatalf("check-out: %s", r.raw)
	}
	expect(call("campo-b", "POST", wo+"/check-out", map[string]any{}), 409, "check-out repetido sem chave")
	if n := scalar(tenant0, `select count(*)::int from work_order_events where work_order_id=$1 and event in ('check_in','check_out') and detail->>'device_at'=$2`, order, device); n != 2 {
		t.Fatalf("eventos com horário do dispositivo: %d", n)
	}
	expect(call("campo-b", "POST", "/api/work-orders/"+waiting+"/status", map[string]any{"status": "awaiting_schedule", "reason": "x"}), 403, "leitor não muda situação")
	expect(call("campo-a", "POST", "/api/work-orders/"+waiting+"/status", map[string]any{"status": "awaiting_schedule", "reason": "Cliente remarcou"}), 200, "aguardar agendamento")
	expect(call("campo-b", "POST", "/api/work-orders/"+waiting+"/check-in", map[string]any{}), 409, "check-in aguardando agendamento")

	// Idempotência: mesma chave devolve o mesmo resultado, inclusive em concorrência; corpo diferente é recusado.
	key := uuid.NewString()
	body := map[string]any{"idempotency_key": key, "latitude": -3.731, "longitude": -38.526, "device_at": device}
	var first [2]response
	var wg sync.WaitGroup
	for i := range first {
		wg.Add(1)
		go func(i int) { defer wg.Done(); first[i] = call("campo-a", "POST", wo+"/check-in", body) }(i)
	}
	wg.Wait()
	expect(first[0], 200, "check-in idempotente A")
	expect(first[1], 200, "check-in idempotente B")
	replay := expect(call("campo-a", "POST", wo+"/check-in", body), 200, "repetição")
	if !bytes.Equal(first[0].raw, first[1].raw) || !bytes.Equal(first[0].raw, replay.raw) {
		t.Fatalf("respostas diferentes: %s | %s | %s", first[0].raw, first[1].raw, replay.raw)
	}
	if n := scalar(tenant0, `select count(*)::int from work_order_visits where work_order_id=$1 and technician_id=$2`, order, userA); n != 1 {
		t.Fatalf("check-in duplicado: %d", n)
	}
	visitA := replay.body["id"]
	if dist, _ := replay.body["check_in_distance_m"].(float64); dist != 0 {
		t.Fatalf("distância no local: %s", replay.raw)
	}
	changed := map[string]any{"idempotency_key": key, "latitude": -3.735, "longitude": -38.526, "device_at": device}
	expect(call("campo-a", "POST", wo+"/check-in", changed), 409, "mesma chave, corpo diferente")
	expect(call("campo-a", "POST", wo+"/notes", map[string]any{"note": "outra ação", "idempotency_key": key}), 409, "mesma chave, outra ação")
	expect(call("campo-a", "POST", "/api/work-orders/"+closed+"/check-in", body), 409, "mesma chave, outra OS")

	noteKey := uuid.NewString()
	note := map[string]any{"note": "Nota offline " + noteKey, "idempotency_key": noteKey, "device_at": device}
	n1 := expect(call("campo-a", "POST", wo+"/notes", note), 200, "nota")
	n2 := expect(call("campo-a", "POST", wo+"/notes", note), 200, "nota repetida")
	if !bytes.Equal(n1.raw, n2.raw) {
		t.Fatalf("nota repetida: %s %s", n1.raw, n2.raw)
	}
	expect(call("campo-a", "POST", wo+"/notes", map[string]any{"note": "texto alterado", "idempotency_key": noteKey, "device_at": device}), 409, "nota alterada")
	expect(call("campo-b", "POST", wo+"/notes", map[string]any{"note": "Nota do técnico " + noteKey, "idempotency_key": noteKey}), 403, "técnico só leitor não anota")
	if n := scalar(tenant0, `select count(*)::int from work_order_events where work_order_id=$1 and event='note' and detail->>'note'=$2 and detail->>'device_at'=$3`, order, note["note"], device); n != 1 {
		t.Fatalf("nota duplicada: %d", n)
	}
	if n := scalar(tenant0, `select count(*)::int from field_action_receipts where user_id=$1 and idempotency_key=$2`, userA, noteKey); n != 1 {
		t.Fatalf("recibo da nota: %d", n)
	}
	listKey := uuid.NewString()
	list := map[string]any{"items": []string{"Conferir potência " + listKey}, "idempotency_key": listKey}
	expect(call("campo-a", "POST", wo+"/checklist", list), 200, "checklist")
	expect(call("campo-a", "POST", wo+"/checklist", list), 200, "checklist repetido")
	var item string
	if e := d.WithScope(ctx, tenant0, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select id::text from work_order_checklist where work_order_id=$1 and label=$2`, order, "Conferir potência "+listKey).Scan(&item)
	}); e != nil {
		t.Fatalf("item do checklist duplicado ou ausente: %v", e)
	}
	doneKey := uuid.NewString()
	done := map[string]any{"done": true, "idempotency_key": doneKey}
	expect(call("campo-a", "POST", wo+"/checklist/"+item, done), 200, "item concluído")
	expect(call("campo-a", "POST", wo+"/checklist/"+item, done), 200, "item concluído repetido")
	expect(call("campo-a", "POST", wo+"/checklist/"+uuid.NewString(), done), 409, "mesma chave, outro item")
	if n := scalar(tenant0, `select count(*)::int from work_order_events where work_order_id=$1 and event='checklist_done'`, order); n != 1 {
		t.Fatalf("conclusão duplicada: %d", n)
	}
	// Recibos não vazam para outro provedor.
	if n := scalar(tenancy.Scope{TenantID: tenants[1]}, `select count(*)::int from field_action_receipts where idempotency_key=$1`, noteKey); n != 0 {
		t.Fatal("recibo visível em outro provedor")
	}

	// Consulta: tempo em atendimento e presença aberta do usuário.
	r = expect(call("campo-a", "GET", wo+"/visits", nil), 200, "presenças")
	if items, _ := r.body["items"].([]any); len(items) != 2 || r.body["open_visit_id"] != visitA || r.body["can_check_out"] != true || r.body["can_check_in"] != false || r.body["site_located"] != true {
		t.Fatalf("presenças: %s", r.raw)
	}
	if _, ok := r.body["attendance_seconds"].(float64); !ok {
		t.Fatalf("tempo em atendimento: %s", r.raw)
	}
	if strings.Contains(string(r.raw), "-38.526") {
		t.Fatal("coordenadas do técnico expostas na consulta")
	}
	outKey := uuid.NewString()
	o1 := expect(call("campo-a", "POST", wo+"/check-out", map[string]any{"idempotency_key": outKey}), 200, "check-out idempotente")
	o2 := expect(call("campo-a", "POST", wo+"/check-out", map[string]any{"idempotency_key": outKey}), 200, "check-out repetido")
	if !bytes.Equal(o1.raw, o2.raw) {
		t.Fatalf("check-out repetido diferente: %s %s", o1.raw, o2.raw)
	}
	// A chave pertence ao usuário: outro técnico com a mesma chave e corpo registra a própria presença.
	r = expect(call("campo-b", "POST", wo+"/check-in", body), 200, "mesma chave de outro usuário")
	if r.body["id"] == visitA || r.body["technician_id"] != userB {
		t.Fatalf("chave compartilhada entre usuários: %s", r.raw)
	}
	expect(call("campo-b", "POST", wo+"/check-out", map[string]any{}), 200, "check-out de B")

	// Assinatura do cliente: PNG validado, hash, OS aberta, uma por OS, fora da lista de anexos.
	signature := fieldPNG(t, 320, 140)
	sum := sha256.Sum256(signature)
	sign := map[string]any{"signer_name": "  Maria Cliente  ", "signer_document": "123.456.789-09", "content_base64": base64.StdEncoding.EncodeToString(signature), "device_at": device}
	expect(call("campo-c", "POST", wo+"/signature", sign), 403, "assinatura por leitor não atribuído")
	for label, content := range map[string]string{
		"jpeg":    base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff, 1}),
		"pequena": base64.StdEncoding.EncodeToString(fieldPNG(t, 10, 10)),
		"tamanho": base64.StdEncoding.EncodeToString(append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, make([]byte, signatureMaxBytes)...)),
		"base64":  "não é base64",
	} {
		bad := map[string]any{"signer_name": "Maria", "content_base64": content}
		expect(call("campo-b", "POST", wo+"/signature", bad), 400, "assinatura "+label)
	}
	expect(call("campo-b", "POST", wo+"/signature", map[string]any{"signer_name": "M", "content_base64": sign["content_base64"]}), 400, "nome curto")
	expect(call("campo-b", "POST", wo+"/signature", map[string]any{"signer_name": "Maria", "signer_document": "<script>", "content_base64": sign["content_base64"]}), 400, "documento inválido")
	r = expect(call("campo-b", "POST", wo+"/signature", sign), 200, "assinatura")
	if r.body["sha256"] != hex.EncodeToString(sum[:]) || r.body["signer_name"] != "Maria Cliente" || r.body["signer_document"] != "123.456.789-09" || r.body["mime"] != "image/png" || r.body["signed_at"] == nil {
		t.Fatalf("assinatura: %s", r.raw)
	}
	signatureDoc := r.body["document_id"].(string)
	expect(call("campo-a", "POST", wo+"/signature", sign), 409, "segunda assinatura")
	r = expect(call("campo-c", "GET", wo+"/signature", nil), 200, "consulta da assinatura")
	if sig, _ := r.body["signature"].(map[string]any); sig == nil || sig["document_id"] != signatureDoc || r.body["can_sign"] != false {
		t.Fatalf("consulta: %s", r.raw)
	}
	img := httptest.NewRecorder()
	imgReq := httptest.NewRequest("GET", wo+"/signature/image", nil)
	imgReq.AddCookie(&http.Cookie{Name: "nexo_session", Value: "campo-c"})
	router.ServeHTTP(img, imgReq)
	if img.Code != 200 || !bytes.Equal(img.Body.Bytes(), signature) || img.Header().Get("Content-Type") != "image/png" || img.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("imagem: %d %v", img.Code, img.Header())
	}
	expect(call("campo-x", "GET", wo+"/signature/image", nil), 404, "imagem em outro provedor")
	r = expect(call("campo-a", "GET", wo+"/attachments", nil), 200, "anexos")
	if strings.Contains(string(r.raw), signatureDoc) {
		t.Fatal("assinatura listada como anexo")
	}
	expect(call("campo-a", "DELETE", wo+"/attachments/"+signatureDoc, nil), 404, "assinatura não é excluída como anexo")
	expect(call("campo-a", "GET", wo+"/attachments/"+signatureDoc+"/download", nil), 404, "assinatura não sai como anexo")
	if n := scalar(tenant0, `select count(*)::int from documents where id=$1 and kind='signature' and mime='image/png' and sha256=$2 and work_order_id=$3`, signatureDoc, hex.EncodeToString(sum[:]), order); n != 1 {
		t.Fatal("documento privado da assinatura ausente")
	}
	// Legenda de foto no anexo.
	photo := map[string]any{"name": "foto.jpg", "content_base64": base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff, 1, 2}), "caption": "  Caixa de emenda  "}
	r = expect(call("campo-a", "POST", wo+"/attachments", photo), 200, "foto com legenda")
	if r.body["caption"] != "Caixa de emenda" || r.body["kind"] != "photo" {
		t.Fatalf("legenda: %s", r.raw)
	}
	expect(call("campo-a", "POST", wo+"/attachments", map[string]any{"name": "foto.jpg", "content_base64": photo["content_base64"], "caption": strings.Repeat("x", 201)}), 400, "legenda longa")

	// Encerrar a OS fecha presenças abertas; depois não há check-in nem assinatura.
	expect(call("campo-b", "POST", wo+"/check-in", map[string]any{}), 200, "novo check-in de B")
	expect(call("campo-a", "POST", wo+"/status", map[string]any{"status": "done", "resolution": "Instalação concluída"}), 200, "conclusão")
	if n := scalar(tenant0, `select count(*)::int from work_order_visits where work_order_id=$1 and check_out_at is null`, order); n != 0 {
		t.Fatalf("presença aberta após conclusão: %d", n)
	}
	if n := scalar(tenant0, `select count(*)::int from work_order_visits where work_order_id=$1 and check_out_reason='os_finished'`, order); n != 1 {
		t.Fatalf("fechamento automático: %d", n)
	}
	expect(call("campo-b", "POST", wo+"/check-in", map[string]any{}), 409, "check-in em OS encerrada")
	expect(call("campo-b", "POST", wo+"/check-out", map[string]any{}), 409, "check-out sem presença aberta")
	expect(call("campo-a", "POST", "/api/work-orders/"+closed+"/status", map[string]any{"status": "canceled", "resolution": "Cancelada no teste"}), 200, "cancelamento")
	expect(call("campo-b", "POST", "/api/work-orders/"+closed+"/signature", sign), 409, "assinatura em OS encerrada")
	if r = expect(call("campo-b", "GET", "/api/work-orders/"+closed+"/signature", nil), 200, "consulta OS encerrada"); r.body["can_sign"] != false || r.body["signature"] != nil {
		t.Fatalf("OS encerrada: %s", r.raw)
	}
	// Uma nota idempotente continua aceita após a conclusão, como no fluxo existente.
	expect(call("campo-a", "POST", wo+"/notes", map[string]any{"note": "Registro posterior", "idempotency_key": uuid.NewString()}), 200, "nota após conclusão")

	// Anonimização do titular remove quem assinou, legendas e coordenadas.
	if e := d.WithScope(ctx, tenant0, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update subscribers set anonymized_at = now(), anonymized_reason = 'teste de campo' where id = $1`, subscriber)
	}); e != nil {
		t.Fatal(e)
	}
	if n := scalar(tenant0, `select count(*)::int from work_order_signatures where work_order_id=$1 and signer_name='Titular anonimizado' and signer_document is null`, order); n != 1 {
		t.Fatal("assinante não anonimizado")
	}
	if n := scalar(tenant0, `select count(*)::int from work_order_visits where work_order_id=$1 and (check_in_latitude is not null or check_out_latitude is not null)`, order); n != 0 {
		t.Fatal("coordenadas preservadas após anonimização")
	}
	if n := scalar(tenant0, `select count(*)::int from documents where subscriber_id=$1 and caption is not null`, subscriber); n != 0 {
		t.Fatal("legenda preservada após anonimização")
	}
	if n := scalar(tenant0, `select count(*)::int from audit_events where entity_id=$1 and detail::text like $2`, order, "%"+fmt.Sprint(sign["content_base64"])[:40]+"%"); n != 0 {
		t.Fatal("conteúdo da assinatura na auditoria")
	}
}
