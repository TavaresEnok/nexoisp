package escrita

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

func (s Service) stockOperations(ops map[string]operation) {
	f, o, str, n, b, e := validate.F, validate.Object, validate.String, validate.Number, validate.Boolean, validate.Enum
	uuid := str().UUID()
	fields := []validate.Field{f("name", str().Trimmed().Min(2).Max(120)), f("sku", text(60).Nullish().Then(nilEmpty, true)), f("unit", str().Trimmed().Pattern(`^[a-zA-Z]{1,6}$`, "unidade: até 6 letras").Def("un")), f("min_qty", n().Int().Min(0).Max(1000000).Def(float64(0))), f("serialized", b().Def(false))}
	ops["POST /api/stock/items"] = operation{s.createStockItem, obj(o(fields...))}
	partial := []validate.Field{}
	for _, field := range fields {
		rule := field.Rule.Opt()
		rule.TransformMissing = false
		partial = append(partial, f(field.Name, rule))
	}
	partial = append(partial, f("active", b().Opt()))
	ops["PATCH /api/stock/items/:id"] = operation{s.updateStockItem, obj(o(partial...))}
	qty := func(max float64) validate.Rule {
		return n().Int().Min(-max).Max(max).Refine(func(v any) bool { return num(v) != 0 }, "quantidade não pode ser zero")
	}
	ops["POST /api/stock/items/:id/movements"] = operation{s.stockMovement, obj(o(f("kind", e("in", "out", "adjust")), f("qty", qty(1000000)), f("note", text(300).Nullish())))}
	ops["POST /api/stock/items/:id/units"] = operation{s.receiveUnits, obj(o(f("serials", validate.Array(str().Trimmed().Pattern(`^[A-Za-z0-9._:-]{4,40}$`, "série: 4 a 40 letras, números, . _ : -").Upper()).Min(1).Max(500)), f("note", text(300).Nullish())))}
	ops["POST /api/stock/units/:id/transfer"] = operation{s.transferUnit, obj(o(f("holder_id", uuid.Null())))}
	ops["POST /api/stock/units/:id/status"] = operation{s.unitStatus, obj(o(f("status", e("in_stock", "defective", "written_off")), f("note", text(300).Nullish())))}
	ops["POST /api/work-orders/:id/checklist"] = operation{s.checklist, obj(o(f("items", validate.Array(str().Trimmed().Min(2).Max(160)).Min(1).Max(30))))}
	ops["POST /api/work-orders/:id/checklist/:itemId"] = operation{s.checklistDone, obj(o(f("done", b())))}
	ops["POST /api/work-orders/:id/helpers"] = operation{s.addHelper, obj(o(f("user_id", uuid)))}
	ops["DELETE /api/work-orders/:id/helpers/:userId"] = operation{s.deleteHelper, nil}
	ops["POST /api/work-orders/:id/notes"] = operation{s.workNote, obj(o(f("note", str().Trimmed().Min(1).Max(2000))))}
	ops["POST /api/work-orders/:id/materials"] = operation{s.workMaterials, obj(o(f("intention_id", uuid), f("item_id", uuid), f("qty", qty(10000))))}
	ops["POST /api/work-orders/:id/kit"] = operation{s.workKit, obj(o(f("kit_id", uuid)))}
}
func stockMove(ctx context.Context, tx *db.Tx, item any, qty float64, kind string, note, work any, byUnit bool) (jsonx.Object, error) {
	const key = "helper:stockMove"
	i, err := mustRow(ctx, tx, key, 0, "item de estoque não encontrado", item)
	if err != nil {
		return nil, err
	}
	if (i.Get("serialized") == true) != byUnit {
		message := fmt.Sprintf("“%v” não é controlado por número de série", i.Get("name"))
		if i.Get("serialized") == true {
			message = fmt.Sprintf("“%v” é controlado por número de série: movimente pelas unidades", i.Get("name"))
		}
		return nil, apierr.New(400, message)
	}
	if i.Get("active") != true && qty > 0 {
		return nil, apierr.New(400, "item inativo não recebe entradas")
	}
	balance, err := one(ctx, tx, key, 1, item)
	if err != nil {
		return nil, err
	}
	count := num(balance.Get("b"))
	if count+qty < 0 {
		return nil, apierr.New(409, fmt.Sprintf("saldo insuficiente de “%v”: há %g", i.Get("name"), count))
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 2, c.TenantID, item, qty, kind, work, note, c.UserID)
	if err != nil {
		return nil, err
	}
	return jsonx.Object{{Name: "id", Value: row.Get("id")}, {Name: "item_name", Value: i.Get("name")}, {Name: "balance", Value: count + qty}}, nil
}
func staff(ctx context.Context, tx *db.Tx, id any) (jsonx.Object, error) {
	row, err := one(ctx, tx, "helper:staff", 0, id)
	if err == nil && row == nil {
		err = apierr.New(400, "responsável não encontrado neste provedor")
	}
	return row, err
}
func workEvent(ctx context.Context, tx *db.Tx, id any, event string, detail map[string]any) error {
	return fieldEvent(ctx, tx, "helper:woEvent", id, event, detail)
}
func unitEvent(ctx context.Context, tx *db.Tx, id any, event string, detail map[string]any) error {
	return fieldEvent(ctx, tx, "helper:unitEvent", id, event, detail)
}
func fieldEvent(ctx context.Context, tx *db.Tx, key string, id any, event string, detail map[string]any) error {
	if detail == nil {
		detail = map[string]any{}
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	c := auth.From(ctx)
	return tx.Exec(ctx, query(key, 0), c.TenantID, id, nullableUser(c), event, raw)
}
func (s Service) createStockItem(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/stock/items", 0, auth.From(ctx).TenantID, b["name"], b["sku"], b["unit"], b["min_qty"], b["serialized"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "stock.item_create", "stock_item", row.Get("id"), nil)
}
func (s Service) updateStockItem(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/stock/items/:id"
	cur, err := mustRow(ctx, tx, key, 0, "item de estoque não encontrado", id)
	if err != nil {
		return nil, err
	}
	if has(b, "serialized") && b["serialized"] != cur.Get("serialized") {
		r, err := one(ctx, tx, key, 1, id)
		if err != nil {
			return nil, err
		}
		if r != nil {
			return nil, apierr.New(409, "o item já tem movimentos: o controle por número de série não pode mais ser alterado")
		}
	}
	for k, v := range b {
		cur.Set(k, v)
	}
	if err = tx.Exec(ctx, query(key, 2), id, cur.Get("serialized")); err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 3, id, cur.Get("name"), cur.Get("sku"), cur.Get("unit"), cur.Get("min_qty"), cur.Get("active"))
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "stock.item_update", "stock_item", id, b)
}
func (s Service) stockMovement(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	qty := num(b["qty"])
	kind := b["kind"].(string)
	if kind != "adjust" && qty < 0 {
		return nil, apierr.New(400, "informe a quantidade positiva; o tipo define se entra ou sai")
	}
	if kind == "adjust" && (b["note"] == nil || b["note"] == "") {
		return nil, apierr.New(400, "ajuste de estoque exige justificativa")
	}
	if kind == "out" {
		qty = -qty
	}
	row, err := stockMove(ctx, tx, id, qty, kind, nilEmpty(b["note"]), nil, false)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "stock."+kind, "stock_item", id, map[string]any{"qty": b["qty"], "balance": row.Get("balance")})
}
func (s Service) receiveUnits(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/stock/items/:id/units"
	serials := unique(b["serials"].([]any))
	note := nilEmpty(b["note"])
	if note == nil {
		note = fmt.Sprintf("entrada de %d unidade(s)", len(serials))
	}
	movement, err := stockMove(ctx, tx, id, float64(len(serials)), "in", note, nil, true)
	if err != nil {
		return nil, err
	}
	dup, err := rows(ctx, tx, key, 0, id, serials)
	if err != nil {
		return nil, err
	}
	if len(dup) > 0 {
		names := []string{}
		for _, r := range dup[:min(5, len(dup))] {
			names = append(names, r.Get("serial").(string))
		}
		return nil, apierr.New(409, "número(s) de série já cadastrado(s): "+strings.Join(names, ", "))
	}
	for _, serial := range serials {
		row, err := one(ctx, tx, key, 1, auth.From(ctx).TenantID, id, serial)
		if err != nil {
			return nil, err
		}
		if err = unitEvent(ctx, tx, row.Get("id"), "received", nil); err != nil {
			return nil, err
		}
	}
	return map[string]any{"received": len(serials), "balance": movement.Get("balance")}, record(ctx, tx, "stock.units_receive", "stock_item", id, map[string]any{"count": len(serials)})
}
func (s Service) transferUnit(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	unit, err := mustRow(ctx, tx, "helper:lockUnit", 0, "unidade não encontrada", id)
	if err != nil {
		return nil, err
	}
	if !slices.Contains([]any{"in_stock", "with_tech"}, unit.Get("status")) {
		return nil, apierr.New(400, "só unidades em estoque ou com técnico podem ser transferidas")
	}
	status, event := "in_stock", "to_stock"
	detail := map[string]any{}
	if b["holder_id"] != nil {
		user, err := staff(ctx, tx, b["holder_id"])
		if err != nil {
			return nil, err
		}
		status, event = "with_tech", "to_tech"
		detail["to"] = user.Get("name")
	}
	if err = tx.Exec(ctx, query("POST /api/stock/units/:id/transfer", 0), id, status, b["holder_id"]); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, unitEvent(ctx, tx, id, event, detail)
}
func (s Service) unitStatus(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	unit, err := mustRow(ctx, tx, "helper:lockUnit", 0, "unidade não encontrada", id)
	if err != nil {
		return nil, err
	}
	if unit.Get("status") == "written_off" {
		return nil, apierr.New(400, "unidade baixada não volta ao estoque: cadastre uma nova entrada")
	}
	if unit.Get("status") == b["status"] {
		return nil, apierr.New(400, "a unidade já está nessa situação")
	}
	if b["status"] == "written_off" && (b["note"] == nil || b["note"] == "") {
		return nil, apierr.New(400, "informe o motivo da baixa")
	}
	out := unit.Get("status") == "installed"
	if out && b["status"] != "written_off" {
		if _, err = stockMove(ctx, tx, unit.Get("item_id"), 1, "in", fmt.Sprintf("retirada do assinante: %v", unit.Get("serial")), nil, true); err != nil {
			return nil, err
		}
	}
	if !out && b["status"] == "written_off" {
		if _, err = stockMove(ctx, tx, unit.Get("item_id"), -1, "adjust", fmt.Sprintf("baixa %v: %v", unit.Get("serial"), b["note"]), nil, true); err != nil {
			return nil, err
		}
	}
	if err = tx.Exec(ctx, query("POST /api/stock/units/:id/status", 0), id, b["status"]); err != nil {
		return nil, err
	}
	event := b["status"].(string)
	if event == "in_stock" {
		event = "to_stock"
		if out {
			event = "returned"
		}
	}
	detail := map[string]any{"from": unit.Get("status")}
	if b["note"] != nil {
		detail["note"] = b["note"]
	}
	if err = unitEvent(ctx, tx, id, event, detail); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "stock.unit_"+b["status"].(string), "stock_unit", id, map[string]any{"serial": unit.Get("serial")})
}
