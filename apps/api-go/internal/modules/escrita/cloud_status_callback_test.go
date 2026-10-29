package escrita

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/outbound/cloudjournal"
	"nexoisp/api-go/internal/tenancy"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
)

const (
	cloudCbCipher         = "v1.cloudcb-cipher-secret"
	cloudCbToken          = "EAAGcloudcbTOKEN"
	cloudCbPhone          = "5511999990000"
	cloudCbChallenge      = "cloudcb-challenge-secret"
	cloudCbWABAHomologado = false
)

func TestCloudStatusCallbackInventory(t *testing.T) {
	if cloudCbWABAHomologado {
		t.Fatal("WABA não está homologada")
	}
	root := cloudCbModuleRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, "rotas.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Routes []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
		} `json:"routes"`
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	cloud, gateway := 0, 0
	for _, route := range manifest.Routes {
		switch route.Path {
		case "/api/webhooks/cloud-api/:account":
			cloud++
			if route.Method != http.MethodPost {
				t.Fatalf("inventário cloud-api com método %s", route.Method)
			}
		case "/api/webhooks/gateway/:gateway":
			gateway++
			if route.Method != http.MethodPost {
				t.Fatal("gateway deixou de ser POST")
			}
		}
		if strings.Contains(route.Path, "cloud-api") && route.Path != "/api/webhooks/cloud-api/:account" {
			t.Fatalf("rota cloud-api extra %s %s", route.Method, route.Path)
		}
	}
	if cloud != 1 || gateway != 1 {
		t.Fatalf("inventário cloud=%d gateway=%d", cloud, gateway)
	}
	gatewaySrc, err := os.ReadFile(filepath.Join(filepath.Dir(cloudCbFile(t)), "gateway.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(gatewaySrc), `"/api/webhooks/gateway/{gateway}"`) {
		t.Fatal("rota genérica de gateway alterada")
	}
	customSrc, err := os.ReadFile(filepath.Join(filepath.Dir(cloudCbFile(t)), "custom.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(customSrc), "registerCloudStatusCallback(api, registry, s)") {
		t.Fatal("registerCustom não registra o callback")
	}

	_, api, registry := cloudCbAPI(t)
	registerCloudStatusCallback(api, registry, Service{})
	cloudCbAssertOpenAPI(t, api, false)

	_, full, fullRegistry := cloudCbAPI(t)
	registerCustom(full, fullRegistry, Service{})
	cloudCbAssertOpenAPI(t, full, true)
}

func TestCloudStatusCallbackSourceClosed(t *testing.T) {
	raw, err := os.ReadFile(cloudCbFile(t))
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	for _, banned := range []string{
		`"os"`, "os.Getenv", "os.LookupEnv", "encoding/json", "graph.facebook",
		"webhook_secret", "token_enc", "enqueueNotices", "finance.", "http.Client",
		"hub.challenge", "NEXO_", "auth.From", "X-Hub-Signature", "http.MethodGet",
		"PublicGet", ".Query(", "Header.Get",
	} {
		if strings.Contains(src, banned) {
			t.Fatalf("callback contém %s", banned)
		}
	}
	for _, required := range []string{
		"cloudjournal.UnprovedAuthenticator{}",
		"cloudjournal.AcceptStatus(",
		"WithScope(",
		"cloudStatusBodyMax",
		"ResolveAccount(",
	} {
		if !strings.Contains(src, required) {
			t.Fatalf("callback sem %s", required)
		}
	}
	if (cloudjournal.UnprovedAuthenticator{}).Proven() {
		t.Fatal("UnprovedAuthenticator aceitou")
	}
}

func TestCloudStatusCallbackUnprovedRefusesBeforeDB(t *testing.T) {
	handler := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:   &db.DB{},
		Auth: cloudjournal.UnprovedAuthenticator{},
	}))
	account := uuid.NewString()
	other := uuid.NewString()
	headers := map[string]string{
		"X-Tenant-Id":         other,
		"X-Cloud-Protocol":    "fake",
		"X-Hub-Signature-256": cloudCbCipher,
		"Authorization":       "Bearer " + cloudCbToken,
		"X-Webhook-Secret":    cloudCbCipher,
	}
	body := `{"tenant":"` + other + `","account":"` + other + `","phone":"` + cloudCbPhone + `","secret":"` + cloudCbCipher + `","token":"` + cloudCbToken + `"}`
	first := cloudCbDo(t, handler, http.MethodPost, account+"?hub.challenge="+cloudCbChallenge+"&hub.verify_token="+cloudCbToken+"&tenant="+other, body, headers)
	second := cloudCbDo(t, handler, http.MethodPost, "conta-invalida?hub.challenge="+cloudCbChallenge, body, headers)
	third := cloudCbDo(t, handler, http.MethodPost, uuid.NewString(), "", headers)
	for _, got := range []cloudCbResponse{first, second, third} {
		cloudCbAssertClosed(t, got)
	}
	if !bytes.Equal(first.body, second.body) || !bytes.Equal(first.body, third.body) {
		t.Fatalf("recusa não é uniforme: %s | %s | %s", first.body, second.body, third.body)
	}
	regRouter, regAPI, regRegistry := cloudCbAPI(t)
	registerCloudStatusCallback(regAPI, regRegistry, Service{DB: &db.DB{}})
	viaRegister := cloudCbDo(t, regRouter, http.MethodPost, account, body, headers)
	cloudCbAssertClosed(t, viaRegister)
	if !bytes.Equal(first.body, viaRegister.body) {
		t.Fatalf("registro de produção divergiu: %s", viaRegister.body)
	}
}

func TestCloudStatusCallbackBodyBounds(t *testing.T) {
	handler := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:   &db.DB{},
		Auth: cloudjournal.UnprovedAuthenticator{},
	}))
	account := uuid.NewString()
	exact := strings.Repeat("x", cloudStatusBodyMax)
	over := strings.Repeat("cloudcb-oversize-secret", (cloudStatusBodyMax/len("cloudcb-oversize-secret"))+2)
	if len(over) <= cloudStatusBodyMax {
		t.Fatal("corpo de teste não passou de 4096")
	}
	inside := cloudCbDo(t, handler, http.MethodPost, account, exact, nil)
	cloudCbAssertClosed(t, inside)
	if bytes.Contains(inside.body, []byte(exact[:32])) {
		t.Fatal("corpo no limite foi ecoado")
	}
	outside := cloudCbDo(t, handler, http.MethodPost, account, over, nil)
	if outside.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("limite status=%d body=%s", outside.status, outside.body)
	}
	if bytes.Contains(outside.body, []byte("cloudcb-oversize-secret")) || bytes.Contains(outside.body, []byte(cloudCbCipher)) {
		t.Fatalf("413 ecoou o corpo: %s", outside.body)
	}
}

func TestCloudStatusCallbackNoGetChallenge(t *testing.T) {
	router, api, registry := cloudCbAPI(t)
	registerCloudStatusCallback(api, registry, Service{DB: &db.DB{}})
	handler := http.Handler(router)
	account := uuid.NewString()
	query := account + "?hub.mode=subscribe&hub.challenge=" + cloudCbChallenge + "&hub.verify_token=" + cloudCbToken
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete} {
		got := cloudCbDo(t, handler, method, query, cloudCbChallenge, map[string]string{"X-Hub-Signature-256": cloudCbCipher})
		if got.status == http.StatusOK || got.status == http.StatusNoContent {
			t.Fatalf("%s aceitou status=%d body=%s", method, got.status, got.body)
		}
		cloudCbAssertNoSecrets(t, got)
		if strings.Contains(got.header.Get("Allow"), http.MethodGet) {
			t.Fatalf("%s publicou GET em Allow: %s", method, got.header.Get("Allow"))
		}
	}
}

func TestCloudStatusCallbackFakeIsInstance(t *testing.T) {
	tenantID := uuid.NewString()
	accountID := uuid.NewString()
	other := uuid.NewString()
	resolver := &cloudCbResolver{proven: true, tenant: tenantID}
	decoder := &cloudCbDecoder{proven: true, provider: "cloudcb.missing", raw: "obs-a"}
	auth := &cloudCbAuth{proven: true}
	handler := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		Auth:     auth,
		Decoder:  decoder,
		Resolver: resolver,
	}))
	body := `{"tenant":"` + other + `","account":"` + other + `","phone":"` + cloudCbPhone + `"}`
	headers := map[string]string{"X-Tenant-Id": other, "X-Cloud-Protocol": "fake", "Authorization": "Bearer " + cloudCbToken}
	got := cloudCbDo(t, handler, http.MethodPost, accountID+"?tenant="+other, body, headers)
	cloudCbAssertClosed(t, got)
	if resolver.calls != 1 || resolver.got != accountID {
		t.Fatalf("resolver calls=%d account=%s", resolver.calls, resolver.got)
	}
	if auth.calls == 0 || decoder.calls == 0 {
		t.Fatalf("fake não foi usado auth=%d decoder=%d", auth.calls, decoder.calls)
	}

	blocked := &cloudCbResolver{proven: true, tenant: tenantID}
	noDecoder := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:       &db.DB{},
		Auth:     &cloudCbAuth{proven: true},
		Resolver: blocked,
	}))
	cloudCbAssertClosed(t, cloudCbDo(t, noDecoder, http.MethodPost, accountID, "corpo-opaco", nil))
	if blocked.calls != 0 {
		t.Fatal("sem decoder houve lookup")
	}

	badSig := &cloudCbResolver{proven: true, tenant: tenantID}
	refused := &cloudCbDecoder{proven: true, provider: "cloudcb.missing", raw: "obs-a"}
	deny := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:       &db.DB{},
		Auth:     &cloudCbAuth{proven: true, err: errors.New("assinatura recusada")},
		Decoder:  refused,
		Resolver: badSig,
	}))
	cloudCbAssertClosed(t, cloudCbDo(t, deny, http.MethodPost, accountID, "corpo-opaco", map[string]string{"X-Webhook-Secret": cloudCbCipher}))
	if badSig.calls != 0 || refused.calls != 0 {
		t.Fatalf("assinatura ruim consultou resolver=%d decoder=%d", badSig.calls, refused.calls)
	}

	failed := &cloudCbResolver{proven: true, tenant: tenantID, err: errors.New("conta invisível")}
	lookup := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:       &db.DB{},
		Auth:     &cloudCbAuth{proven: true},
		Decoder:  &cloudCbDecoder{proven: true, provider: "cloudcb.missing", raw: "obs-a"},
		Resolver: failed,
	}))
	cloudCbAssertClosed(t, cloudCbDo(t, lookup, http.MethodPost, accountID, "corpo-opaco-distinto", nil))
	if failed.calls != 1 || failed.got != accountID {
		t.Fatalf("resolver de falha calls=%d account=%s", failed.calls, failed.got)
	}
}

func TestCloudStatusCallbackInstancesDoNotShareState(t *testing.T) {
	spy := &cloudCbResolver{proven: true, tenant: uuid.NewString()}
	fake := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		Auth:     &cloudCbAuth{proven: true},
		Decoder:  &cloudCbDecoder{proven: true, provider: "cloudcb.one", raw: "obs-a"},
		Resolver: spy,
	}))
	prodRouter, prodAPI, prodRegistry := cloudCbAPI(t)
	registerCloudStatusCallback(prodAPI, prodRegistry, Service{DB: &db.DB{}})
	prod := http.Handler(prodRouter)
	account := uuid.NewString()
	var wg sync.WaitGroup
	failures := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got := cloudCbDoRaw(prod, http.MethodPost, account, "opaco", map[string]string{"X-Cloud-Protocol": "fake"})
			if got.status != http.StatusUnauthorized || bytes.Contains(got.body, []byte(cloudCbToken)) {
				failures <- fmt.Sprintf("status=%d body=%s", got.status, got.body)
			}
		}()
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
	if spy.calls != 0 {
		t.Fatal("produção usou o resolver do fake")
	}
	cloudCbAssertClosed(t, cloudCbDo(t, fake, http.MethodPost, account, "opaco-fake", nil))
	if spy.calls != 1 || spy.got != account {
		t.Fatalf("instância fake calls=%d account=%s", spy.calls, spy.got)
	}
	cloudCbAssertClosed(t, cloudCbDo(t, prod, http.MethodPost, uuid.NewString(), "opaco-2", nil))
	if spy.calls != 1 {
		t.Fatal("produção passou a compartilhar estado")
	}
}

func TestCloudStatusCallbackPGDoesNotApproveWABA(t *testing.T) {
	if cloudCbWABAHomologado {
		t.Fatal("WABA não está homologada")
	}
	database, tenantID := cloudCbDatabase(t)
	before := cloudCbReadRows(t, database, tenantID)
	prodRouter, prodAPI, prodRegistry := cloudCbAPI(t)
	registerCloudStatusCallback(prodAPI, prodRegistry, Service{DB: database})
	prod := http.Handler(prodRouter)
	accountID := uuid.NewString()
	body := `{"phone":"` + cloudCbPhone + `","secret":"` + cloudCbCipher + `","token":"` + cloudCbToken + `"}`
	got := cloudCbDo(t, prod, http.MethodPost, accountID, body, map[string]string{
		"X-Tenant-Id":      uuid.NewString(),
		"Authorization":    "Bearer " + cloudCbToken,
		"X-Webhook-Secret": cloudCbCipher,
	})
	cloudCbAssertClosed(t, got)
	if after := cloudCbReadRows(t, database, tenantID); after != before {
		t.Fatalf("produção alterou linhas %#v -> %#v", before, after)
	}

	resolver := &cloudCbResolver{proven: true, tenant: tenantID}
	decoder := &cloudCbDecoder{proven: true, provider: "cloudcb.missing", raw: "obs-a"}
	fake := cloudCbServe(t, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:       database,
		Auth:     &cloudCbAuth{proven: true},
		Decoder:  decoder,
		Resolver: resolver,
	}))
	denied := cloudCbDo(t, fake, http.MethodPost, accountID, "cloudcb-body-not-an-id", nil)
	cloudCbAssertClosed(t, denied)
	if after := cloudCbReadRows(t, database, tenantID); after != before {
		t.Fatalf("transação do webhook commitou %#v -> %#v", before, after)
	}
	if resolver.got != accountID {
		t.Fatalf("tenant da rota não veio da conta %s", resolver.got)
	}
}

type cloudCbResponse struct {
	status int
	body   []byte
	header http.Header
}

type cloudCbAuth struct {
	mu     sync.Mutex
	proven bool
	err    error
	calls  int
}

func (a *cloudCbAuth) Proven() bool { return a.proven }

func (a *cloudCbAuth) Verify(map[string]string, []byte) error {
	a.mu.Lock()
	a.calls++
	err := a.err
	a.mu.Unlock()
	return err
}

type cloudCbDecoder struct {
	mu            sync.Mutex
	proven        bool
	provider, raw string
	calls         int
}

func (d *cloudCbDecoder) DecoderProven() bool { return d.proven }

func (d *cloudCbDecoder) DecodeStatus([]byte) (string, string, error) {
	d.mu.Lock()
	d.calls++
	provider, raw := d.provider, d.raw
	d.mu.Unlock()
	return provider, raw, nil
}

type cloudCbResolver struct {
	mu     sync.Mutex
	proven bool
	tenant string
	err    error
	calls  int
	got    string
}

func (r *cloudCbResolver) Proven() bool { return r.proven }

func (r *cloudCbResolver) ResolveAccount(_ context.Context, accountID string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	r.got = accountID
	return r.tenant, r.err
}

func cloudCbAPI(t *testing.T) (*chi.Mux, huma.API, *endpoint.Registry) {
	t.Helper()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(nil)
	router.Use(registry.Middleware)
	config := huma.DefaultConfig("NexoISP Go", "1.0.0")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	return router, humachi.New(router, config), registry
}

func cloudCbServe(t *testing.T, handler endpoint.Handler) http.Handler {
	t.Helper()
	router, api, registry := cloudCbAPI(t)
	registry.PublicHandle(api, http.MethodPost, cloudStatusPath, handler)
	return router
}

func cloudCbDo(t *testing.T, handler http.Handler, method, account string, body string, headers map[string]string) cloudCbResponse {
	t.Helper()
	return cloudCbDoRaw(handler, method, account, body, headers)
}

func cloudCbDoRaw(handler http.Handler, method, account string, body string, headers map[string]string) cloudCbResponse {
	req := httptest.NewRequest(method, "/api/webhooks/cloud-api/"+account, strings.NewReader(body))
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return cloudCbResponse{status: rec.Code, body: rec.Body.Bytes(), header: rec.Header()}
}

func cloudCbAssertClosed(t *testing.T, got cloudCbResponse) {
	t.Helper()
	if got.status != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", got.status, got.body)
	}
	if !bytes.Contains(got.body, []byte(`"error":"recusado"`)) && !bytes.Contains(got.body, []byte(`"error": "recusado"`)) {
		t.Fatalf("corpo de recusa: %s", got.body)
	}
	cloudCbAssertNoSecrets(t, got)
}

func cloudCbAssertNoSecrets(t *testing.T, got cloudCbResponse) {
	t.Helper()
	text := string(got.body) + "\n" + fmt.Sprint(got.header)
	for _, secret := range []string{cloudCbCipher, cloudCbToken, cloudCbPhone, cloudCbChallenge, "webhook_secret", "token_enc", "v1."} {
		if strings.Contains(text, secret) {
			t.Fatalf("resposta expôs %s em %s", secret, text)
		}
	}
}

func cloudCbAssertOpenAPI(t *testing.T, api huma.API, customRoutes bool) {
	t.Helper()
	found := 0
	for path, item := range api.OpenAPI().Paths {
		if !strings.Contains(path, "cloud-api") {
			continue
		}
		found++
		if path != cloudStatusPath || item == nil || item.Post == nil || item.Get != nil || item.Put != nil || item.Delete != nil || item.Head != nil || item.Patch != nil || item.Options != nil || item.Trace != nil {
			t.Fatalf("OpenAPI cloud-api inesperado em %s", path)
		}
	}
	if found != 1 {
		t.Fatalf("OpenAPI cloud-api=%d", found)
	}
	if customRoutes {
		item := api.OpenAPI().Paths["/api/subscribers/{id}/custom"]
		if item == nil || item.Put == nil {
			t.Fatal("rota genérica de campos custom sumiu")
		}
	}
}

func cloudCbFile(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("origem do teste indisponível")
	}
	return filepath.Join(filepath.Dir(file), "cloud_status_callback.go")
}

func cloudCbModuleRoot(t *testing.T) string {
	t.Helper()
	return filepath.Clean(filepath.Join(filepath.Dir(cloudCbFile(t)), "..", "..", ".."))
}

type cloudCbRowSnap struct {
	status, attempts, logs, payments int
	cents                            int64
}

func cloudCbDatabase(t *testing.T) (*db.DB, string) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_CLOUD_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_CLOUD_PG_REQUIRED=1; PostgreSQL não está aprovado e WABA não está homologada")
		}
		t.Skip("NEXO_GO_TEST_DATABASE_URL ausente; skip offline. Este skip não aprova PostgreSQL nem WABA.")
	}
	if err := cloudCbRejectURL(url); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	opened, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("db.Open falhou; skip não se aplica: %s", cloudCbRedact(err))
	}
	t.Cleanup(opened.Close)
	var name, sessionUser, currentUser, tenantID string
	if err = opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
			return err
		}
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenantID)
	}); err != nil {
		t.Fatalf("identidade do laboratório: %s", cloudCbRedact(err))
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" || tenantID == "" {
		t.Fatalf("conexão fora de nexo_test/nexo_go: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	var statusTable, accountTable, paymentTable, logTable *string
	if err = cloudCbAsApp(ctx, opened, tenantID, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select to_regclass('cloud_notice_status')::text, to_regclass('cloud_accounts')::text, to_regclass('payments')::text, to_regclass('notice_log')::text`).Scan(&statusTable, &accountTable, &paymentTable, &logTable)
	}); err != nil {
		t.Fatalf("schema: %s; PostgreSQL e WABA não estão aprovados", cloudCbRedact(err))
	}
	if statusTable == nil || accountTable == nil || paymentTable == nil || logTable == nil {
		t.Fatal("schema cloud ausente; PostgreSQL e WABA não estão aprovados")
	}
	return opened, tenantID
}

func cloudCbReadRows(t *testing.T, database *db.DB, tenantID string) cloudCbRowSnap {
	t.Helper()
	var rows cloudCbRowSnap
	ctx := context.Background()
	err := cloudCbAsApp(ctx, database, tenantID, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `
select
    (select count(*)::int from cloud_notice_status where tenant_id = app_tenant()),
    (select count(*)::int from cloud_notice_attempts where tenant_id = app_tenant()),
    (select count(*)::int from notice_log where tenant_id = app_tenant()),
    (select count(*)::int from payments where tenant_id = app_tenant()),
    (select coalesce(sum(signed_cents), 0)::bigint from payments where tenant_id = app_tenant())`).Scan(
			&rows.status, &rows.attempts, &rows.logs, &rows.payments, &rows.cents)
	})
	if err != nil {
		t.Fatalf("contagem: %s", cloudCbRedact(err))
	}
	return rows
}

func cloudCbAsApp(ctx context.Context, database *db.DB, tenantID string, fn func(*db.Tx) error) error {
	return database.WithScope(ctx, tenancy.Scope{TenantID: tenantID}, func(tx *db.Tx) error {
		if err := tx.Exec(ctx, `set local role nexo_app`); err != nil {
			return err
		}
		var name, sessionUser, currentUser string
		var super, bypass bool
		if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`).Scan(&name, &sessionUser, &currentUser, &super, &bypass); err != nil {
			return err
		}
		if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_app" || super || bypass {
			return fmt.Errorf("papel recusado: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
		}
		return fn(tx)
	})
}

func cloudCbRejectURL(raw string) error {
	cfg, err := pgx.ParseConfig(raw)
	if err != nil {
		return errors.New("URL de laboratório inválida")
	}
	if cfg.User != "nexo_go" || cfg.Database != "nexo_test" {
		return errors.New("URL recusada; este teste só usa nexo_go em nexo_test")
	}
	return nil
}

func cloudCbRedact(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if url := os.Getenv("NEXO_GO_TEST_DATABASE_URL"); url != "" {
		text = strings.ReplaceAll(text, url, "NEXO_GO_TEST_DATABASE_URL")
	}
	return text
}
