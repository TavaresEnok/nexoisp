package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/httpx"

	"github.com/go-chi/chi/v5"
)

func finished(status any) bool { return status == "done" || status == "canceled" }
func parameter(ctx context.Context, name string) string {
	return chi.URLParam(httpx.Request(ctx), name)
}
func (s Service) checklist(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/checklist"
	w, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita alterações")
	}
	start, err := one(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	items := b["items"].([]any)
	for i, label := range items {
		if err = tx.Exec(ctx, query(key, 2), auth.From(ctx).TenantID, id, num(start.Get("p"))+float64(i+1), label); err != nil {
			return nil, err
		}
	}
	return map[string]any{"ok": true}, workEvent(ctx, tx, id, "checklist", map[string]any{"added": len(items)})
}
func (s Service) checklistDone(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/checklist/:itemId"
	w, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita alterações")
	}
	r, err := mustRow(ctx, tx, key, 1, "item não encontrado", parameter(ctx, "itemId"), id, b["done"], auth.From(ctx).UserID)
	if err != nil {
		return nil, err
	}
	event := "checklist_undone"
	if b["done"] == true {
		event = "checklist_done"
	}
	return map[string]any{"ok": true}, workEvent(ctx, tx, id, event, map[string]any{"item": r.Get("label")})
}
func (s Service) addHelper(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/helpers"
	w, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if w.Get("assignee_id") == b["user_id"] {
		return nil, apierr.New(400, "o responsável da OS não é auxiliar dela")
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita alterações de auxiliares")
	}
	user, err := one(ctx, tx, key, 1, b["user_id"])
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, apierr.New(400, "usuário não encontrado neste provedor")
	}
	n, err := tx.Affected(ctx, query(key, 2), auth.From(ctx).TenantID, id, b["user_id"])
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return map[string]any{"ok": true}, nil
	}
	return map[string]any{"ok": true}, history(ctx, tx, key, 3, id, map[string]any{"name": user.Get("name")})
}
func (s Service) deleteHelper(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "DELETE /api/work-orders/:id/helpers/:userId"
	user := parameter(ctx, "userId")
	w, err := mustRow(ctx, tx, "PATCH /api/work-orders/:id", 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita alterações de auxiliares")
	}
	n, err := tx.Affected(ctx, query(key, 0), id, user)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, "auxiliar não encontrado nesta OS")
	}
	return map[string]any{"ok": true}, history(ctx, tx, key, 1, id, map[string]any{"user_id": user})
}
func (s Service) workNote(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	if _, err := mustRow(ctx, tx, "POST /api/work-orders/:id/notes", 0, "ordem de serviço não encontrada", id); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, workEvent(ctx, tx, id, "note", map[string]any{"note": b["note"]})
}
func (s Service) workMaterials(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/materials"
	w, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita material")
	}
	qty := num(b["qty"])
	if qty < 0 {
		used, err := one(ctx, tx, key, 1, id, b["item_id"])
		if err != nil {
			return nil, err
		}
		if num(used.Get("n"))+qty < 0 {
			return nil, apierr.New(400, fmt.Sprintf("devolução maior que o lançado nesta OS (%g)", num(used.Get("n"))))
		}
	}
	kind := "in"
	if qty > 0 {
		kind = "out"
	}
	movement, err := stockMove(ctx, tx, b["item_id"], -qty, kind, fmt.Sprintf("OS %v", w.Get("number")), id, false)
	if err != nil {
		return nil, err
	}
	return movement, workEvent(ctx, tx, id, "material", map[string]any{"item": movement.Get("item_name"), "qty": b["qty"]})
}
func (s Service) workKit(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/kit"
	w, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita material")
	}
	kit, err := one(ctx, tx, key, 1, b["kit_id"])
	if err != nil {
		return nil, err
	}
	if kit == nil || kit.Get("active") != true {
		return nil, apierr.New(404, "kit não encontrado ou inativo")
	}
	items, err := rows(ctx, tx, key, 2, b["kit_id"])
	if err != nil {
		return nil, err
	}
	launched := []map[string]any{}
	for _, item := range items {
		m, err := stockMove(ctx, tx, item.Get("item_id"), -num(item.Get("qty")), "out", fmt.Sprintf("OS %v (kit %v)", w.Get("number"), kit.Get("name")), id, false)
		if err != nil {
			return nil, err
		}
		launched = append(launched, map[string]any{"item": m.Get("item_name"), "qty": item.Get("qty")})
		if err = history(ctx, tx, key, 3, id, map[string]any{"item": m.Get("item_name"), "qty": item.Get("qty"), "kit": kit.Get("name")}); err != nil {
			return nil, err
		}
	}
	return map[string]any{"kit": kit.Get("name"), "launched": launched}, record(ctx, tx, "work_order.kit", "work_order", id, map[string]any{"kit": kit.Get("name"), "items": len(launched)})
}
