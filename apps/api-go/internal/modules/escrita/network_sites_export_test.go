package escrita

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
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
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

func TestNetworkSitesExportCSVFormat(t *testing.T) {
	// Empty rows: header only with UTF-8 BOM
	emptyCSV := exportSitesCSV(nil)
	if !bytes.HasPrefix(emptyCSV, []byte("\ufeff")) {
		t.Fatal("CSV deve iniciar com UTF-8 BOM")
	}
	expectedEmpty := "\ufeff" + sitesCSVHeader + "\r\n"
	if string(emptyCSV) != expectedEmpty {
		t.Fatalf("CSV vazio incorreto: got %q, want %q", string(emptyCSV), expectedEmpty)
	}

	// Diverse items including injection, special characters, negative coordinates, nulls
	items := []jsonx.Object{
		{
			{Name: "id", Value: "550e8400-e29b-41d4-a716-446655440001"},
			{Name: "kind", Value: "pole"},
			{Name: "name", Value: "Poste 01"},
			{Name: "pop_id", Value: "660e8400-e29b-41d4-a716-446655440002"},
			{Name: "pop_name", Value: "POP Principal"},
			{Name: "city", Value: "São Paulo"},
			{Name: "address", Value: "Av. Paulista, 1000; Sala 1"},
			{Name: "latitude", Value: -23.561684},
			{Name: "longitude", Value: -46.655981},
			{Name: "active", Value: true},
			{Name: "notes", Value: "Nota com \"aspas\" e\r\nquebra"},
		},
		{
			{Name: "id", Value: "550e8400-e29b-41d4-a716-446655440002"},
			{Name: "kind", Value: "tower"},
			{Name: "name", Value: "=SUM(A1:A10)"},
			{Name: "pop_id", Value: "660e8400-e29b-41d4-a716-446655440002"},
			{Name: "pop_name", Value: " +POP Fórmula"},
			{Name: "city", Value: nil},
			{Name: "address", Value: nil},
			{Name: "latitude", Value: nil},
			{Name: "longitude", Value: nil},
			{Name: "active", Value: false},
			{Name: "notes", Value: " \t\r\n@cmd"},
		},
		{
			{Name: "id", Value: "550e8400-e29b-41d4-a716-446655440003"},
			{Name: "kind", Value: "building"},
			{Name: "name", Value: "-Local Negativo"},
			{Name: "pop_id", Value: "660e8400-e29b-41d4-a716-446655440002"},
			{Name: "pop_name", Value: "POP Principal"},
			{Name: "city", Value: "Rio de Janeiro"},
			{Name: "address", Value: "Rua Direita, 20"},
			{Name: "latitude", Value: -22.0},
			{Name: "longitude", Value: -43.0},
			{Name: "active", Value: true},
			{Name: "notes", Value: "+55 11 99999-9999"},
		},
	}

	raw := exportSitesCSV(items)
	if !bytes.HasPrefix(raw, []byte("\ufeff")) {
		t.Fatal("CSV deve iniciar com UTF-8 BOM")
	}

	rawWithoutBOM := strings.TrimPrefix(string(raw), "\ufeff")
	lines := strings.Split(rawWithoutBOM, "\r\n")
	if len(lines) < 4 {
		t.Fatalf("linhas insuficientes: %d", len(lines))
	}
	if lines[0] != sitesCSVHeader {
		t.Fatalf("cabeçalho incorreto: got %q, want %q", lines[0], sitesCSVHeader)
	}

	// Verify standard CSV parsing with semicolon delimiter
	r := csv.NewReader(strings.NewReader(rawWithoutBOM))
	r.Comma = ';'
	r.LazyQuotes = true
	records, err := r.ReadAll()
	if err != nil {
		t.Fatalf("falha ao interpretar CSV com RFC 4180: %v", err)
	}

	if len(records) != 4 {
		t.Fatalf("esperado 4 registros (1 cabeçalho + 3 linhas), obteve %d", len(records))
	}

	// Row 1: normal with quotes and newlines
	rec1 := records[1]
	if rec1[0] != "550e8400-e29b-41d4-a716-446655440001" || rec1[1] != "pole" || rec1[2] != "Poste 01" {
		t.Fatalf("rec1 identificação incorreta: %+v", rec1)
	}
	if rec1[5] != "São Paulo" || rec1[6] != "Av. Paulista, 1000; Sala 1" {
		t.Fatalf("rec1 cidade/endereço incorreto: %+v", rec1)
	}
	if rec1[7] != "-23.561684" || rec1[8] != "-46.655981" {
		t.Fatalf("rec1 coordenadas incorretas: %s, %s", rec1[7], rec1[8])
	}
	if rec1[9] != "true" || !strings.Contains(rec1[10], "Nota com \"aspas\" e") {
		t.Fatalf("rec1 ativo/observacoes incorreto: %+v", rec1)
	}
	if !strings.Contains(rawWithoutBOM, "\"Nota com \"\"aspas\"\" e\r\nquebra\"") {
		t.Fatalf("raw CSV não preservou aspas duplas e CRLF: %s", rawWithoutBOM)
	}

	// Row 2: injection protection and null fields
	rec2 := records[2]
	if rec2[1] != "tower" {
		t.Fatalf("rec2 tipo incorreto: %s", rec2[1])
	}
	if rec2[2] != "'=SUM(A1:A10)" {
		t.Fatalf("rec2 injeção de fórmula não prefixada com apóstrofo: %q", rec2[2])
	}
	if rec2[4] != "' +POP Fórmula" {
		t.Fatalf("rec2 pop com leading + não prefixado: %q", rec2[4])
	}
	if rec2[5] != "" || rec2[6] != "" {
		t.Fatalf("rec2 campos nulos não vazios: %q, %q", rec2[5], rec2[6])
	}
	if rec2[7] != "" || rec2[8] != "" {
		t.Fatalf("rec2 coordenadas nulas não vazias: %q, %q", rec2[7], rec2[8])
	}
	if rec2[9] != "false" {
		t.Fatalf("rec2 ativo incorreto: %s", rec2[9])
	}
	if !strings.HasPrefix(rec2[10], "'") || !strings.Contains(rec2[10], "@cmd") {
		t.Fatalf("rec2 notas com @ não prefixadas: %q", rec2[10])
	}
	if !strings.Contains(rawWithoutBOM, "\"' \t\r\n@cmd\"") {
		t.Fatalf("raw CSV não preservou apóstrofo e CRLF em notas: %s", rawWithoutBOM)
	}

	// Row 3: negative coordinates must remain numeric (NOT prefixed with apostrophe)
	rec3 := records[3]
	if rec3[2] != "'-Local Negativo" {
		t.Fatalf("rec3 texto começando com hífen deve ser prefixado: %q", rec3[2])
	}
	if rec3[7] != "-22" || rec3[8] != "-43" {
		t.Fatalf("rec3 coordenadas negativas devem permanecer numéricas: lat=%q, lon=%q", rec3[7], rec3[8])
	}
	if strings.HasPrefix(rec3[7], "'") || strings.HasPrefix(rec3[8], "'") {
		t.Fatalf("rec3 coordenadas não devem conter apóstrofo: lat=%q, lon=%q", rec3[7], rec3[8])
	}
	if rec3[10] != "'+55 11 99999-9999" {
		t.Fatalf("rec3 telefone começando com + deve ser prefixado: %q", rec3[10])
	}
}

func TestNetworkSitesExportQueryValidation(t *testing.T) {
	// Rejection of unknown query params
	if _, err := siteQuery("foo=bar"); err == nil {
		t.Fatal("esperava erro para query param desconhecido")
	}
	// Rejection of repeated query params
	if _, err := siteQuery("limit=10&limit=20"); err == nil {
		t.Fatal("esperava erro para query param repetido")
	}
	// Limit boundary
	if _, err := siteQuery("limit=0"); err == nil {
		t.Fatal("esperava erro para limit 0")
	}
	if _, err := siteQuery("limit=101"); err == nil {
		t.Fatal("esperava erro para limit > 100")
	}
	// Valid limit
	f, err := siteQuery("limit=100&offset=50&status=all&kind=pole")
	if err != nil {
		t.Fatalf("consulta válida rejeitada: %v", err)
	}
	if f.limit != 100 || f.offset != 50 || f.status != "all" || f.kind != "pole" {
		t.Fatalf("filtro parseado incorretamente: %+v", f)
	}
}

func TestNetworkSitesExportStaticRouteNoUUIDConflict(t *testing.T) {
	// Verify that GET /api/network/sites/export.csv does NOT hit the /{id} route
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	actor := &auth.Ctx{
		UserID:      uuid.NewString(),
		TenantID:    "tenant-1",
		Role:        "admin",
		Permissions: auth.Permissions["admin"],
		ExpiresAt:   time.Now().Add(time.Hour),
		Scope:       tenancy.Scope{TenantID: "tenant-1"},
	}
	a, err := auth.New(ftthLoader{map[string]*auth.Ctx{ftthHash("token"): actor}}, 0, false, 100, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()

	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	cfg := huma.DefaultConfig("sites", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""

	registerNetworkSites(humachi.New(router, cfg), registry, Service{})

	// Unauthenticated request to /api/network/sites/export.csv must be stopped by auth middleware with 401,
	// never routed to /{id} with 400 "UUID inválido"
	req := httptest.NewRequest("GET", "/api/network/sites/export.csv", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != 401 {
		t.Fatalf("esperado 401 não autenticado, obteve %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "UUID") {
		t.Fatalf("rota estática export.csv caiu no validador UUID de /{id}: %s", rec.Body.String())
	}
}

func TestNetworkSitesExportPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_SITES_CSV_PG_REQUIRED") == "1" {
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

	var database, session string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select current_database(),session_user::text`).Scan(&database, &session)
	})
	if err != nil || database != "nexo_test" || session != "nexo_go" {
		t.Fatalf("requer nexo_test/nexo_go: %s %s %v", database, session, err)
	}

	op, _ := tenancy.OperatorScope("gerenciar_provedores")
	tenants := []string{uuid.NewString(), uuid.NewString()}
	pops := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	err = d.WithScope(ctx, op, func(tx *db.Tx) error {
		for _, id := range tenants {
			if e := tx.Exec(ctx, `insert into tenants(id,name,slug) values($1,'Teste locais CSV',$2)`, id, "sites-csv-"+strings.ReplaceAll(id, "-", "")); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := d.WithScope(ctx, op, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update tenants set status='suspended' where id=any($1::uuid[])`, tenants)
		}); e != nil {
			t.Error(e)
		}
	})

	for i, id := range pops {
		tenant := tenants[0]
		if i == 2 {
			tenant = tenants[1]
		}
		err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			return tx.Exec(ctx, `insert into pops(id,tenant_id,name) values($1,$2,$3)`, id, tenant, "POP "+id[:8])
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user, sub string, ps []string) {
		actors[ftthHash(token)] = &auth.Ctx{
			UserID:       user,
			TenantID:     tenant,
			Role:         role,
			SubscriberID: sub,
			PopIDs:       ps,
			Permissions:  auth.Permissions[role],
			ExpiresAt:    time.Now().Add(time.Hour),
			Scope:        tenancy.Scope{TenantID: tenant, SubscriberID: sub, PopIDs: ps},
		}
	}
	add("a", tenants[0], "admin", uuid.NewString(), "", nil)
	add("b", tenants[1], "admin", uuid.NewString(), "", nil)
	add("limited", tenants[0], "noc", uuid.NewString(), "", pops[:1])
	add("read", tenants[0], "attendant", uuid.NewString(), "", nil)
	add("portal", tenants[0], "subscriber", uuid.NewString(), uuid.NewString(), nil)

	a, err := auth.New(ftthLoader{actors}, 0, false, 100, prometheus.NewRegistry())
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
	cfg := huma.DefaultConfig("sites", "1")
	cfg.CreateHooks = nil
	cfg.OpenAPIPath = ""
	cfg.DocsPath = ""
	cfg.SchemasPath = ""
	registerNetworkSites(humachi.New(router, cfg), registry, Service{DB: d})

	call := func(token, method, path string, body any, want int) *httptest.ResponseRecorder {
		t.Helper()
		var rdr *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rdr = bytes.NewReader(b)
		} else {
			rdr = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, rdr)
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

	base := "/api/network/sites"
	exportBase := "/api/network/sites/export.csv"

	// Create test sites
	siteBody1 := map[string]any{
		"pop_id":    pops[0],
		"kind":      "pole",
		"name":      "Poste =1+1",
		"notes":     "-observacao",
		"latitude":  -22.9068,
		"longitude": -43.1729,
		"city":      "Rio de Janeiro",
		"address":   "Rua A, 100",
	}
	rec1 := call("a", "POST", base, siteBody1, 200)
	var site1 map[string]any
	if e := json.Unmarshal(rec1.Body.Bytes(), &site1); e != nil {
		t.Fatal(e)
	}
	site1ID := site1["id"].(string)

	siteBody2 := map[string]any{
		"pop_id": pops[0],
		"kind":   "tower",
		"name":   "=1+1 Torre",
		"notes":  "=SOMA(1,2)",
	}
	rec2 := call("a", "POST", base, siteBody2, 200)
	var site2 map[string]any
	if e := json.Unmarshal(rec2.Body.Bytes(), &site2); e != nil {
		t.Fatal(e)
	}
	site2ID := site2["id"].(string)

	siteBody3 := map[string]any{
		"pop_id": pops[1],
		"kind":   "building",
		"name":   "Edifício Oculto",
		"notes":  "nota simples",
	}
	rec3 := call("a", "POST", base, siteBody3, 200)
	var site3 map[string]any
	if e := json.Unmarshal(rec3.Body.Bytes(), &site3); e != nil {
		t.Fatal(e)
	}
	site3ID := site3["id"].(string)

	// Auth and permissions
	call("", "GET", exportBase, nil, 401)
	call("portal", "GET", exportBase, nil, 403)
	call("read", "GET", exportBase, nil, 200)
	call("limited", "GET", exportBase+"?pop_id="+pops[1], nil, 404) // hidden POP

	type siteJSONItem struct {
		ID        string   `json:"id"`
		Kind      string   `json:"kind"`
		Name      string   `json:"name"`
		PopID     string   `json:"pop_id"`
		PopName   string   `json:"pop_name"`
		City      *string  `json:"city"`
		Address   *string  `json:"address"`
		Latitude  *float64 `json:"latitude"`
		Longitude *float64 `json:"longitude"`
		Active    bool     `json:"active"`
		Notes     *string  `json:"notes"`
	}
	type jsonResultType struct {
		Items  []siteJSONItem `json:"items"`
		Total  int            `json:"total"`
		Limit  int            `json:"limit"`
		Offset int            `json:"offset"`
	}

	assertParity := func(token, qs string) ([][]string, jsonResultType, string) {
		t.Helper()
		jsonRec := call(token, "GET", base+qs, nil, 200)
		var jr jsonResultType
		if err := json.Unmarshal(jsonRec.Body.Bytes(), &jr); err != nil {
			t.Fatalf("falha ao decodificar JSON para %s: %v", qs, err)
		}

		csvRec := call(token, "GET", exportBase+qs, nil, 200)
		if ct := csvRec.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
			t.Fatalf("Content-Type incorreto para %s: %s", qs, ct)
		}
		if cd := csvRec.Header().Get("Content-Disposition"); cd != `attachment; filename="locais-infraestrutura-pagina.csv"` {
			t.Fatalf("Content-Disposition incorreto para %s: %s", qs, cd)
		}
		if cc := csvRec.Header().Get("Cache-Control"); cc != "private, no-store" {
			t.Fatalf("Cache-Control incorreto para %s: %s", qs, cc)
		}
		if totalH := csvRec.Header().Get("X-Total-Count"); totalH != strconv.Itoa(jr.Total) {
			t.Fatalf("X-Total-Count divergente para %s: got %q want %d", qs, totalH, jr.Total)
		}

		csvBody := csvRec.Body.String()
		if !strings.HasPrefix(csvBody, "\ufeff") {
			t.Fatalf("CSV sem UTF-8 BOM para %s", qs)
		}

		r := csv.NewReader(strings.NewReader(strings.TrimPrefix(csvBody, "\ufeff")))
		r.Comma = ';'
		r.LazyQuotes = true
		records, err := r.ReadAll()
		if err != nil {
			t.Fatalf("falha ao interpretar CSV para %s: %v", qs, err)
		}

		if len(records) == 0 {
			t.Fatalf("CSV não possui cabeçalho para %s", qs)
		}
		expectedCols := strings.Split(sitesCSVHeader, ";")
		if !slices.Equal(records[0], expectedCols) {
			t.Fatalf("cabeçalho divergente para %s: got %+v, want %+v", qs, records[0], expectedCols)
		}

		if len(records) != len(jr.Items)+1 {
			t.Fatalf("quantidade de linhas divergente do JSON para %s: got %d rows, want %d", qs, len(records), len(jr.Items)+1)
		}

		for i, item := range jr.Items {
			row := records[i+1]
			if row[0] != item.ID {
				t.Fatalf("linha %d ID divergente para %s: got %s, want %s", i, qs, row[0], item.ID)
			}
			if row[1] != item.Kind {
				t.Fatalf("linha %d Kind divergente para %s: got %s, want %s", i, qs, row[1], item.Kind)
			}
			expectedName := item.Name
			trimmedName := strings.TrimLeft(expectedName, " \t\r\n")
			if trimmedName != "" && strings.ContainsAny(trimmedName[:1], "=+-@") {
				expectedName = "'" + expectedName
			}
			if row[2] != expectedName {
				t.Fatalf("linha %d Local divergente para %s: got %s, want %s", i, qs, row[2], expectedName)
			}
			if row[3] != item.PopID {
				t.Fatalf("linha %d PopID divergente para %s: got %s, want %s", i, qs, row[3], item.PopID)
			}
			if row[4] != item.PopName {
				t.Fatalf("linha %d PopName divergente para %s: got %s, want %s", i, qs, row[4], item.PopName)
			}
			expectedCity := ""
			if item.City != nil {
				expectedCity = *item.City
				tCity := strings.TrimLeft(expectedCity, " \t\r\n")
				if tCity != "" && strings.ContainsAny(tCity[:1], "=+-@") {
					expectedCity = "'" + expectedCity
				}
			}
			if row[5] != expectedCity {
				t.Fatalf("linha %d City divergente para %s: got %s, want %s", i, qs, row[5], expectedCity)
			}
			expectedAddress := ""
			if item.Address != nil {
				expectedAddress = *item.Address
				tAddr := strings.TrimLeft(expectedAddress, " \t\r\n")
				if tAddr != "" && strings.ContainsAny(tAddr[:1], "=+-@") {
					expectedAddress = "'" + expectedAddress
				}
			}
			if row[6] != expectedAddress {
				t.Fatalf("linha %d Address divergente para %s: got %s, want %s", i, qs, row[6], expectedAddress)
			}
			expectedLat := ""
			if item.Latitude != nil {
				expectedLat = strconv.FormatFloat(*item.Latitude, 'f', -1, 64)
			}
			if row[7] != expectedLat {
				t.Fatalf("linha %d Latitude divergente para %s: got %s, want %s", i, qs, row[7], expectedLat)
			}
			expectedLon := ""
			if item.Longitude != nil {
				expectedLon = strconv.FormatFloat(*item.Longitude, 'f', -1, 64)
			}
			if row[8] != expectedLon {
				t.Fatalf("linha %d Longitude divergente para %s: got %s, want %s", i, qs, row[8], expectedLon)
			}
			if row[9] != strconv.FormatBool(item.Active) {
				t.Fatalf("linha %d Active divergente para %s: got %s, want %t", i, qs, row[9], item.Active)
			}
			expectedNotes := ""
			if item.Notes != nil {
				expectedNotes = *item.Notes
				tNotes := strings.TrimLeft(expectedNotes, " \t\r\n")
				if tNotes != "" && strings.ContainsAny(tNotes[:1], "=+-@") {
					expectedNotes = "'" + expectedNotes
				}
			}
			if row[10] != expectedNotes {
				t.Fatalf("linha %d Notes divergente para %s: got %s, want %s", i, qs, row[10], expectedNotes)
			}
		}

		if len(jr.Items) == 0 {
			if csvBody != "\ufeff"+sitesCSVHeader+"\r\n" {
				t.Fatalf("página vazia para %s deve conter apenas header e BOM: got %q", qs, csvBody)
			}
		}

		return records, jr, csvBody
	}

	// Snapshot comparison between JSON and CSV
	recordsAll, jrAll, csvBody := assertParity("a", "?status=all")

	// Verify numeric negative coordinates (without apostrophe)
	if !strings.Contains(csvBody, "-22.9068") || !strings.Contains(csvBody, "-43.1729") {
		t.Fatalf("coordenadas numéricas não encontradas: %s", csvBody)
	}
	if strings.Contains(csvBody, "'-22.9068") || strings.Contains(csvBody, "'-43.1729") {
		t.Fatalf("coordenada negativa foi indevidamente prefixada com apóstrofo: %s", csvBody)
	}

	// Verify text cells starting with = or - are prefixed, while internal = is preserved without prefix
	if !strings.Contains(csvBody, "'=1+1") {
		t.Fatalf("fórmula '=1+1' não foi prefixada com apóstrofo: %s", csvBody)
	}
	if !strings.Contains(csvBody, "'-observacao") {
		t.Fatalf("nota '-observacao' não foi prefixada com apóstrofo: %s", csvBody)
	}
	if !strings.Contains(csvBody, "\"Poste =1+1\"") {
		t.Fatalf("texto com '=' interno deve ser preservado sem apóstrofo: %s", csvBody)
	}
	if strings.Contains(csvBody, "'Poste =1+1") {
		t.Fatalf("texto com '=' interno foi indevidamente prefixado com apóstrofo: %s", csvBody)
	}

	// Verify specific cell content in parsed records
	var foundSite1, foundSite2 bool
	for _, row := range recordsAll[1:] {
		if row[0] == site1ID {
			foundSite1 = true
			if row[2] != "Poste =1+1" {
				t.Fatalf("célula com '=' interno não deve ter apóstrofo: got %q, want %q", row[2], "Poste =1+1")
			}
			if row[10] != "'-observacao" {
				t.Fatalf("célula com '-' inicial deve ter apóstrofo: got %q, want %q", row[10], "'-observacao")
			}
		}
		if row[0] == site2ID {
			foundSite2 = true
			if row[2] != "'=1+1 Torre" {
				t.Fatalf("célula com '=' inicial deve ter apóstrofo: got %q, want %q", row[2], "'=1+1 Torre")
			}
			if row[10] != "'=SOMA(1,2)" {
				t.Fatalf("célula de notas com '=' inicial deve ter apóstrofo: got %q, want %q", row[10], "'=SOMA(1,2)")
			}
		}
	}
	if !foundSite1 || !foundSite2 {
		t.Fatalf("site1 ou site2 não encontrados nos registros: foundSite1=%v, foundSite2=%v", foundSite1, foundSite2)
	}

	// Pagination limit & offset parity: verify exact ID for offset=1
	pagedRecords, jrPaged, _ := assertParity("a", "?status=all&limit=1&offset=1")
	if len(jrPaged.Items) != 1 {
		t.Fatalf("esperado 1 item no JSON para limit=1&offset=1, obteve %d", len(jrPaged.Items))
	}
	if pagedRecords[1][0] != site1ID || jrPaged.Items[0].ID != site1ID {
		t.Fatalf("offset=1 deve retornar exatamente site1ID (%s): CSV=%s, JSON=%s", site1ID, pagedRecords[1][0], jrPaged.Items[0].ID)
	}
	if pagedRecords[1][0] != jrAll.Items[1].ID {
		t.Fatalf("offset=1 deve corresponder ao segundo item do conjunto total: got %s, want %s", pagedRecords[1][0], jrAll.Items[1].ID)
	}

	// Empty page beyond total
	emptyRecords, jrEmpty, _ := assertParity("a", "?status=all&offset=1000")
	if len(jrEmpty.Items) != 0 || len(emptyRecords) != 1 {
		t.Fatalf("página vazia além do total deve ter 0 itens: JSON=%d, CSV=%d", len(jrEmpty.Items), len(emptyRecords)-1)
	}
	if jrEmpty.Total != jrAll.Total {
		t.Fatalf("X-Total-Count em página além do total incorreto: got %d want %d", jrEmpty.Total, jrAll.Total)
	}

	// Representative filters: q
	qRecords, _, _ := assertParity("a", "?q=Poste")
	if len(qRecords) != 2 || qRecords[1][0] != site1ID {
		t.Fatalf("filtro q=Poste deve retornar apenas site1ID (%s), obteve: %+v", site1ID, qRecords)
	}

	// Representative filters: pop_id
	popRecords, _, _ := assertParity("a", "?pop_id="+pops[0]+"&status=all")
	if len(popRecords) != 3 {
		t.Fatalf("filtro pop_id deve retornar 2 itens de pops[0], obteve %d", len(popRecords)-1)
	}

	// Representative filters: kind
	towerRecords, _, _ := assertParity("a", "?kind=tower&status=all")
	if len(towerRecords) != 2 || towerRecords[1][0] != site2ID {
		t.Fatalf("filtro kind=tower deve retornar apenas site2ID (%s), obteve: %+v", site2ID, towerRecords)
	}

	// Representative filters: status (archive site3 and test active vs archived vs all)
	call("a", "PATCH", base+"/"+site3ID, map[string]any{"active": false}, 200)

	activeRecords, _, _ := assertParity("a", "?status=active")
	if len(activeRecords) != 3 {
		t.Fatalf("status=active deve retornar 2 itens ativos, obteve %d", len(activeRecords)-1)
	}
	for _, r := range activeRecords[1:] {
		if r[0] == site3ID {
			t.Fatalf("status=active não deve incluir site3 inativo")
		}
	}

	archivedRecords, _, _ := assertParity("a", "?status=archived")
	if len(archivedRecords) != 2 || archivedRecords[1][0] != site3ID {
		t.Fatalf("status=archived deve retornar exatamente 1 item arquivado (site3ID %s)", site3ID)
	}

	// Maximum contractual limit
	limitRecords, _, _ := assertParity("a", "?status=all&limit=100")
	if len(limitRecords) != len(recordsAll) {
		t.Fatalf("limit=100 deve retornar todos os itens da página")
	}

	// Boundary limit rejection
	call("a", "GET", exportBase+"?limit=101", nil, 400)

	// Tenant isolation: tenant b sees 0 sites
	tenantBRecords, _, _ := assertParity("b", "?status=all")
	if len(tenantBRecords) != 1 {
		t.Fatalf("tenant B deve ter 0 registros, obteve %d", len(tenantBRecords)-1)
	}

	// Limited actor: sees only site1 and site2, not site3
	limitedRecords, _, _ := assertParity("limited", "?status=all")
	if len(limitedRecords) != 3 {
		t.Fatalf("limited actor deve ver exatamente 2 sites de pops[0], obteve %d", len(limitedRecords)-1)
	}
	for _, r := range limitedRecords[1:] {
		if r[0] == site3ID {
			t.Fatalf("limited actor viu site de POP oculto: %s", r[0])
		}
	}
}
