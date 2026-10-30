package escrita

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestStockQuotationExportEncoder(t *testing.T) {
	quoteID := uuid.NewString()
	itemID1 := uuid.NewString()
	itemID2 := uuid.NewString()
	supplierID1 := uuid.NewString()
	supplierID2 := uuid.NewString()

	t.Run("empty offers produces empty supplier and price cells without 0", func(t *testing.T) {
		row := jsonx.Object{
			{Name: "id", Value: quoteID},
			{Name: "title", Value: "Cotação Sem Ofertas"},
			{Name: "status", Value: "draft"},
			{Name: "purchase_order_id", Value: nil},
			{Name: "items", Value: []any{
				jsonx.Object{
					{Name: "item_id", Value: itemID1},
					{Name: "item_name", Value: "Item 1"},
					{Name: "unit", Value: "un"},
					{Name: "qty", Value: 5},
				},
				jsonx.Object{
					{Name: "item_id", Value: itemID2},
					{Name: "item_name", Value: "Item 2"},
					{Name: "unit", Value: "cx"},
					{Name: "qty", Value: 10},
				},
			}},
			{Name: "offers", Value: []any{}},
		}

		data, err := quotationCSV(row)
		if err != nil {
			t.Fatalf("quotationCSV: %v", err)
		}

		if !bytes.HasPrefix(data, []byte("\xef\xbb\xbf")) {
			t.Fatal("esperado BOM UTF-8 no início do CSV")
		}

		r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
		r.Comma = ';'
		records, err := r.ReadAll()
		if err != nil {
			t.Fatalf("erro ao ler CSV: %v", err)
		}

		if len(records) != 3 { // header + 2 items
			t.Fatalf("esperado 3 registros (header + 2 itens), obtido %d", len(records))
		}

		expectedCols := strings.Split(quotationCSVColumns, ";")
		if len(records[0]) != len(expectedCols) {
			t.Fatalf("esperado %d colunas, obtido %d", len(expectedCols), len(records[0]))
		}
		for i, col := range expectedCols {
			if records[0][i] != col {
				t.Fatalf("coluna %d: esperado %s, obtido %s", i, col, records[0][i])
			}
		}

		for i, rec := range records[1:] {
			if rec[0] != quoteID {
				t.Errorf("linha %d: cotacao_id esperado %s, obtido %s", i, quoteID, rec[0])
			}
			if rec[1] != "Cotação Sem Ofertas" {
				t.Errorf("linha %d: cotacao esperado 'Cotação Sem Ofertas', obtido %s", i, rec[1])
			}
			if rec[2] != "draft" {
				t.Errorf("linha %d: status esperado 'draft', obtido %s", i, rec[2])
			}
			if rec[3] != "" {
				t.Errorf("linha %d: fornecedor_id deve ser vazio, obtido %s", i, rec[3])
			}
			if rec[4] != "" {
				t.Errorf("linha %d: fornecedor deve ser vazio, obtido %s", i, rec[4])
			}
			if rec[9] != "" {
				t.Errorf("linha %d: preco_unitario_centavos deve ser vazio (não 0), obtido %s", i, rec[9])
			}
			if rec[10] != "" {
				t.Errorf("linha %d: subtotal_centavos deve ser vazio (não 0), obtido %s", i, rec[10])
			}
			if rec[11] != "" {
				t.Errorf("linha %d: pedido_id deve ser vazio, obtido %s", i, rec[11])
			}
		}

		if records[1][8] != "5" || records[2][8] != "10" {
			t.Errorf("quantidades esperadas '5' e '10', obtido %s e %s", records[1][8], records[2][8])
		}
	})

	t.Run("offers and items deterministic order and exact subtotal sums", func(t *testing.T) {
		row := jsonx.Object{
			{Name: "id", Value: quoteID},
			{Name: "title", Value: "Cotação Comparativa"},
			{Name: "status", Value: "draft"},
			{Name: "purchase_order_id", Value: nil},
			{Name: "items", Value: []any{
				jsonx.Object{
					{Name: "item_id", Value: itemID1},
					{Name: "item_name", Value: "Item A"},
					{Name: "unit", Value: "un"},
					{Name: "qty", Value: int64(1000000)},
				},
				jsonx.Object{
					{Name: "item_id", Value: itemID2},
					{Name: "item_name", Value: "Item B"},
					{Name: "unit", Value: "m"},
					{Name: "qty", Value: int64(500)},
				},
			}},
			{Name: "offers", Value: []any{
				jsonx.Object{
					{Name: "id", Value: uuid.NewString()},
					{Name: "supplier_id", Value: supplierID1},
					{Name: "supplier_name", Value: "Fornecedor Alfa"},
					{Name: "prices", Value: []any{
						jsonx.Object{{Name: "item_id", Value: itemID1}, {Name: "unit_cost_cents", Value: int64(100000000)}},
						jsonx.Object{{Name: "item_id", Value: itemID2}, {Name: "unit_cost_cents", Value: int64(250)}},
					}},
					{Name: "total_cents", Value: int64(100000000000000) + int64(500*250)},
				},
				jsonx.Object{
					{Name: "id", Value: uuid.NewString()},
					{Name: "supplier_id", Value: supplierID2},
					{Name: "supplier_name", Value: "Fornecedor Beta"},
					{Name: "prices", Value: []any{
						jsonx.Object{{Name: "item_id", Value: itemID1}, {Name: "unit_cost_cents", Value: int64(95000000)}},
						jsonx.Object{{Name: "item_id", Value: itemID2}, {Name: "unit_cost_cents", Value: int64(300)}},
					}},
					{Name: "total_cents", Value: int64(1000000)*int64(95000000) + int64(500*300)},
				},
			}},
		}

		data, err := quotationCSV(row)
		if err != nil {
			t.Fatalf("quotationCSV: %v", err)
		}

		r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
		r.Comma = ';'
		records, err := r.ReadAll()
		if err != nil {
			t.Fatalf("csv.ReadAll: %v", err)
		}

		// 1 header + 2 offers * 2 items = 5 rows
		if len(records) != 5 {
			t.Fatalf("esperado 5 registros, obtido %d", len(records))
		}

		// Row 1: Alfa - Item A
		r1 := records[1]
		if r1[4] != "Fornecedor Alfa" || r1[6] != "Item A" || r1[8] != "1000000" || r1[9] != "100000000" || r1[10] != "100000000000000" {
			t.Errorf("linha 1 inesperada: %v", r1)
		}
		// Row 2: Alfa - Item B
		r2 := records[2]
		if r2[4] != "Fornecedor Alfa" || r2[6] != "Item B" || r2[8] != "500" || r2[9] != "250" || r2[10] != "125000" {
			t.Errorf("linha 2 inesperada: %v", r2)
		}
		subtotal1, _ := strconv.ParseInt(r1[10], 10, 64)
		subtotal2, _ := strconv.ParseInt(r2[10], 10, 64)
		if subtotal1+subtotal2 != 100000000125000 {
			t.Errorf("soma subtotais Alfa %d != total_cents", subtotal1+subtotal2)
		}

		// Row 3: Beta - Item A
		r3 := records[3]
		if r3[4] != "Fornecedor Beta" || r3[6] != "Item A" || r3[8] != "1000000" || r3[9] != "95000000" || r3[10] != "95000000000000" {
			t.Errorf("linha 3 inesperada: %v", r3)
		}
		// Row 4: Beta - Item B
		r4 := records[4]
		if r4[4] != "Fornecedor Beta" || r4[6] != "Item B" || r4[8] != "500" || r4[9] != "300" || r4[10] != "150000" {
			t.Errorf("linha 4 inesperada: %v", r4)
		}
		subtotal3, _ := strconv.ParseInt(r3[10], 10, 64)
		subtotal4, _ := strconv.ParseInt(r4[10], 10, 64)
		if subtotal3+subtotal4 != 95000000150000 {
			t.Errorf("soma subtotais Beta %d != total_cents", subtotal3+subtotal4)
		}
	})

	t.Run("security escaping and injection mitigation", func(t *testing.T) {
		row := jsonx.Object{
			{Name: "id", Value: quoteID},
			{Name: "title", Value: " =cmd|' /C calc'!A0"},
			{Name: "status", Value: "draft"},
			{Name: "purchase_order_id", Value: nil},
			{Name: "items", Value: []any{
				jsonx.Object{
					{Name: "item_id", Value: itemID1},
					{Name: "item_name", Value: "\t+55119999; \"Cabo\" & Fibra\r\nNova Linha"},
					{Name: "unit", Value: "@cx"},
					{Name: "qty", Value: 10},
				},
				jsonx.Object{
					{Name: "item_id", Value: itemID2},
					{Name: "item_name", Value: "-Item com traço"},
					{Name: "unit", Value: "un"},
					{Name: "qty", Value: 20},
				},
			}},
			{Name: "offers", Value: []any{
				jsonx.Object{
					{Name: "id", Value: uuid.NewString()},
					{Name: "supplier_id", Value: supplierID1},
					{Name: "supplier_name", Value: "=Fornecedor Fórmula"},
					{Name: "prices", Value: []any{
						jsonx.Object{{Name: "item_id", Value: itemID1}, {Name: "unit_cost_cents", Value: int64(100)}},
						jsonx.Object{{Name: "item_id", Value: itemID2}, {Name: "unit_cost_cents", Value: int64(200)}},
					}},
				},
			}},
		}

		data, err := quotationCSV(row)
		if err != nil {
			t.Fatalf("quotationCSV: %v", err)
		}

		r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
		r.Comma = ';'
		records, err := r.ReadAll()
		if err != nil {
			t.Fatalf("csv.ReadAll falhou no parsing de injeção/caracteres especiais: %v", err)
		}

		if len(records) != 3 {
			t.Fatalf("esperado 3 registros, obtido %d", len(records))
		}

		// cotacao starts with whitespace then '=', must be prefixed with apostrophe
		if !strings.HasPrefix(records[1][1], "' ") || !strings.Contains(records[1][1], "=cmd") {
			t.Errorf("cotacao deveria ter prefixo apóstrofo: %q", records[1][1])
		}

		// supplier starts with '=', must be prefixed with apostrophe
		if records[1][4] != "'=Fornecedor Fórmula" {
			t.Errorf("fornecedor deveria ter prefixo apóstrofo: %q", records[1][4])
		}

		// item 1 starts with tab then '+', has quotes, semicolon, and newline
		if !strings.HasPrefix(records[1][6], "'\t+") {
			t.Errorf("item 1 deveria ter prefixo apóstrofo preservando tab: %q", records[1][6])
		}
		if !strings.Contains(records[1][6], "\"Cabo\"") || !strings.Contains(records[1][6], "\n") {
			t.Errorf("item 1 deveria preservar aspas e newline: %q", records[1][6])
		}
		if !bytes.Contains(data, []byte("\r\n")) {
			t.Errorf("dados brutos devem conter CRLF")
		}

		// item 1 unit starts with '@', must be prefixed with apostrophe
		if records[1][7] != "'@cx" {
			t.Errorf("unidade @cx deveria ter prefixo apóstrofo: %q", records[1][7])
		}

		// item 2 starts with '-', must be prefixed with apostrophe
		if records[2][6] != "'-Item com traço" {
			t.Errorf("item 2 deveria ter prefixo apóstrofo: %q", records[2][6])
		}

		// Numerals and IDs must NOT have apostrophe
		if strings.HasPrefix(records[1][0], "'") || strings.HasPrefix(records[1][3], "'") || strings.HasPrefix(records[1][5], "'") {
			t.Errorf("UUIDs não devem ter prefixo apóstrofo")
		}
		if strings.HasPrefix(records[1][8], "'") || strings.HasPrefix(records[1][9], "'") || strings.HasPrefix(records[1][10], "'") {
			t.Errorf("Valores numéricos não devem ter prefixo apóstrofo")
		}
	})

	t.Run("rows limit capped at 300", func(t *testing.T) {
		var manyItems []any
		for i := 0; i < 35; i++ {
			manyItems = append(manyItems, jsonx.Object{
				{Name: "item_id", Value: uuid.NewString()},
				{Name: "item_name", Value: fmt.Sprintf("Item %d", i)},
				{Name: "unit", Value: "un"},
				{Name: "qty", Value: 1},
			})
		}
		var manyOffers []any
		for i := 0; i < 15; i++ {
			manyOffers = append(manyOffers, jsonx.Object{
				{Name: "id", Value: uuid.NewString()},
				{Name: "supplier_id", Value: uuid.NewString()},
				{Name: "supplier_name", Value: fmt.Sprintf("Fornecedor %d", i)},
				{Name: "prices", Value: []any{}},
			})
		}

		row := jsonx.Object{
			{Name: "id", Value: quoteID},
			{Name: "title", Value: "Muitos Itens"},
			{Name: "status", Value: "draft"},
			{Name: "items", Value: manyItems},
			{Name: "offers", Value: manyOffers},
		}

		data, err := quotationCSV(row)
		if err != nil {
			t.Fatalf("quotationCSV: %v", err)
		}

		r := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))))
		r.Comma = ';'
		records, err := r.ReadAll()
		if err != nil {
			t.Fatalf("csv.ReadAll: %v", err)
		}

		dataRows := len(records) - 1 // minus header
		if dataRows > 300 {
			t.Fatalf("linhas de dados excederam o limite contratual de 300: %d", dataRows)
		}
		if dataRows != 300 {
			t.Fatalf("esperado exatamente 300 linhas de dados pelo cap, obtido %d", dataRows)
		}
	})
}

func TestStockQuotationExportPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_QUOTES_CSV_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente")
		}
		t.Skip("PostgreSQL ausente; contrato SQL não comprovado")
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
		if e := tx.QueryRow(ctx, "select current_database(), session_user::text").Scan(&database, &session); e != nil {
			return e
		}
		rows, e := tx.Objects(ctx, "select tenant_id::text from nexo_go_directory() order by tenant_id")
		if e != nil {
			return e
		}
		for _, row := range rows {
			tenants = append(tenants, row.Get("tenant_id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if database != "nexo_test" || session != "nexo_go" || len(tenants) < 2 {
		t.Fatal("requer laboratório nexo_test/nexo_go com dois tenants")
	}

	actors := map[string]*auth.Ctx{}
	for i, tenant := range tenants[:2] {
		token := fmt.Sprintf("quotes-export-token-%d", i)
		actors[ftthHash(token)] = &auth.Ctx{
			UserID:      "",
			TenantID:    tenant,
			Role:        "admin",
			Permissions: auth.Permissions["admin"],
			Modules:     []string{"field"},
			ExpiresAt:   time.Now().Add(time.Hour),
			Scope:       tenancy.Scope{TenantID: tenant},
		}
	}
	for i, spec := range []struct {
		permissions []string
		modules     []string
		scope       tenancy.Scope
		tenant      string
	}{
		{[]string{"stock:read"}, []string{"field"}, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		{[]string{"stock:write"}, []string{"field"}, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		{auth.Permissions["admin"], nil, tenancy.Scope{TenantID: tenants[0]}, tenants[0]},
		{auth.Permissions["admin"], []string{"field"}, tenancy.Scope{TenantID: tenants[0], SubscriberID: uuid.NewString()}, tenants[0]},
		{auth.Permissions["admin"], []string{"field"}, tenancy.Scope{TenantID: tenants[0], PopIDs: []string{uuid.NewString()}}, tenants[0]},
	} {
		token := fmt.Sprintf("quotes-export-token-%d", i+2)
		actors[ftthHash(token)] = &auth.Ctx{
			TenantID:    spec.tenant,
			Role:        "admin",
			Permissions: spec.permissions,
			Modules:     spec.modules,
			ExpiresAt:   time.Now().Add(time.Hour),
			Scope:       spec.scope,
		}
	}

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
	config := huma.DefaultConfig("quotations", "1")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	api := humachi.New(router, config)
	registerStockQuotations(api, registry, Service{DB: d})
	registerStockPurchasing(api, registry, Service{DB: d})

	call := func(tenant int, method, path string, body any, want int) (map[string]any, *httptest.ResponseRecorder) {
		t.Helper()
		var req *http.Request
		if body != nil {
			raw, _ := json.Marshal(body)
			req = httptest.NewRequest(method, path, bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
		} else {
			req = httptest.NewRequest(method, path, nil)
		}
		token := fmt.Sprintf("quotes-export-token-%d", tenant)
		req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
		req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("%s %s: %d expected %d: %s", method, path, w.Code, want, w.Body.String())
		}
		out := map[string]any{}
		if strings.Contains(w.Header().Get("Content-Type"), "application/json") {
			_ = json.Unmarshal(w.Body.Bytes(), &out)
		}
		return out, w
	}

	var item1, item2, supplier1, supplier2, warehouse string
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, "insert into stock_items(tenant_id,name,unit) values(app_tenant(),$1,'un') returning id::text", "Item 1 "+uuid.NewString()).Scan(&item1); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into stock_items(tenant_id,name,unit) values(app_tenant(),$1,'m') returning id::text", "Item 2 "+uuid.NewString()).Scan(&item2); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into suppliers(tenant_id,name) values(app_tenant(),$1) returning id::text", "Fornecedor 1 "+uuid.NewString()).Scan(&supplier1); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, "insert into suppliers(tenant_id,name) values(app_tenant(),$1) returning id::text", "Fornecedor 2 "+uuid.NewString()).Scan(&supplier2); e != nil {
			return e
		}
		return tx.QueryRow(ctx, "insert into stock_warehouses(tenant_id,name) values(app_tenant(),$1) returning id::text", "Depósito "+uuid.NewString()).Scan(&warehouse)
	})
	if err != nil {
		t.Fatal(err)
	}

	base := "/api/stock/quotations"
	qData, _ := call(0, "POST", base, map[string]any{
		"title": "Cotação Exportação PG",
		"items": []any{
			map[string]any{"item_id": item1, "qty": 10},
			map[string]any{"item_id": item2, "qty": 20},
		},
	}, 200)
	quoteID := qData["id"].(string)
	exportPath := fmt.Sprintf("%s/%s/export.csv", base, quoteID)
	detailPath := fmt.Sprintf("%s/%s", base, quoteID)

	// 1. Export with NO offers yet
	_, recNoOffers := call(0, "GET", exportPath, nil, 200)
	if recNoOffers.Header().Get("Content-Type") != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type inesperado: %s", recNoOffers.Header().Get("Content-Type"))
	}
	expectedFilename := fmt.Sprintf("cotacao-%s.csv", quoteID[:8])
	expectedDisp := fmt.Sprintf(`attachment; filename="%s"`, expectedFilename)
	if recNoOffers.Header().Get("Content-Disposition") != expectedDisp {
		t.Fatalf("Content-Disposition esperado %s, obtido %s", expectedDisp, recNoOffers.Header().Get("Content-Disposition"))
	}
	if recNoOffers.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("Cache-Control esperado 'private, no-store', obtido %s", recNoOffers.Header().Get("Cache-Control"))
	}
	if recNoOffers.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("X-Content-Type-Options esperado 'nosniff', obtido %s", recNoOffers.Header().Get("X-Content-Type-Options"))
	}

	rNoOffers := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(recNoOffers.Body.Bytes(), []byte("\xef\xbb\xbf"))))
	rNoOffers.Comma = ';'
	noOfferRecords, err := rNoOffers.ReadAll()
	if err != nil {
		t.Fatalf("csv parsing sem ofertas: %v", err)
	}
	if len(noOfferRecords) != 3 { // header + 2 items
		t.Fatalf("esperado 3 registros sem ofertas, obtido %d", len(noOfferRecords))
	}
	for _, rec := range noOfferRecords[1:] {
		if rec[3] != "" || rec[4] != "" || rec[9] != "" || rec[10] != "" {
			t.Fatalf("sem ofertas fornecedor e preços devem ser vazios: %v", rec)
		}
	}

	// 2. Add 2 offers with prices
	call(0, "POST", detailPath+"/offers", map[string]any{
		"supplier_id": supplier1,
		"prices": []any{
			map[string]any{"item_id": item1, "unit_cost_cents": 1500},
			map[string]any{"item_id": item2, "unit_cost_cents": 2500},
		},
	}, 200)
	offer2Data, _ := call(0, "POST", detailPath+"/offers", map[string]any{
		"supplier_id": supplier2,
		"prices": []any{
			map[string]any{"item_id": item1, "unit_cost_cents": 1400},
			map[string]any{"item_id": item2, "unit_cost_cents": 2600},
		},
	}, 200)
	offer2ID := offer2Data["offers"].([]any)[1].(map[string]any)["id"].(string)

	// Fetch JSON detail for comparison
	jsonDetail, _ := call(0, "GET", detailPath, nil, 200)

	// Export with offers
	_, recWithOffers := call(0, "GET", exportPath, nil, 200)
	rWithOffers := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(recWithOffers.Body.Bytes(), []byte("\xef\xbb\xbf"))))
	rWithOffers.Comma = ';'
	offerRecords, err := rWithOffers.ReadAll()
	if err != nil {
		t.Fatalf("csv parsing com ofertas: %v", err)
	}
	if len(offerRecords) != 5 { // header + 2 offers * 2 items
		t.Fatalf("esperado 5 registros com ofertas, obtido %d", len(offerRecords))
	}

	// Verify that sum of subtotais for each offer equals total_cents from JSON detail
	jsonOffers := jsonDetail["offers"].([]any)
	subtotalSums := make(map[string]int64)
	for _, rec := range offerRecords[1:] {
		supplierID := rec[3]
		subtotal, _ := strconv.ParseInt(rec[10], 10, 64)
		subtotalSums[supplierID] += subtotal
	}

	for _, jo := range jsonOffers {
		oMap := jo.(map[string]any)
		sID := oMap["supplier_id"].(string)
		expectedTotal := int64(oMap["total_cents"].(float64))
		if subtotalSums[sID] != expectedTotal {
			t.Fatalf("soma subtotais CSV (%d) != total_cents JSON (%d) para fornecedor %s", subtotalSums[sID], expectedTotal, sID)
		}
	}

	// 3. Permissions, Tenancy, and Errors
	call(0, "GET", base+"/invalid-uuid/export.csv", nil, 400)
	call(0, "GET", base+"/"+uuid.NewString()+"/export.csv", nil, 404)
	call(1, "GET", exportPath, nil, 404) // Foreign tenant
	call(2, "GET", exportPath, nil, 200) // stock:read permission
	call(3, "GET", exportPath, nil, 403) // stock:write only, missing stock:read
	call(4, "GET", exportPath, nil, 403) // missing field module
	call(5, "GET", exportPath, nil, 404) // subscriber scope
	call(6, "GET", exportPath, nil, 404) // pop restricted scope

	// 4. Converted quotation exports with status "converted" and pedido_id filled
	convertRes, _ := call(0, "POST", detailPath+"/purchase", map[string]any{
		"offer_id":     offer2ID,
		"warehouse_id": warehouse,
		"expected_at":  "2026-11-01",
	}, 200)
	purchaseOrderID := convertRes["purchase_order_id"].(string)

	_, recConverted := call(0, "GET", exportPath, nil, 200)
	rConverted := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(recConverted.Body.Bytes(), []byte("\xef\xbb\xbf"))))
	rConverted.Comma = ';'
	convertedRecords, err := rConverted.ReadAll()
	if err != nil {
		t.Fatalf("csv parsing convertida: %v", err)
	}
	for _, rec := range convertedRecords[1:] {
		if rec[2] != "converted" {
			t.Errorf("status esperado 'converted', obtido %s", rec[2])
		}
		if rec[11] != purchaseOrderID {
			t.Errorf("pedido_id esperado %s, obtido %s", purchaseOrderID, rec[11])
		}
	}

	// 5. Canceled quotation exports with status "canceled"
	cancelQuote, _ := call(0, "POST", base, map[string]any{
		"title": "Cotação para Cancelar",
		"items": []any{map[string]any{"item_id": item1, "qty": 1}},
	}, 200)
	cancelQuoteID := cancelQuote["id"].(string)
	call(0, "POST", base+"/"+cancelQuoteID+"/cancel", map[string]any{"reason": "cancelamento teste"}, 200)

	_, recCanceled := call(0, "GET", base+"/"+cancelQuoteID+"/export.csv", nil, 200)
	rCanceled := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(recCanceled.Body.Bytes(), []byte("\xef\xbb\xbf"))))
	rCanceled.Comma = ';'
	canceledRecords, err := rCanceled.ReadAll()
	if err != nil {
		t.Fatalf("csv parsing cancelada: %v", err)
	}
	if len(canceledRecords) < 2 || canceledRecords[1][2] != "canceled" {
		t.Fatalf("esperado status 'canceled', obtido: %v", canceledRecords)
	}
}
