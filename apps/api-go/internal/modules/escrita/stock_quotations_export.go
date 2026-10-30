package escrita

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

const quotationCSVColumns = "cotacao_id;cotacao;status;fornecedor_id;fornecedor;item_id;item;unidade;quantidade;preco_unitario_centavos;subtotal_centavos;pedido_id"
const maxQuotationCSVRows = 300

func registerStockQuotationsExport(api huma.API, registry *endpoint.Registry, s Service, detail func(context.Context, *db.Tx, any) (jsonx.Object, error)) {
	registry.Handle(api, http.MethodGet, "/api/stock/quotations/{id}/export.csv", "stock:read", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		id := chi.URLParam(r, "id")
		if err := validate.UUID(id); err != nil {
			return endpoint.Result{}, err
		}
		var csvBytes []byte
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			row, err := detail(ctx, tx, id)
			if err != nil {
				return err
			}
			csvBytes, err = quotationCSV(row)
			return err
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		shortID := id
		if len(shortID) > 8 {
			shortID = shortID[:8]
		}
		return endpoint.Result{
			CSV:          csvBytes,
			Filename:     fmt.Sprintf("cotacao-%s.csv", strings.ToLower(shortID)),
			CacheControl: "private, no-store",
		}, nil
	})
}

func quotationCSV(row jsonx.Object) ([]byte, error) {
	quotationID := toString(row.Get("id"))
	title := toString(row.Get("title"))
	status := toString(row.Get("status"))
	orderID := toString(row.Get("purchase_order_id"))

	items := toSlice(row.Get("items"))
	offers := toSlice(row.Get("offers"))

	if len(items) > 30 {
		items = items[:30]
	}
	if len(offers) > 10 {
		offers = offers[:10]
	}

	var rows []string

	col1 := formatCSVCell(quotationID, false)
	col2 := formatCSVCell(title, true)
	col3 := formatCSVCell(status, false)
	col12 := formatCSVCell(orderID, false)

	if len(offers) == 0 {
		for _, rawItem := range items {
			if len(rows) >= maxQuotationCSVRows {
				break
			}
			itemID := toString(getField(rawItem, "item_id"))
			itemName := toString(getField(rawItem, "item_name"))
			unit := toString(getField(rawItem, "unit"))
			qty, _ := toInt64(getField(rawItem, "qty"))

			col6 := formatCSVCell(itemID, false)
			col7 := formatCSVCell(itemName, true)
			col8 := formatCSVCell(unit, true)
			col9 := formatCSVCell(strconv.FormatInt(qty, 10), false)

			rowStr := strings.Join([]string{
				col1, col2, col3,
				"", "",
				col6, col7, col8, col9,
				"", "",
				col12,
			}, ";")
			rows = append(rows, rowStr)
		}
	} else {
		for _, rawOffer := range offers {
			supplierID := toString(getField(rawOffer, "supplier_id"))
			supplierName := toString(getField(rawOffer, "supplier_name"))

			priceMap := make(map[string]int64)
			hasPriceMap := make(map[string]bool)
			for _, rawPrice := range toSlice(getField(rawOffer, "prices")) {
				pItemID := strings.ToLower(toString(getField(rawPrice, "item_id")))
				cost, ok := toInt64(getField(rawPrice, "unit_cost_cents"))
				if ok {
					priceMap[pItemID] = cost
					hasPriceMap[pItemID] = true
				}
			}

			col4 := formatCSVCell(supplierID, false)
			col5 := formatCSVCell(supplierName, true)

			for _, rawItem := range items {
				if len(rows) >= maxQuotationCSVRows {
					break
				}
				itemID := toString(getField(rawItem, "item_id"))
				itemName := toString(getField(rawItem, "item_name"))
				unit := toString(getField(rawItem, "unit"))
				qty, _ := toInt64(getField(rawItem, "qty"))

				col6 := formatCSVCell(itemID, false)
				col7 := formatCSVCell(itemName, true)
				col8 := formatCSVCell(unit, true)
				col9 := formatCSVCell(strconv.FormatInt(qty, 10), false)

				var col10, col11 string
				normItemID := strings.ToLower(itemID)
				if hasPriceMap[normItemID] {
					unitCost := priceMap[normItemID]
					subtotal := qty * unitCost
					col10 = formatCSVCell(strconv.FormatInt(unitCost, 10), false)
					col11 = formatCSVCell(strconv.FormatInt(subtotal, 10), false)
				}

				rowStr := strings.Join([]string{
					col1, col2, col3,
					col4, col5,
					col6, col7, col8, col9,
					col10, col11,
					col12,
				}, ";")
				rows = append(rows, rowStr)
			}
		}
	}

	var b strings.Builder
	b.WriteString("\ufeff")
	b.WriteString(quotationCSVColumns)
	b.WriteString("\r\n")
	for _, r := range rows {
		b.WriteString(r)
		b.WriteString("\r\n")
	}
	return []byte(b.String()), nil
}

func formatCSVCell(val string, isTextual bool) string {
	if val == "" {
		return ""
	}
	if isTextual {
		trimmed := strings.TrimLeft(val, " \t\r\n")
		if trimmed != "" && strings.ContainsAny(trimmed[:1], "=+-@") {
			val = "'" + val
		}
	}
	return `"` + strings.ReplaceAll(val, `"`, `""`) + `"`
}

func getField(obj any, key string) any {
	if o, ok := obj.(jsonx.Object); ok {
		return o.Get(key)
	}
	if op, ok := obj.(*jsonx.Object); ok && op != nil {
		return op.Get(key)
	}
	if m, ok := obj.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func toString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func toSlice(v any) []any {
	if v == nil {
		return nil
	}
	switch s := v.(type) {
	case []any:
		return s
	case []jsonx.Object:
		out := make([]any, len(s))
		for i, x := range s {
			out[i] = x
		}
		return out
	case []map[string]any:
		out := make([]any, len(s))
		for i, x := range s {
			out[i] = x
		}
		return out
	}
	return nil
}

func toInt64(v any) (int64, bool) {
	if v == nil {
		return 0, false
	}
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case float64:
		return int64(n), true
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case string:
		i, err := strconv.ParseInt(strings.TrimSpace(n), 10, 64)
		return i, err == nil
	}
	return 0, false
}
