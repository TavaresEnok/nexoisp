package escrita

import (
	"context"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Depósitos, transferências, fornecedores e pedidos de compra do estoque.
// Movimentos sem depósito pertencem ao depósito principal. Itens controlados
// por número de série continuam movimentados pelas unidades.
const purchaseColumns = `p.id, p.number, p.status, p.supplier_id, s.name as supplier_name, p.warehouse_id,
	coalesce(h.name, 'Depósito principal') as warehouse_name, p.expected_at, p.note, p.created_at, p.ordered_at, p.received_at,
	coalesce((select sum(x.qty::bigint * x.unit_cost_cents::bigint)::bigint from purchase_order_items x where x.order_id = p.id), 0) as total_cents,
	coalesce((select jsonb_agg(jsonb_build_object('item_id', x.item_id, 'item_name', i.name, 'unit', i.unit, 'qty', x.qty, 'unit_cost_cents', x.unit_cost_cents) order by i.name)
		from purchase_order_items x join stock_items i on i.id = x.item_id where x.order_id = p.id), '[]'::jsonb) as items`
const purchaseFrom = ` from purchase_orders p join suppliers s on s.id = p.supplier_id left join stock_warehouses h on h.id = p.warehouse_id`

func registerStockPurchasing(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, str, n := validate.F, validate.Object, validate.String, validate.Number
	uuid := str().UUID()
	warehouse := o(f("name", str().Trimmed().Min(2).Max(80)), f("address", str().Trimmed().Max(200).Def("")))
	warehousePatch := o(f("name", str().Trimmed().Min(2).Max(80).Opt()), f("address", str().Trimmed().Max(200).Opt()), f("active", validate.Boolean().Opt()))
	transfer := o(f("from_warehouse_id", uuid.Null()), f("to_warehouse_id", uuid.Null()), f("qty", n().Int().Min(1).Max(1000000)), f("note", str().Trimmed().Max(300).Def("")))
	supplierFields := func(optional bool) validate.Rule {
		opt := func(r validate.Rule) validate.Rule {
			if optional {
				return r.Opt()
			}
			return r
		}
		return o(
			f("name", opt(str().Trimmed().Min(2).Max(120))),
			f("document", str().Pattern(`^([0-9]{11}|[0-9]{14})$`, "CPF ou CNPJ com 11 ou 14 dígitos").Nullish()),
			f("email", str().Trimmed().Max(120).Nullish()), f("phone", str().Trimmed().Max(30).Nullish()),
			f("notes", opt(str().Trimmed().Max(1000).Def(""))), f("active", validate.Boolean().Opt()),
		)
	}
	purchase := o(
		f("supplier_id", uuid), f("warehouse_id", uuid.Nullish()),
		f("expected_at", str().Pattern(`^\d{4}-\d{2}-\d{2}$`, "use AAAA-MM-DD").Nullish()),
		f("note", str().Trimmed().Max(500).Def("")),
		f("items", validate.Array(o(f("item_id", uuid), f("qty", n().Int().Min(1).Max(1000000)), f("unit_cost_cents", n().Int().Min(0).Max(100000000)))).Min(1).Max(100)),
	)
	status := o(f("status", validate.Enum("ordered", "canceled")))

	scoped := func(ctx context.Context, run func(*db.Tx) (any, error)) (endpoint.Result, error) {
		var value any
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			var err error
			value, err = run(tx)
			return err
		})
		return endpoint.Result{Value: value}, err
	}
	parse := func(r *http.Request, rule validate.Rule) (map[string]any, error) {
		var raw any
		if err := apierr.DecodeJSON(r, &raw); err != nil {
			return nil, err
		}
		return rule.Parse(raw, true)
	}
	param := func(r *http.Request) (string, error) {
		id := chi.URLParam(r, "id")
		return id, validate.UUID(id)
	}
	write := func(method, path string, rule *validate.Rule, run func(context.Context, *db.Tx, string, map[string]any) (any, error)) {
		registry.Handle(api, method, path, "stock:write", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := ""
			if chi.URLParam(r, "id") != "" {
				var err error
				if id, err = param(r); err != nil {
					return endpoint.Result{}, err
				}
			}
			var b map[string]any
			if rule != nil {
				var err error
				if b, err = parse(r, *rule); err != nil {
					return endpoint.Result{}, err
				}
			}
			result, err := scoped(ctx, func(tx *db.Tx) (any, error) { return run(ctx, tx, id, b) })
			if method == http.MethodPost && id == "" {
				result.Status = http.StatusCreated
			}
			return result, err
		})
	}
	read := func(path string, run func(context.Context, *db.Tx, *http.Request) (any, error)) {
		registry.Get(api, path, "stock:read", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			return scoped(ctx, func(tx *db.Tx) (any, error) { return run(ctx, tx, r) })
		})
	}
	first := func(rows []jsonx.Object, err error) (jsonx.Object, error) {
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "registro não encontrado")
		}
		return rows[0], nil
	}
	activeWarehouse := func(ctx context.Context, tx *db.Tx, id any) error {
		if id == nil {
			return nil
		}
		row, err := first(tx.Objects(ctx, "select active from stock_warehouses where id = $1", id))
		if err != nil {
			return apierr.New(400, "depósito não encontrado neste provedor")
		}
		if row.Get("active") != true {
			return apierr.New(400, "depósito inativo")
		}
		return nil
	}
	user := func(ctx context.Context) any { return nullableUser(auth.From(ctx)) }

	// Depósitos
	read("/api/stock/warehouses", func(ctx context.Context, tx *db.Tx, _ *http.Request) (any, error) {
		return tx.Objects(ctx, "select id, name, address, active, created_at from stock_warehouses order by active desc, name")
	})
	write(http.MethodPost, "/api/stock/warehouses", &warehouse, func(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
		row, err := first(tx.Objects(ctx, "insert into stock_warehouses (tenant_id, name, address) values (app_tenant(), $1, $2) returning id, name, address, active, created_at", b["name"], b["address"]))
		if err != nil {
			return nil, catalogConflict(err, "já existe um depósito com este nome")
		}
		return row, record(ctx, tx, "stock.warehouse_create", "stock_warehouse", row.Get("id"), b)
	})
	write(http.MethodPatch, "/api/stock/warehouses/{id}", &warehousePatch, func(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
		row, err := first(tx.Objects(ctx, `update stock_warehouses set name = coalesce($2, name), address = coalesce($3, address), active = coalesce($4, active)
			where id = $1 returning id, name, address, active, created_at`, id, b["name"], b["address"], b["active"]))
		if err != nil {
			return nil, catalogConflict(err, "já existe um depósito com este nome")
		}
		return row, record(ctx, tx, "stock.warehouse_update", "stock_warehouse", id, b)
	})

	// Saldos por depósito e transferência
	read("/api/stock/items/{id}/balances", func(ctx context.Context, tx *db.Tx, r *http.Request) (any, error) {
		id, err := param(r)
		if err != nil {
			return nil, err
		}
		return tx.Objects(ctx, `select null::uuid as warehouse_id, 'Depósito principal' as name, true as active,
				coalesce((select sum(qty) from stock_movements where item_id = $1 and warehouse_id is null), 0)::int as balance
			union all
			select h.id, h.name, h.active, coalesce((select sum(m.qty) from stock_movements m where m.item_id = $1 and m.warehouse_id = h.id), 0)::int
			from stock_warehouses h order by 1 nulls first`, id)
	})
	write(http.MethodPost, "/api/stock/items/{id}/transfer", &transfer, func(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
		from, to := b["from_warehouse_id"], b["to_warehouse_id"]
		if from == to {
			return nil, apierr.New(400, "escolha depósitos de origem e destino diferentes")
		}
		item, err := first(tx.Objects(ctx, "select name, serialized from stock_items where id = $1 for update", id))
		if err != nil {
			return nil, apierr.New(404, "item de estoque não encontrado")
		}
		if item.Get("serialized") == true {
			return nil, apierr.New(400, fmt.Sprintf("“%v” é controlado por número de série: movimente pelas unidades", item.Get("name")))
		}
		if err = activeWarehouse(ctx, tx, to); err != nil {
			return nil, err
		}
		balance, err := first(tx.Objects(ctx, "select coalesce(sum(qty), 0)::int as b from stock_movements where item_id = $1 and warehouse_id is not distinct from $2::uuid", id, from))
		if err != nil {
			return nil, err
		}
		qty := num(b["qty"])
		if num(balance.Get("b")) < qty {
			return nil, apierr.New(409, fmt.Sprintf("saldo insuficiente de “%v” no depósito de origem: há %g", item.Get("name"), num(balance.Get("b"))))
		}
		note := nilEmpty(b["note"])
		for _, leg := range []struct {
			warehouse any
			sign      float64
		}{{from, -1}, {to, 1}} {
			if err = tx.Exec(ctx, `insert into stock_movements (tenant_id, item_id, qty, kind, note, created_by, warehouse_id)
				values (app_tenant(), $1, $2, 'transfer', $3, $4, $5)`, id, leg.sign*qty, note, user(ctx), leg.warehouse); err != nil {
				return nil, err
			}
		}
		result := map[string]any{"ok": true, "qty": qty}
		return result, record(ctx, tx, "stock.transfer", "stock_item", id, map[string]any{"from": from, "to": to, "qty": qty})
	})

	// Fornecedores
	supplierCreate, supplierPatch := supplierFields(false), supplierFields(true)
	read("/api/stock/suppliers", func(ctx context.Context, tx *db.Tx, _ *http.Request) (any, error) {
		return tx.Objects(ctx, `select s.id, s.name, s.document, s.email, s.phone, s.notes, s.active, s.created_at,
			(select count(*)::int from purchase_orders p where p.supplier_id = s.id) as purchases from suppliers s order by s.active desc, s.name`)
	})
	write(http.MethodPost, "/api/stock/suppliers", &supplierCreate, func(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
		row, err := first(tx.Objects(ctx, `insert into suppliers (tenant_id, name, document, email, phone, notes) values (app_tenant(), $1, $2, $3, $4, $5)
			returning id, name, document, email, phone, notes, active, created_at`, b["name"], nilEmpty(b["document"]), nilEmpty(b["email"]), nilEmpty(b["phone"]), b["notes"]))
		if err != nil {
			return nil, catalogConflict(err, "já existe um fornecedor com este nome")
		}
		return row, record(ctx, tx, "stock.supplier_create", "supplier", row.Get("id"), map[string]any{"name": b["name"]})
	})
	write(http.MethodPatch, "/api/stock/suppliers/{id}", &supplierPatch, func(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
		row, err := first(tx.Objects(ctx, `update suppliers set name = coalesce($2, name),
				document = case when $3 then $4 else document end, email = case when $5 then $6 else email end,
				phone = case when $7 then $8 else phone end, notes = coalesce($9, notes), active = coalesce($10, active)
			where id = $1 returning id, name, document, email, phone, notes, active, created_at`,
			id, b["name"], has(b, "document"), nilEmpty(b["document"]), has(b, "email"), nilEmpty(b["email"]), has(b, "phone"), nilEmpty(b["phone"]), b["notes"], b["active"]))
		if err != nil {
			return nil, catalogConflict(err, "já existe um fornecedor com este nome")
		}
		return row, record(ctx, tx, "stock.supplier_update", "supplier", id, map[string]any{"fields": len(b)})
	})

	// Pedidos de compra
	purchaseByID := func(ctx context.Context, tx *db.Tx, id any) (jsonx.Object, error) {
		return first(tx.Objects(ctx, "select "+purchaseColumns+purchaseFrom+" where p.id = $1", id))
	}
	read("/api/stock/purchases", func(ctx context.Context, tx *db.Tx, _ *http.Request) (any, error) {
		return tx.Objects(ctx, "select "+purchaseColumns+purchaseFrom+" order by p.number desc limit 200")
	})
	write(http.MethodPost, "/api/stock/purchases", &purchase, func(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
		supplier, err := first(tx.Objects(ctx, "select active from suppliers where id = $1", b["supplier_id"]))
		if err != nil || supplier.Get("active") != true {
			return nil, apierr.New(400, "fornecedor não encontrado ou inativo")
		}
		if err = activeWarehouse(ctx, tx, b["warehouse_id"]); err != nil {
			return nil, err
		}
		items := b["items"].([]any)
		seen := map[any]bool{}
		for _, raw := range items {
			line := raw.(map[string]any)
			if seen[line["item_id"]] {
				return nil, apierr.New(400, "items: cada item aparece uma vez por pedido")
			}
			seen[line["item_id"]] = true
			item, err := first(tx.Objects(ctx, "select name, serialized, active from stock_items where id = $1", line["item_id"]))
			if err != nil {
				return nil, apierr.New(400, "items: item de estoque não encontrado")
			}
			if item.Get("serialized") == true {
				return nil, apierr.New(400, fmt.Sprintf("“%v” é controlado por número de série: registre a entrada pelas unidades", item.Get("name")))
			}
			if item.Get("active") != true {
				return nil, apierr.New(400, fmt.Sprintf("“%v” está inativo", item.Get("name")))
			}
		}
		if err = tx.Exec(ctx, "select pg_advisory_xact_lock(hashtext('purchase_orders:' || app_tenant()::text))"); err != nil {
			return nil, err
		}
		order, err := first(tx.Objects(ctx, `insert into purchase_orders (tenant_id, number, supplier_id, warehouse_id, expected_at, note, created_by)
			values (app_tenant(), coalesce((select max(number) from purchase_orders), 0) + 1, $1, $2, $3::date, $4, $5) returning id, number`,
			b["supplier_id"], b["warehouse_id"], b["expected_at"], b["note"], user(ctx)))
		if err != nil {
			return nil, err
		}
		for _, raw := range items {
			line := raw.(map[string]any)
			if err = tx.Exec(ctx, "insert into purchase_order_items (tenant_id, order_id, item_id, qty, unit_cost_cents) values (app_tenant(), $1, $2, $3, $4)",
				order.Get("id"), line["item_id"], line["qty"], line["unit_cost_cents"]); err != nil {
				return nil, err
			}
		}
		if err = record(ctx, tx, "stock.purchase_create", "purchase_order", order.Get("id"), map[string]any{"number": order.Get("number"), "items": len(items)}); err != nil {
			return nil, err
		}
		return purchaseByID(ctx, tx, order.Get("id"))
	})
	write(http.MethodPost, "/api/stock/purchases/{id}/status", &status, func(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
		current, err := first(tx.Objects(ctx, "select status from purchase_orders where id = $1 for update", id))
		if err != nil {
			return nil, apierr.New(404, "pedido de compra não encontrado")
		}
		from, to := current.Get("status"), b["status"]
		if !(to == "ordered" && from == "draft" || to == "canceled" && (from == "draft" || from == "ordered")) {
			return nil, apierr.New(409, fmt.Sprintf("pedido %v não pode passar para %v", from, to))
		}
		if err = tx.Exec(ctx, "update purchase_orders set status = $2, ordered_at = case when $2 = 'ordered' then now() else ordered_at end where id = $1", id, to); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "stock.purchase_"+to.(string), "purchase_order", id, nil); err != nil {
			return nil, err
		}
		return purchaseByID(ctx, tx, id)
	})
	write(http.MethodPost, "/api/stock/purchases/{id}/receive", nil, func(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
		order, err := first(tx.Objects(ctx, "select number, status, warehouse_id from purchase_orders where id = $1 for update", id))
		if err != nil {
			return nil, apierr.New(404, "pedido de compra não encontrado")
		}
		if order.Get("status") != "ordered" && order.Get("status") != "draft" {
			return nil, apierr.New(409, "somente pedidos em rascunho ou enviados podem ser recebidos")
		}
		if err = activeWarehouse(ctx, tx, order.Get("warehouse_id")); err != nil {
			return nil, err
		}
		note := fmt.Sprintf("Compra #%v", order.Get("number"))
		if err = tx.Exec(ctx, `insert into stock_movements (tenant_id, item_id, qty, kind, note, created_by, warehouse_id, purchase_order_id)
			select app_tenant(), x.item_id, x.qty, 'in', $2, $3, $4, $1 from purchase_order_items x where x.order_id = $1`,
			id, note, user(ctx), order.Get("warehouse_id")); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, "update purchase_orders set status = 'received', received_at = now(), received_by = $2 where id = $1", id, user(ctx)); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "stock.purchase_receive", "purchase_order", id, map[string]any{"number": order.Get("number")}); err != nil {
			return nil, err
		}
		return purchaseByID(ctx, tx, id)
	})
}
