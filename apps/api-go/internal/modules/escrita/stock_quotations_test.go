package escrita

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

func TestStockQuotationPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_STOCK_QUOTES_PG_REQUIRED") == "1" {
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
		token := fmt.Sprintf("quotes-token-%d", i)
		actors[ftthHash(token)] = &auth.Ctx{UserID: "", TenantID: tenant, Role: "admin", Permissions: auth.Permissions["admin"], Modules: []string{"field"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant}}
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
		{auth.Permissions["admin"], []string{"field"}, tenancy.Scope{TenantID: tenants[0]}, tenants[1]},
	} {
		token := fmt.Sprintf("quotes-token-%d", i+2)
		actors[ftthHash(token)] = &auth.Ctx{TenantID: spec.tenant, Role: "admin", Permissions: spec.permissions, Modules: spec.modules, ExpiresAt: time.Now().Add(time.Hour), Scope: spec.scope}
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
	call := func(tenant int, method, path string, body any, want int) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		token := fmt.Sprintf("quotes-token-%d", tenant)
		req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
		req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("%s %s: %d expected %d: %s", method, path, w.Code, want, w.Body.String())
		}
		out := map[string]any{}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	var item, supplier, foreign, warehouse string
	for i, tenant := range tenants[:2] {
		err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			var id string
			if e := tx.QueryRow(ctx, "insert into stock_items(tenant_id,name,unit) values(app_tenant(),$1,'un') returning id::text", "Cotação "+uuid.NewString()).Scan(&id); e != nil {
				return e
			}
			if i == 1 {
				foreign = id
				return nil
			}
			item = id
			if e := tx.QueryRow(ctx, "insert into stock_warehouses(tenant_id,name) values(app_tenant(),$1) returning id::text", "Depósito "+uuid.NewString()).Scan(&warehouse); e != nil {
				return e
			}
			return tx.QueryRow(ctx, "insert into suppliers(tenant_id,name) values(app_tenant(),$1) returning id::text", "Fornecedor "+uuid.NewString()).Scan(&supplier)
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	base := "/api/stock/quotations"
	q := call(0, "POST", base, map[string]any{"title": "Cotação teste", "items": []any{map[string]any{"item_id": item, "qty": 1000000}}}, 200)
	id := q["id"].(string)
	path := base + "/" + id
	call(1, "GET", path, nil, 404)
	call(2, "GET", path, nil, 200)
	call(2, "POST", path+"/cancel", map[string]any{"reason": "teste"}, 403)
	call(3, "GET", path, nil, 403)
	call(4, "GET", path, nil, 403)
	call(5, "GET", path, nil, 404)
	call(6, "GET", path, nil, 404)
	call(0, "POST", path+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": foreign, "unit_cost_cents": 1}}}, 400)
	offer := call(0, "POST", path+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": strings.ToUpper(item), "unit_cost_cents": 100000000}}}, 200)
	offers := offer["offers"].([]any)
	entry := offers[0].(map[string]any)
	if entry["total_cents"] != float64(100000000000000) {
		t.Fatalf("total: %v", entry["total_cents"])
	}
	offerID := entry["id"].(string)
	// Validate complete, unique price sets and the item/offer bounds.
	var extraItems []any
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		for i := 0; i < 30; i++ {
			var next string
			if e := tx.QueryRow(ctx, "insert into stock_items(tenant_id,name,unit) values(app_tenant(),$1,'un') returning id::text", "Limite "+uuid.NewString()).Scan(&next); e != nil {
				return e
			}
			extraItems = append(extraItems, map[string]any{"item_id": next, "qty": 1})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	call(0, "POST", base, map[string]any{"title": "Limite", "items": append(append([]any{}, extraItems...), map[string]any{"item_id": item, "qty": 1})}, 400)
	large := call(0, "POST", base, map[string]any{"title": "Trinta itens", "items": extraItems}, 200)
	largePath := base + "/" + large["id"].(string)
	firstItem := extraItems[0].(map[string]any)["item_id"]
	call(0, "POST", largePath+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": firstItem, "unit_cost_cents": 1}}}, 400)
	call(0, "POST", largePath+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": firstItem, "unit_cost_cents": 1}, map[string]any{"item_id": firstItem, "unit_cost_cents": 2}}}, 400)
	call(0, "POST", path+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": item, "unit_cost_cents": 1.5}}}, 400)
	for i := 1; i < 10; i++ {
		call(0, "POST", path+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": item, "unit_cost_cents": i}}}, 200)
	}
	call(0, "POST", path+"/offers", map[string]any{"supplier_id": supplier, "prices": []any{map[string]any{"item_id": item, "unit_cost_cents": 1}}}, 409)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		return tx.Exec(ctx, "insert into stock_quotations(tenant_id,title) select app_tenant(),'Teste lista' from generate_series(1,101)")
	})
	if err != nil {
		t.Fatal(err)
	}
	listing := call(0, "GET", base, nil, 200)
	if listing["truncated"] != true || len(listing["items"].([]any)) != 100 {
		t.Fatalf("limite da lista: %v", listing)
	}
	// A different quotation cannot consume or delete this offer.
	other := call(0, "POST", base, map[string]any{"title": "Outra cotação", "items": []any{map[string]any{"item_id": item, "qty": 1}}}, 200)
	otherPath := base + "/" + other["id"].(string)
	call(0, "POST", otherPath+"/purchase", map[string]any{"offer_id": offerID}, 404)
	call(0, "DELETE", otherPath+"/offers/"+offerID, nil, 404)
	call(0, "POST", path+"/purchase", map[string]any{"offer_id": offerID, "expected_at": "0000-01-01"}, 400)
	call(0, "POST", path+"/purchase", map[string]any{"offer_id": offerID, "expected_at": "2025-02-29"}, 400)
	// An audit RLS violation occurs after order, items and quote updates.
	var beforeOrders, beforeItems, beforeAudits int
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, "select (select count(*) from purchase_orders),(select count(*) from purchase_order_items),(select count(*) from audit_events where action in ('stock.purchase_create','stock.quotation_convert'))").Scan(&beforeOrders, &beforeItems, &beforeAudits)
	})
	if err != nil {
		t.Fatal(err)
	}
	call(7, "POST", path+"/purchase", map[string]any{"offer_id": offerID, "expected_at": "2024-02-29"}, 403)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var orders, items, audits int
		var status string
		var linked bool
		if e := tx.QueryRow(ctx, "select (select count(*) from purchase_orders),(select count(*) from purchase_order_items),(select count(*) from audit_events where action in ('stock.purchase_create','stock.quotation_convert')),status,purchase_order_id is not null from stock_quotations where id=$1", id).Scan(&orders, &items, &audits, &status, &linked); e != nil {
			return e
		}
		if orders != beforeOrders || items != beforeItems || audits != beforeAudits || status != "draft" || linked {
			return fmt.Errorf("rollback: orders=%d items=%d audits=%d status=%s linked=%t", orders, items, audits, status, linked)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// An item may become serialized after the quotation was created.
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		return tx.Exec(ctx, "update stock_items set serialized=true where id=$1", item)
	})
	if err != nil {
		t.Fatal(err)
	}
	call(0, "POST", path+"/purchase", map[string]any{"offer_id": offerID}, 400)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var status string
		var orders, moves int
		if e := tx.QueryRow(ctx, "select status,(select count(*) from purchase_orders where id=q.purchase_order_id),(select count(*) from stock_movements where item_id=$2) from stock_quotations q where id=$1", id, item).Scan(&status, &orders, &moves); e != nil {
			return e
		}
		if status != "draft" || orders != 0 || moves != 0 {
			return fmt.Errorf("após recusa: status=%s pedidos=%d movimentos=%d", status, orders, moves)
		}
		return tx.Exec(ctx, "update stock_items set serialized=false where id=$1", item)
	})
	if err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"offer_id": strings.ToUpper(offerID), "warehouse_id": strings.ToUpper(warehouse)}
	// Two requests race on the same quotation lock.
	type purchaseResult struct {
		status int
		body   map[string]any
	}
	results := make(chan purchaseResult, 2)
	for i := 0; i < 2; i++ {
		go func() {
			raw, _ := json.Marshal(body)
			req := httptest.NewRequest("POST", path+"/purchase", bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: "quotes-token-0"})
			req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF("quotes-token-0"))
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			out := map[string]any{}
			_ = json.Unmarshal(w.Body.Bytes(), &out)
			results <- purchaseResult{w.Code, out}
		}()
	}
	a1, a2 := <-results, <-results
	if a1.status != 200 || a2.status != 200 || a1.body["purchase_order_id"] == nil || a1.body["purchase_order_id"] != a2.body["purchase_order_id"] {
		t.Fatalf("conversões concorrentes: %#v %#v", a1, a2)
	}
	first := a1.body
	second := call(0, "POST", path+"/purchase", body, 200)
	if first["purchase_order_id"] != second["purchase_order_id"] {
		t.Fatal("conversão duplicada")
	}
	call(0, "POST", path+"/purchase", map[string]any{"offer_id": offerID, "expected_at": "2025-02-28"}, 409)
	call(0, "POST", path+"/purchase", map[string]any{"offer_id": offerID, "expected_at": "2025-02-30"}, 400)
	call(0, "DELETE", path+"/offers/"+offerID, nil, 409)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var orders, moves, audits int
		if e := tx.QueryRow(ctx, "select (select count(*) from purchase_orders where id=$1 and status='draft'),(select count(*) from stock_movements where purchase_order_id=$1),(select count(*) from audit_events where (action='stock.purchase_create' and entity_id=$1::text) or (action='stock.quotation_convert' and entity_id=$2::text))", first["purchase_order_id"], id).Scan(&orders, &moves, &audits); e != nil {
			return e
		}
		if orders != 1 || moves != 0 || audits != 2 {
			return fmt.Errorf("pedidos=%d movimentos=%d auditorias=%d", orders, moves, audits)
		}
		var qty, cents int
		if e := tx.QueryRow(ctx, "select qty,unit_cost_cents from purchase_order_items where order_id=$1 and item_id=$2", first["purchase_order_id"], item).Scan(&qty, &cents); e != nil {
			return e
		}
		if qty != 1000000 || cents != 100000000 {
			return fmt.Errorf("item: %d %d", qty, cents)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	call(0, "POST", "/api/stock/purchases/"+first["purchase_order_id"].(string)+"/receive", nil, 200)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var movements int
		if e := tx.QueryRow(ctx, "select count(*) from stock_movements where purchase_order_id=$1 and qty=1000000", first["purchase_order_id"]).Scan(&movements); e != nil {
			return e
		}
		if movements != 1 {
			return fmt.Errorf("recebimento: movimentos=%d", movements)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
