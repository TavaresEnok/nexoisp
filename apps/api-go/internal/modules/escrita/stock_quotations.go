package escrita

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

func registerStockQuotations(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, str, n := validate.F, validate.Object, validate.String, validate.Number
	uuid := str().UUID()
	item := o(f("item_id", uuid), f("qty", n().Int().Min(1).Max(1000000)))
	price := o(f("item_id", uuid), f("unit_cost_cents", n().Int().Min(0).Max(100000000)))
	create := o(f("title", str().Trimmed().Min(3).Max(120)), f("note", str().Trimmed().Max(500).Def("")), f("items", validate.Array(item).Min(1).Max(30)))
	offer := o(f("supplier_id", uuid), f("note", str().Trimmed().Max(500).Def("")), f("prices", validate.Array(price).Min(1).Max(30)))
	cancel := o(f("reason", str().Trimmed().Min(5).Max(300)))
	purchase := o(f("offer_id", uuid), f("warehouse_id", uuid.Nullish()), f("expected_at", str().Pattern(`^\d{4}-\d{2}-\d{2}$`, "use AAAA-MM-DD").Nullish()))
	first := func(rows []jsonx.Object, err error) (jsonx.Object, error) {
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "cotação ou registro não encontrado")
		}
		return rows[0], nil
	}
	detail := func(ctx context.Context, tx *db.Tx, id any) (jsonx.Object, error) {
		return first(tx.Objects(ctx, `select q.id,q.title,q.note,q.status,q.created_at,q.purchase_order_id,
  coalesce((select jsonb_agg(jsonb_build_object('item_id',i.item_id,'item_name',s.name,'unit',s.unit,'qty',i.qty) order by s.name,i.item_id) from stock_quotation_items i join stock_items s on s.tenant_id=i.tenant_id and s.id=i.item_id where i.quotation_id=q.id),'[]'::jsonb) items,
  coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'supplier_id',o.supplier_id,'supplier_name',s.name,'note',o.note,'created_at',o.created_at,
   'prices',coalesce((select jsonb_agg(jsonb_build_object('item_id',p.item_id,'unit_cost_cents',p.unit_cost_cents) order by p.item_id) from stock_quotation_prices p where p.offer_id=o.id),'[]'::jsonb),
   'total_cents',coalesce((select sum(i.qty::bigint*p.unit_cost_cents::bigint)::bigint from stock_quotation_prices p join stock_quotation_items i on i.tenant_id=p.tenant_id and i.quotation_id=p.quotation_id and i.item_id=p.item_id where p.offer_id=o.id),0)) order by o.created_at,o.id)
   from stock_quotation_offers o join suppliers s on s.tenant_id=o.tenant_id and s.id=o.supplier_id where o.quotation_id=q.id),'[]'::jsonb) offers
  from stock_quotations q where q.id=$1`, id))
	}
	lock := func(ctx context.Context, tx *db.Tx, id string) (jsonx.Object, error) {
		return first(tx.Objects(ctx, "select status,purchase_order_id,chosen_offer_id,chosen_warehouse_id,chosen_expected_at::text from stock_quotations where id=$1 for update", id))
	}
	draft := func(row jsonx.Object) error {
		if row.Get("status") != "draft" {
			return apierr.New(409, "cotação não está em rascunho")
		}
		return nil
	}
	type fn func(context.Context, *db.Tx, string, *http.Request, map[string]any) (any, error)
	route := func(method, path, permission string, rule *validate.Rule, run fn) {
		registry.Handle(api, method, path, permission, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if id != "" {
				if err := validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			var b map[string]any
			if rule != nil {
				var raw any
				if err := apierr.DecodeJSON(r, &raw); err != nil {
					return endpoint.Result{}, err
				}
				var err error
				b, err = rule.Parse(raw, true)
				if err != nil {
					return endpoint.Result{}, err
				}
			}
			var value any
			err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error { var err error; value, err = run(ctx, tx, id, r, b); return err })
			return endpoint.Result{Value: value}, err
		})
	}
	route("GET", "/api/stock/quotations", "stock:read", nil, func(ctx context.Context, tx *db.Tx, _ string, _ *http.Request, _ map[string]any) (any, error) {
		rows, err := tx.Objects(ctx, `select q.id,q.title,q.status,q.created_at,q.purchase_order_id,(select count(*)::int from stock_quotation_offers o where o.quotation_id=q.id) offers_count from stock_quotations q order by q.created_at desc,q.id desc limit 101`)
		if err != nil {
			return nil, err
		}
		truncated := len(rows) > 100
		if truncated {
			rows = rows[:100]
		}
		return map[string]any{"items": rows, "truncated": truncated}, nil
	})
	route("GET", "/api/stock/quotations/{id}", "stock:read", nil, func(ctx context.Context, tx *db.Tx, id string, _ *http.Request, _ map[string]any) (any, error) {
		return detail(ctx, tx, id)
	})
	route("POST", "/api/stock/quotations", "stock:write", &create, func(ctx context.Context, tx *db.Tx, _ string, _ *http.Request, b map[string]any) (any, error) {
		seen := map[any]bool{}
		for _, raw := range b["items"].([]any) {
			v := raw.(map[string]any)
			v["item_id"] = strings.ToLower(v["item_id"].(string))
			if seen[v["item_id"]] {
				return nil, apierr.New(400, "item duplicado")
			}
			seen[v["item_id"]] = true
			row, err := first(tx.Objects(ctx, "select active from stock_items where id=$1", v["item_id"]))
			if err != nil || row.Get("active") != true {
				return nil, apierr.New(400, "item inválido ou inativo")
			}
		}
		q, err := first(tx.Objects(ctx, "insert into stock_quotations(tenant_id,title,note) values(app_tenant(),$1,$2) returning id", b["title"], b["note"]))
		if err != nil {
			return nil, err
		}
		for _, raw := range b["items"].([]any) {
			v := raw.(map[string]any)
			if err = tx.Exec(ctx, "insert into stock_quotation_items(tenant_id,quotation_id,item_id,qty) values(app_tenant(),$1,$2,$3)", q.Get("id"), v["item_id"], v["qty"]); err != nil {
				return nil, err
			}
		}
		if err = record(ctx, tx, "stock.quotation_create", "stock_quotation", q.Get("id"), map[string]any{"items": len(seen)}); err != nil {
			return nil, err
		}
		return detail(ctx, tx, q.Get("id"))
	})
	route("POST", "/api/stock/quotations/{id}/offers", "stock:write", &offer, func(ctx context.Context, tx *db.Tx, id string, _ *http.Request, b map[string]any) (any, error) {
		q, err := lock(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if err = draft(q); err != nil {
			return nil, err
		}
		supplier, err := first(tx.Objects(ctx, "select active from suppliers where id=$1", b["supplier_id"]))
		if err != nil || supplier.Get("active") != true {
			return nil, apierr.New(400, "fornecedor inválido ou inativo")
		}
		rows, err := tx.Objects(ctx, "select item_id from stock_quotation_items where quotation_id=$1", id)
		if err != nil {
			return nil, err
		}
		allowed := map[any]bool{}
		for _, row := range rows {
			allowed[row.Get("item_id")] = true
		}
		seen := map[any]bool{}
		for _, raw := range b["prices"].([]any) {
			v := raw.(map[string]any)
			v["item_id"] = strings.ToLower(v["item_id"].(string))
			if !allowed[v["item_id"]] || seen[v["item_id"]] {
				return nil, apierr.New(400, "preços devem corresponder aos itens da cotação")
			}
			seen[v["item_id"]] = true
		}
		if len(seen) != len(allowed) {
			return nil, apierr.New(400, "informe preço para todos os itens")
		}
		count, err := first(tx.Objects(ctx, "select count(*)::int as n from stock_quotation_offers where quotation_id=$1", id))
		if err != nil {
			return nil, err
		}
		if num(count.Get("n")) >= 10 {
			return nil, apierr.New(409, "limite de ofertas atingido")
		}
		row, err := first(tx.Objects(ctx, "insert into stock_quotation_offers(tenant_id,quotation_id,supplier_id,note) values(app_tenant(),$1,$2,$3) returning id", id, b["supplier_id"], b["note"]))
		if err != nil {
			return nil, err
		}
		for _, raw := range b["prices"].([]any) {
			v := raw.(map[string]any)
			if err = tx.Exec(ctx, "insert into stock_quotation_prices(tenant_id,quotation_id,offer_id,item_id,unit_cost_cents) values(app_tenant(),$1,$2,$3,$4)", id, row.Get("id"), v["item_id"], v["unit_cost_cents"]); err != nil {
				return nil, err
			}
		}
		if err = record(ctx, tx, "stock.quotation_offer", "stock_quotation", id, map[string]any{"offer_id": row.Get("id")}); err != nil {
			return nil, err
		}
		return detail(ctx, tx, id)
	})
	route("DELETE", "/api/stock/quotations/{id}/offers/{offerId}", "stock:write", nil, func(ctx context.Context, tx *db.Tx, id string, r *http.Request, _ map[string]any) (any, error) {
		offerID := chi.URLParam(r, "offerId")
		if err := validate.UUID(offerID); err != nil {
			return nil, err
		}
		q, err := lock(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if err = draft(q); err != nil {
			return nil, err
		}
		_, err = first(tx.Objects(ctx, "delete from stock_quotation_offers where quotation_id=$1 and id=$2 returning id", id, offerID))
		if err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "stock.quotation_offer_delete", "stock_quotation", id, map[string]any{"offer_id": offerID}); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
	route("POST", "/api/stock/quotations/{id}/cancel", "stock:write", &cancel, func(ctx context.Context, tx *db.Tx, id string, _ *http.Request, b map[string]any) (any, error) {
		q, err := lock(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if err = draft(q); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, "update stock_quotations set status='canceled',cancel_reason=$2 where id=$1", id, b["reason"]); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "stock.quotation_cancel", "stock_quotation", id, map[string]any{"reason": b["reason"]}); err != nil {
			return nil, err
		}
		return detail(ctx, tx, id)
	})
	route("POST", "/api/stock/quotations/{id}/purchase", "stock:write", &purchase, func(ctx context.Context, tx *db.Tx, id string, _ *http.Request, b map[string]any) (any, error) {
		b["offer_id"] = strings.ToLower(b["offer_id"].(string))
		if b["warehouse_id"] != nil {
			b["warehouse_id"] = strings.ToLower(b["warehouse_id"].(string))
		}
		if b["expected_at"] != nil {
			v := b["expected_at"].(string)
			d, err := time.Parse("2006-01-02", v)
			if err != nil || d.Year() < 1 || d.Format("2006-01-02") != v {
				return nil, apierr.New(400, "data inválida")
			}
		}
		q, err := lock(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if q.Get("status") == "converted" {
			if q.Get("chosen_offer_id") != b["offer_id"] || q.Get("chosen_warehouse_id") != b["warehouse_id"] || q.Get("chosen_expected_at") != b["expected_at"] {
				return nil, apierr.New(409, "cotação já convertida com outros dados")
			}
			return first(tx.Objects(ctx, "select id as purchase_order_id,number from purchase_orders where id=$1", q.Get("purchase_order_id")))
		}
		if err = draft(q); err != nil {
			return nil, err
		}
		selected, err := first(tx.Objects(ctx, "select supplier_id from stock_quotation_offers where quotation_id=$1 and id=$2", id, b["offer_id"]))
		if err != nil {
			return nil, err
		}
		supplier, err := first(tx.Objects(ctx, "select active from suppliers where id=$1", selected.Get("supplier_id")))
		if err != nil || supplier.Get("active") != true {
			return nil, apierr.New(400, "fornecedor inválido ou inativo")
		}
		if b["warehouse_id"] != nil {
			w, e := first(tx.Objects(ctx, "select active from stock_warehouses where id=$1", b["warehouse_id"]))
			if e != nil || w.Get("active") != true {
				return nil, apierr.New(400, "depósito inválido ou inativo")
			}
		}
		items, err := tx.Objects(ctx, "select i.active,i.serialized from stock_quotation_items q join stock_items i on i.tenant_id=q.tenant_id and i.id=q.item_id where q.quotation_id=$1 order by i.id for update of i", id)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if item.Get("active") != true || item.Get("serialized") == true {
				return nil, apierr.New(400, "item inativo ou serializado")
			}
		}
		if err = tx.Exec(ctx, "select pg_advisory_xact_lock(hashtext('purchase_orders:' || app_tenant()::text))"); err != nil {
			return nil, err
		}
		order, err := first(tx.Objects(ctx, `insert into purchase_orders(tenant_id,number,supplier_id,warehouse_id,expected_at,note,created_by) select app_tenant(),coalesce((select max(number) from purchase_orders),0)+1,$1,$2,$3::date,note,$4 from stock_quotations where id=$5 returning id as purchase_order_id,number`, selected.Get("supplier_id"), b["warehouse_id"], b["expected_at"], nullableUser(auth.From(ctx)), id))
		if err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, `insert into purchase_order_items(tenant_id,order_id,item_id,qty,unit_cost_cents) select app_tenant(),$1,i.item_id,i.qty,p.unit_cost_cents from stock_quotation_items i join stock_quotation_prices p on p.tenant_id=i.tenant_id and p.quotation_id=i.quotation_id and p.item_id=i.item_id where i.quotation_id=$2 and p.offer_id=$3`, order.Get("purchase_order_id"), id, b["offer_id"]); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, "update stock_quotations set status='converted',purchase_order_id=$2,chosen_offer_id=$3,chosen_warehouse_id=$4,chosen_expected_at=$5::date where id=$1", id, order.Get("purchase_order_id"), b["offer_id"], b["warehouse_id"], b["expected_at"]); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "stock.purchase_create", "purchase_order", order.Get("purchase_order_id"), map[string]any{"number": order.Get("number"), "quotation_id": id}); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "stock.quotation_convert", "stock_quotation", id, map[string]any{"purchase_order_id": order.Get("purchase_order_id"), "offer_id": b["offer_id"]}); err != nil {
			return nil, err
		}
		return order, nil
	})
}
