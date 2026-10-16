package escrita

import (
	"context"
	"errors"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"slices"
)

func (s Service) remainingNetworkOperations(ops map[string]operation) {
	f, o, str, e := validate.F, validate.Object, validate.String, validate.Enum
	ops["POST /api/network/disconnect"] = operation{s.disconnect, obj(o(f("resource_ids", validate.Array(str().UUID()).Min(1).Max(200)), f("reason", str().Trimmed().Min(5, "informe o motivo").Max(200))))}
	ops["POST /api/import/batches/:id/provision"] = operation{s.provisionBatch, nil}
	ops["POST /api/work-orders/:id/status"] = operation{s.workStatus, obj(o(f("status", e("open", "analysis", "awaiting_schedule", "scheduled", "en_route", "in_progress", "done", "canceled")), f("resolution", str().Trimmed().Min(1).Max(2000).Nullish()), f("reason", str().Trimmed().Min(1).Max(300).Nullish()), f("root_cause_id", str().UUID().Nullish())))}
	ops["POST /api/work-orders/:id/units"] = operation{s.installUnit, obj(o(f("unit_id", str().UUID()), f("mode", e("comodato", "sale").Def("comodato"))))}
}
func (s Service) disconnect(ctx context.Context, _ *db.Tx, _ string, b map[string]any) (any, error) {
	results := []map[string]any{}
	seen := map[string]bool{}
	requested := 0
	for _, v := range b["resource_ids"].([]any) {
		id := v.(string)
		if seen[id] {
			continue
		}
		seen[id] = true
		var op jsonx.Object
		err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
			var e error
			op, e = requestNetwork(ctx, tx, id, "subscriber.disconnect", b["reason"].(string), "")
			return e
		})
		row := map[string]any{"resource_id": id, "ok": err == nil}
		if err == nil {
			requested++
			row["operation_id"] = op.Get("id")
		} else {
			var h *apierr.Error
			if !errors.As(err, &h) {
				return nil, err
			}
			row["error"] = h.Message
		}
		results = append(results, row)
	}
	detail := map[string]any{"reason": b["reason"], "requested": requested, "refused": len(results) - requested}
	if err := (audit.Writer{DB: s.DB}).Write(ctx, auth.From(ctx), "network.bulk_disconnect", "network", nil, detail, "ok"); err != nil {
		return nil, err
	}
	detail = map[string]any{"requested": requested, "refused": len(results) - requested, "results": results}
	return detail, nil
}
func (s Service) provisionBatch(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	rs, err := rows(ctx, tx, "POST /api/import/batches/:id/provision", 0, id)
	if err != nil {
		return nil, err
	}
	for _, r := range rs {
		if _, err = requestNetwork(ctx, tx, r.Get("id").(string), "subscriber.provision", "provisionamento de lote importado", ""); err != nil {
			return nil, err
		}
	}
	detail := map[string]any{"requested": len(rs)}
	return detail, record(ctx, tx, "import.provision_batch", "import_batch", id, detail)
}
func (s Service) workStatus(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/status"
	transitions := map[string][]string{"open": {"analysis", "awaiting_schedule", "scheduled", "en_route", "in_progress", "canceled"}, "analysis": {"open", "awaiting_schedule", "scheduled", "en_route", "in_progress", "canceled"}, "awaiting_schedule": {"open", "scheduled", "canceled"}, "scheduled": {"open", "awaiting_schedule", "en_route", "in_progress", "canceled"}, "en_route": {"open", "scheduled", "in_progress", "canceled"}, "in_progress": {"open", "awaiting_schedule", "done", "canceled"}, "done": {}, "canceled": {}}
	cur, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	status := b["status"].(string)
	if !slices.Contains(transitions[cur.Get("status").(string)], status) {
		return nil, apierr.New(400, fmt.Sprintf("não é possível passar de “%v” para “%v”", cur.Get("status"), status))
	}
	if status == "scheduled" && cur.Get("scheduled_for") == nil {
		return nil, apierr.New(400, "defina a data do agendamento antes")
	}
	if status == "en_route" && cur.Get("assignee_id") == nil {
		return nil, apierr.New(400, "defina o técnico antes de registrar o deslocamento")
	}
	if finished(status) && (b["resolution"] == nil || b["resolution"] == "") {
		msg := "informe o motivo do cancelamento"
		if status == "done" {
			msg = "descreva o que foi feito para concluir"
		}
		return nil, apierr.New(400, msg)
	}
	if err = assertCatalog(ctx, tx, b["root_cause_id"], "root_cause", "causa-raiz"); err != nil {
		return nil, err
	}
	w, err := one(ctx, tx, key, 1, id, status, b["resolution"], finished(status), b["reason"], b["root_cause_id"])
	if err != nil {
		return nil, err
	}
	c := auth.From(ctx)
	if status == "done" {
		if err = tx.Exec(ctx, query(key, 2), c.TenantID, id, cur.Get("number"), cur.Get("kind"), cur.Get("subscriber_id")); err != nil {
			return nil, err
		}
	}
	detail := map[string]any{"from": cur.Get("status"), "to": status}
	for _, name := range []string{"resolution", "reason"} {
		if b[name] != nil {
			detail[name] = b[name]
		}
	}
	if err = workEvent(ctx, tx, id, "status", detail); err != nil {
		return nil, err
	}
	if err = domain.Emit(ctx, tx, c.TenantID, "work_order.status_changed", map[string]any{"work_order_id": id, "number": cur.Get("number"), "from": cur.Get("status"), "to": status, "subscriber_id": cur.Get("subscriber_id")}); err != nil {
		return nil, err
	}
	return w, record(ctx, tx, "work_order."+status, "work_order", id, nil)
}
func (s Service) installUnit(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/work-orders/:id/units"
	w, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(w.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não aceita material")
	}
	if w.Get("contract_id") == nil {
		return nil, apierr.New(400, "a ordem de serviço não tem contrato: informe o contrato para instalar um equipamento com série")
	}
	u, err := mustRow(ctx, tx, "helper:lockUnit", 0, "unidade não encontrada", b["unit_id"])
	if err != nil {
		return nil, err
	}
	if u.Get("status") != "in_stock" && u.Get("status") != "with_tech" {
		return nil, apierr.New(409, "a unidade não está disponível (já instalada, com defeito ou baixada)")
	}
	m, err := stockMove(ctx, tx, u.Get("item_id"), -1, "out", fmt.Sprintf("OS %v: %v", w.Get("number"), u.Get("serial")), id, true)
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 1), b["unit_id"], w.Get("contract_id"), id, b["mode"]); err != nil {
		return nil, err
	}
	if err = unitEvent(ctx, tx, b["unit_id"], "installed", map[string]any{"work_order": w.Get("number"), "mode": b["mode"]}); err != nil {
		return nil, err
	}
	if err = workEvent(ctx, tx, id, "material", map[string]any{"item": m.Get("item_name"), "qty": 1, "serial": u.Get("serial")}); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "balance": m.Get("balance")}, nil
}
