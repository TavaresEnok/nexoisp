package escrita

import (
	"context"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

// registerStockMovementForTest expõe o movimento manual (operação do registrador
// genérico) com a mesma permissão e validação do manifesto.
func registerStockMovementForTest(api huma.API, registry *endpoint.Registry, s Service) {
	ops := map[string]operation{}
	s.stockOperations(ops)
	op := ops["POST /api/stock/items/:id/movements"]
	routeScoped(api, registry, s, http.MethodPost, "/api/stock/items/{id}/movements", specs["POST /api/stock/items/:id/movements"].Permission, op.schema, false,
		func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, b map[string]any) (any, error) {
			return op.handle(ctx, tx, p["id"], b)
		})
}

// Custo médio ponderado com várias entradas e saídas, arredondamento em
// centavos, valor por depósito, títulos gerados pelo recebimento, baixa,
// cancelamento, filtros, totais, permissões e isolamento entre provedores.
func TestStockAverageCostAndPayablesPG(t *testing.T) {
	h := newPGHarness(t, "cost", func(api huma.API, registry *endpoint.Registry, s Service) {
		registerStockPurchasing(api, registry, s)
		registerStockCosts(api, registry, s)
		registerPayables(api, registry, s)
		registerStockMovementForTest(api, registry, s)
	})
	var item, fresh, warehouse, supplier, otherSupplier string
	h.scope(0, func(tx *db.Tx) error {
		for _, target := range []*string{&item, &fresh} {
			if e := tx.QueryRow(h.ctx, "insert into stock_items(tenant_id,name,unit) values(app_tenant(),$1,'m') returning id::text", "Custo "+uuid.NewString()).Scan(target); e != nil {
				return e
			}
		}
		if e := tx.QueryRow(h.ctx, "insert into stock_warehouses(tenant_id,name) values(app_tenant(),$1) returning id::text", "Depósito custo "+uuid.NewString()).Scan(&warehouse); e != nil {
			return e
		}
		for _, target := range []*string{&supplier, &otherSupplier} {
			if e := tx.QueryRow(h.ctx, "insert into suppliers(tenant_id,name) values(app_tenant(),$1) returning id::text", "Fornecedor custo "+uuid.NewString()).Scan(target); e != nil {
				return e
			}
		}
		return nil
	})
	move := func(id, kind string, qty int, cost any, want int) map[string]any {
		body := map[string]any{"kind": kind, "qty": qty, "note": "movimento sintético"}
		if cost != nil {
			body["unit_cost_cents"] = cost
		}
		return h.call(actorStockWriteA, "POST", "/api/stock/items/"+id+"/movements", body, want)
	}
	costs := func(id string) map[string]any {
		return h.call(actorStockReadA, "GET", "/api/stock/items/"+id+"/costs", nil, 200)
	}

	// Entradas e saídas no depósito principal.
	if r := move(item, "in", 10, 1000, 200); centsOf(r["avg_cost_cents"]) != 1000 || centsOf(r["unit_cost_cents"]) != 1000 {
		t.Fatalf("primeira entrada: %v", r)
	}
	if r := move(item, "in", 5, nil, 200); centsOf(r["avg_cost_cents"]) != 1000 || centsOf(r["unit_cost_cents"]) != 1000 {
		t.Fatalf("entrada sem custo usa o médio: %v", r)
	}
	if r := move(item, "out", 3, nil, 200); centsOf(r["unit_cost_cents"]) != 1000 || r["balance"] != float64(12) {
		t.Fatalf("saída pelo médio: %v", r)
	}
	move(item, "out", 1, 1000, 400)
	h.call(actorStockWriteA, "POST", "/api/stock/items/"+item+"/movements", map[string]any{"kind": "adjust", "qty": 1, "note": "ajuste", "unit_cost_cents": 5}, 400)
	move(item, "in", 1, 1.5, 400)
	move(item, "in", 1, -1, 400)
	h.call(actorStockReadA, "POST", "/api/stock/items/"+item+"/movements", map[string]any{"kind": "in", "qty": 1}, 403)

	// Compra recebida em parcelas: 12 × 10,00 + 4 × 10,02 = 1000,5 → 10,01 (meio centavo para cima).
	order := h.call(actorStockWriteA, "POST", "/api/stock/purchases", map[string]any{"supplier_id": supplier, "warehouse_id": warehouse, "items": []any{map[string]any{"item_id": item, "qty": 4, "unit_cost_cents": 1002}}}, 201)
	orderPath := "/api/stock/purchases/" + order["id"].(string)
	h.call(actorStockWriteA, "POST", orderPath+"/receive", map[string]any{"due_date": "2030-02-30", "installments": 5}, 400)
	h.call(actorStockWriteA, "POST", orderPath+"/receive", map[string]any{"due_date": "2030-01-31", "installments": 25}, 400)
	h.call(actorFinanceWriteA, "POST", orderPath+"/receive", map[string]any{"due_date": "2030-01-31", "installments": 5}, 403)
	received := h.call(actorStockWriteA, "POST", orderPath+"/receive", map[string]any{"due_date": "2030-01-31", "installments": 5}, 200)
	payables := received["payables"].([]any)
	wantAmounts := []int64{802, 802, 802, 801, 801}
	wantDue := []string{"2030-01-31", "2030-02-28", "2030-03-31", "2030-04-30", "2030-05-31"}
	if received["status"] != "received" || len(payables) != 5 {
		t.Fatalf("recebimento: %v", received)
	}
	for i, raw := range payables {
		p := raw.(map[string]any)
		if centsOf(p["amount_cents"]) != wantAmounts[i] || p["due_date"] != wantDue[i] || p["supplier_id"] != supplier || p["status"] != "open" || p["purchase_order_id"] != order["id"] || p["installments"] != float64(5) {
			t.Fatalf("parcela %d: %v", i+1, p)
		}
	}
	h.call(actorStockWriteA, "POST", orderPath+"/receive", nil, 409)
	if c := costs(item); centsOf(c["avg_cost_cents"]) != 1001 || centsOf(c["balance"]) != 16 || centsOf(c["value_cents"]) != 16016 {
		t.Fatalf("custo médio após compra: %v", c)
	}
	if r := move(item, "out", 6, nil, 200); centsOf(r["unit_cost_cents"]) != 1001 {
		t.Fatalf("saída após compra usa o novo médio: %v", r)
	}
	history := costs(item)["movements"].([]any)
	if len(history) != 5 {
		t.Fatalf("histórico de custo: %v", history)
	}
	purchase := history[1].(map[string]any)
	if purchase["kind"] != "in" || purchase["cost_source"] != "entry" || centsOf(purchase["unit_cost_cents"]) != 1002 || centsOf(purchase["avg_cost_cents"]) != 1001 || centsOf(purchase["value_cents"]) != 4008 {
		t.Fatalf("movimento da compra: %v", purchase)
	}
	if out := history[0].(map[string]any); centsOf(out["value_cents"]) != -6006 || out["cost_source"] != "average" {
		t.Fatalf("saída valorizada: %v", out)
	}

	// Saldo zerado: a próxima entrada com custo define o médio.
	move(fresh, "in", 2, 333, 200)
	move(fresh, "out", 2, nil, 200)
	if r := move(fresh, "in", 1, 500, 200); centsOf(r["avg_cost_cents"]) != 500 {
		t.Fatalf("médio após saldo zero: %v", r)
	}

	// Valor do estoque por depósito: principal 6 × 10,01 e depósito novo 4 × 10,01.
	valuation := h.call(actorStockReadA, "GET", "/api/stock/valuation", nil, 200)
	lines := map[string]int64{}
	for _, raw := range valuation["lines"].([]any) {
		line := raw.(map[string]any)
		if line["item_id"] == item {
			key := "principal"
			if line["warehouse_id"] != nil {
				key = line["warehouse_id"].(string)
			}
			lines[key] = centsOf(line["value_cents"])
		}
	}
	if lines["principal"] != 6006 || lines[warehouse] != 4004 || len(lines) != 2 {
		t.Fatalf("valor por depósito: %v", lines)
	}
	found := false
	for _, raw := range valuation["warehouses"].([]any) {
		w := raw.(map[string]any)
		if w["warehouse_id"] == warehouse {
			found = centsOf(w["value_cents"]) == 4004 && w["items"] == float64(1)
		}
	}
	if !found {
		t.Fatalf("total do depósito: %v", valuation["warehouses"])
	}
	h.call(actorFinanceReadA, "GET", "/api/stock/valuation", nil, 403)
	h.call(actorAdminB, "GET", "/api/stock/items/"+item+"/costs", nil, 404)
	for _, raw := range h.call(actorAdminB, "GET", "/api/stock/valuation", nil, 200)["items"].([]any) {
		if raw.(map[string]any)["item_id"] == item {
			t.Fatal("valor de estoque de outro provedor")
		}
	}

	// Recebimento sem corpo: uma parcela com vencimento em 30 dias no fuso do provedor.
	second := h.call(actorStockWriteA, "POST", "/api/stock/purchases", map[string]any{"supplier_id": otherSupplier, "items": []any{map[string]any{"item_id": fresh, "qty": 3, "unit_cost_cents": 250}}}, 201)
	defaults := h.call(actorStockWriteA, "POST", "/api/stock/purchases/"+second["id"].(string)+"/receive", nil, 200)["payables"].([]any)
	var expectedDue string
	h.scope(0, func(tx *db.Tx) error {
		_, today, e := tenantClock(h.ctx, tx)
		if e != nil {
			return e
		}
		return tx.QueryRow(h.ctx, "select ($1::date + 30)::text", today).Scan(&expectedDue)
	})
	if len(defaults) != 1 || centsOf(defaults[0].(map[string]any)["amount_cents"]) != 750 || defaults[0].(map[string]any)["due_date"] != expectedDue {
		t.Fatalf("título padrão: %v (vencimento %s)", defaults, expectedDue)
	}
	free := h.call(actorStockWriteA, "POST", "/api/stock/purchases", map[string]any{"supplier_id": otherSupplier, "items": []any{map[string]any{"item_id": fresh, "qty": 1, "unit_cost_cents": 0}}}, 201)
	if p := h.call(actorStockWriteA, "POST", "/api/stock/purchases/"+free["id"].(string)+"/receive", nil, 200)["payables"].([]any); len(p) != 0 {
		t.Fatalf("compra sem custo não gera título: %v", p)
	}

	// Contas a pagar: filtros, totais, baixa, cancelamento, permissões e isolamento.
	list := func(actor int, query string) map[string]any {
		return h.call(actor, "GET", "/api/finance/payables"+query, nil, 200)
	}
	bySupplier := list(actorFinanceReadA, "?supplier_id="+supplier)
	if len(bySupplier["items"].([]any)) != 5 || centsOf(bySupplier["totals"].(map[string]any)["open_cents"]) != 4008 || bySupplier["totals"].(map[string]any)["open_count"] != float64(5) {
		t.Fatalf("filtro por fornecedor: %v", bySupplier["totals"])
	}
	window := list(actorFinanceReadA, "?supplier_id="+supplier+"&due_from=2030-02-01&due_to=2030-03-31")
	if len(window["items"].([]any)) != 2 {
		t.Fatalf("filtro por vencimento: %v", window["items"])
	}
	h.call(actorFinanceReadA, "GET", "/api/finance/payables?due_from=2030-02-31", nil, 400)
	h.call(actorFinanceReadA, "GET", "/api/finance/payables?status=vencido", nil, 400)
	firstID := payables[0].(map[string]any)["id"].(string)
	secondID := payables[1].(map[string]any)["id"].(string)
	h.call(actorFinanceReadA, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2026-01-05", "method": "pix"}, 403)
	h.call(actorStockWriteA, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2026-01-05", "method": "pix"}, 403)
	h.call(actorPopA, "GET", "/api/finance/payables", nil, 403)
	h.call(actorAdminB, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2026-01-05", "method": "pix"}, 404)
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2999-01-05", "method": "pix"}, 400)
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2026-01-05", "method": "cheque"}, 400)
	paid := h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2026-01-05", "method": "boleto", "note": "Baixa sintética"}, 200)
	if paid["status"] != "paid" || paid["paid_on"] != "2026-01-05" || paid["paid_method"] != "boleto" {
		t.Fatalf("baixa: %v", paid)
	}
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+firstID+"/pay", map[string]any{"paid_on": "2026-01-05", "method": "pix"}, 409)
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+firstID+"/cancel", map[string]any{"reason": "Cancelamento sintético"}, 409)
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+secondID+"/cancel", map[string]any{"reason": "x"}, 400)
	canceled := h.call(actorFinanceWriteA, "POST", "/api/finance/payables/"+secondID+"/cancel", map[string]any{"reason": "Desconto negociado"}, 200)
	if canceled["status"] != "canceled" || canceled["cancel_reason"] != "Desconto negociado" {
		t.Fatalf("cancelamento: %v", canceled)
	}
	totals := list(actorFinanceReadA, "?supplier_id="+supplier)["totals"].(map[string]any)
	if centsOf(totals["open_cents"]) != 801*2+802 || centsOf(totals["paid_cents"]) != 802 || centsOf(totals["canceled_cents"]) != 802 {
		t.Fatalf("totais após baixa e cancelamento: %v", totals)
	}
	if paidOnly := list(actorFinanceReadA, "?supplier_id="+supplier+"&status=paid")["items"].([]any); len(paidOnly) != 1 || paidOnly[0].(map[string]any)["id"] != firstID {
		t.Fatalf("filtro por situação: %v", paidOnly)
	}

	// Lançamento manual parcelado e vencido.
	h.call(actorFinanceReadA, "POST", "/api/finance/payables", map[string]any{"description": "Aluguel de torre", "amount_cents": 1000, "due_date": "2020-01-10"}, 403)
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables", map[string]any{"description": "Aluguel de torre", "amount_cents": 2, "due_date": "2020-01-10", "installments": 3}, 400)
	h.call(actorFinanceWriteA, "POST", "/api/finance/payables", map[string]any{"description": "Aluguel", "amount_cents": 1000, "due_date": "2020-01-10", "supplier_id": uuid.NewString()}, 400)
	manual := h.call(actorFinanceWriteA, "POST", "/api/finance/payables", map[string]any{"description": "Aluguel de torre " + uuid.NewString()[:8], "amount_cents": 1001, "due_date": "2020-01-10", "installments": 2, "supplier_id": otherSupplier}, 201)["items"].([]any)
	if len(manual) != 2 || centsOf(manual[0].(map[string]any)["amount_cents"]) != 501 || manual[1].(map[string]any)["due_date"] != "2020-02-10" || manual[0].(map[string]any)["overdue"] != true || manual[0].(map[string]any)["purchase_order_id"] != nil {
		t.Fatalf("lançamento manual: %v", manual)
	}
	overdue := list(actorFinanceReadA, "?status=overdue&supplier_id="+otherSupplier)
	if len(overdue["items"].([]any)) != 2 || centsOf(overdue["totals"].(map[string]any)["overdue_cents"]) != 1001 {
		t.Fatalf("vencidos: %v", overdue)
	}
	for _, raw := range list(actorAdminB, "")["items"].([]any) {
		if raw.(map[string]any)["supplier_id"] == supplier {
			t.Fatal("título de outro provedor listado")
		}
	}
	// Título baixado é imutável também no banco.
	if err := h.d.WithScope(h.ctx, scopeOf(h, 0), func(tx *db.Tx) error {
		return tx.Exec(h.ctx, "update payables set amount_cents = 1 where id = $1", firstID)
	}); err == nil {
		t.Fatal("banco alterou título pago")
	}
	h.scope(0, func(tx *db.Tx) error {
		rows, e := tx.Objects(h.ctx, "select count(*)::int as n from payables where purchase_order_id = $1", order["id"])
		if e == nil && rows[0].Get("n") != int32(5) {
			t.Fatalf("títulos do pedido: %v", rows[0].Get("n"))
		}
		return e
	})
}
