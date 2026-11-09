package escrita

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

// Custo médio e valor do estoque. O custo médio é global por material e é
// mantido pelo gatilho stock_movement_cost (migração 00090) a cada movimento;
// aqui só se lê: valor por depósito = saldo do depósito × custo médio do material.
func registerStockCosts(api huma.API, registry *endpoint.Registry, s Service) {
	routeScoped(api, registry, s, http.MethodGet, "/api/stock/valuation", "stock:read", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, _ map[string]any) (any, error) {
		lines, err := tx.Objects(ctx, `with places as (
				select m.item_id, m.warehouse_id, sum(m.qty)::bigint as qty from stock_movements m group by m.item_id, m.warehouse_id having sum(m.qty) <> 0)
			select p.warehouse_id, coalesce(h.name, 'Depósito principal') as warehouse_name, i.id as item_id, i.name as item_name, i.unit,
				p.qty, i.avg_cost_cents, (p.qty * i.avg_cost_cents)::bigint as value_cents
			from places p join stock_items i on i.id = p.item_id left join stock_warehouses h on h.id = p.warehouse_id
			order by p.warehouse_id is not null, h.name, i.name, i.id`)
		if err != nil {
			return nil, err
		}
		items, err := tx.Objects(ctx, `select i.id as item_id, i.name, i.unit, i.active, i.avg_cost_cents,
				coalesce(b.qty, 0)::bigint as balance, (coalesce(b.qty, 0) * i.avg_cost_cents)::bigint as value_cents
			from stock_items i left join (select item_id, sum(qty)::bigint as qty from stock_movements group by item_id) b on b.item_id = i.id
			order by i.name, i.id`)
		if err != nil {
			return nil, err
		}
		warehouses := []map[string]any{}
		index := map[any]int{}
		total := float64(0)
		for _, line := range lines {
			key := line.Get("warehouse_id")
			position, seen := index[key]
			if !seen {
				position = len(warehouses)
				index[key] = position
				warehouses = append(warehouses, map[string]any{"warehouse_id": key, "name": line.Get("warehouse_name"), "items": 0, "value_cents": float64(0)})
			}
			warehouses[position]["items"] = warehouses[position]["items"].(int) + 1
			warehouses[position]["value_cents"] = warehouses[position]["value_cents"].(float64) + num(line.Get("value_cents"))
			total += num(line.Get("value_cents"))
		}
		return map[string]any{"warehouses": warehouses, "lines": lines, "items": items, "total_cents": total}, nil
	})
	routeScoped(api, registry, s, http.MethodGet, "/api/stock/items/{id}/costs", "stock:read", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		item, err := firstRow("item de estoque não encontrado")(tx.Objects(ctx, `select i.id as item_id, i.name, i.unit, i.avg_cost_cents,
				coalesce((select sum(qty) from stock_movements m where m.item_id = i.id), 0)::bigint as balance
			from stock_items i where i.id = $1`, p["id"]))
		if err != nil {
			return nil, err
		}
		item.Set("value_cents", num(item.Get("balance"))*num(item.Get("avg_cost_cents")))
		movements, err := tx.Objects(ctx, `select m.id, m.created_at, m.kind, m.qty, m.unit_cost_cents, m.avg_cost_cents, m.cost_source,
				(m.qty::bigint * m.unit_cost_cents)::bigint as value_cents
			from stock_movements m where m.item_id = $1 order by m.id desc limit 200`, p["id"])
		if err != nil {
			return nil, err
		}
		item.Set("movements", movements)
		return jsonx.Object(item), nil
	})
}
