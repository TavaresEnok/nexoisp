package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/outbound"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
)

func (s Service) noticeRun(ctx context.Context, _ *db.Tx, _ string, _ map[string]any) (any, error) {
	r, e := outbound.Notices(ctx, s.DB, auth.From(ctx).TenantID, false)
	if e != nil {
		return nil, e
	}
	return r, (audit.Writer{DB: s.DB}).Write(ctx, auth.From(ctx), "notice_rules.run", "", nil, r, "ok")
}
func (s Service) maintenanceNotify(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/maintenance-notices/:id/notify"
	m, e := mustRow(ctx, tx, key, 0, "aviso não encontrado", id)
	if e != nil {
		return nil, e
	}
	if m.Get("state") == "canceled" {
		return nil, apierr.New(409, "aviso cancelado")
	}
	if b["phase"] == "resolved" && m.Get("notified_start_at") == nil {
		return nil, apierr.New(409, "o aviso de início não foi enviado; não há o que normalizar")
	}
	mod, e := one(ctx, tx, key, 1, auth.From(ctx).TenantID)
	if e != nil {
		return nil, e
	}
	if mod.Get("on") != true {
		return nil, &apierr.Error{Status: 409, Message: "o módulo de avisos ao assinante não está liberado para o provedor", Code: "module_disabled"}
	}
	ch, e := one(ctx, tx, key, 2, b["channel_id"])
	if e != nil {
		return nil, e
	}
	if ch == nil {
		return nil, apierr.New(400, "canal de envio não encontrado ou inativo")
	}
	text := b["text"]
	if text == nil {
		if b["phase"] == "start" {
			text = fmt.Sprintf("%v: %v", m.Get("title"), m.Get("message"))
		} else {
			text = fmt.Sprintf("%v: serviço normalizado. Obrigado pela paciência.", m.Get("title"))
		}
	}
	rs, e := rows(ctx, tx, key, 3, auth.From(ctx).TenantID, m.Get("device_id"), b["channel_id"], text, id, b["phase"])
	if e != nil {
		return nil, e
	}
	column := "notified_start_at"
	if b["phase"] == "resolved" {
		column = "notified_resolved_at"
	}
	if e = tx.Exec(ctx, queryFragments(key, 4, map[string]string{"undefined": column}), id); e != nil {
		return nil, e
	}
	queued := 0
	for _, r := range rs {
		if r.Get("status") == "queued" {
			queued++
		}
	}
	detail := map[string]any{"phase": b["phase"], "queued": queued, "skipped_no_consent": len(rs) - queued}
	if e = record(ctx, tx, "maintenance_notice.notify", "maintenance_notice", id, detail); e != nil {
		return nil, e
	}
	detail["already_sent"] = max(0, num(m.Get("affected_subscribers"))-float64(len(rs)))
	return detail, nil
}
func (s Service) routineOperations(ops map[string]operation) {
	f, o, str := validate.F, validate.Object, validate.String
	ops["POST /api/notice-rules/run"] = operation{s.noticeRun, nil}
	ops["POST /api/maintenance-notices/:id/notify"] = operation{s.maintenanceNotify, obj(o(f("channel_id", str().UUID()), f("phase", validate.Enum("start", "resolved").Def("start")), f("text", text(600).Min(3).Opt())))}
}
func (s Service) Scheduled(ctx context.Context, tenant string) (map[string]any, error) {
	scope := tenancy.Scope{TenantID: tenant}
	ctx = auth.With(ctx, &auth.Ctx{TenantID: tenant, Scope: scope})
	var due []jsonx.Object
	e := s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
		var e error
		due, e = tx.Objects(ctx, outbound.RoutineSQL("applyScheduledChanges", 0), tenant)
		return e
	})
	if e != nil {
		return nil, e
	}
	out := map[string]any{"applied": 0, "failed": 0}
	for _, r := range due {
		e = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
			b := map[string]any{"penalty_due_days": float64(10)}
			switch r.Get("kind") {
			case "plan_change":
				b["plan_id"] = r.Get("plan_id")
			case "due_day":
				b["due_day"] = r.Get("due_day")
			case "end":
				b["end"] = true
				b["end_reason_id"] = r.Get("end_reason_id")
				b["end_note"] = r.Get("note")
				if b["end_note"] == nil {
					b["end_note"] = "encerramento agendado"
				}
				for _, k := range []string{"penalty", "penalty_waive_reason"} {
					if r.Get(k) != nil {
						b[k] = r.Get(k)
					}
				}
			}
			if e := changeContract(ctx, tx, r.Get("contract_id").(string), b, "mudanca-agendada"); e != nil {
				return e
			}
			if e := tx.Exec(ctx, outbound.RoutineSQL("applyScheduledChanges", 1), r.Get("id")); e != nil {
				return e
			}
			return domain.Emit(ctx, tx, tenant, "contract.changed", map[string]any{"contract_id": r.Get("contract_id"), "kind": r.Get("kind"), "scheduled": true})
		})
		if e == nil {
			out["applied"] = out["applied"].(int) + 1
		} else {
			out["failed"] = out["failed"].(int) + 1
			message := e.Error()
			if len(message) > 300 {
				message = message[:300]
			}
			if e = s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
				return tx.Exec(ctx, outbound.RoutineSQL("applyScheduledChanges", 2), r.Get("id"), message)
			}); e != nil {
				return nil, e
			}
		}
	}
	return out, nil
}
