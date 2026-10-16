package outbound

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
)

func SLA(ctx context.Context, tx *db.Tx, tenant string) error {
	for _, entity := range []string{"ticket", "work_order"} {
		index := 0
		if entity == "work_order" {
			index = 4
		}
		rows, e := tx.Objects(ctx, RoutineSQL("runSla", index), tenant)
		if e != nil {
			return e
		}
		for _, r := range rows {
			var esc jsonx.Object
			if r.Get("sla_policy_id") != nil {
				rs, e := tx.Objects(ctx, RoutineSQL("runSla", index+1), r.Get("sla_policy_id"))
				if e != nil {
					return e
				}
				if len(rs) > 0 {
					esc = rs[0]
				}
			}
			escalated := esc.Get("escalate_to") != nil && esc.Get("escalate_to") != r.Get("assignee_id")
			if escalated {
				if e = tx.Exec(ctx, RoutineSQL("runSla", index+2), r.Get("id"), esc.Get("escalate_to")); e != nil {
					return e
				}
			}
			var payload any
			if entity == "ticket" {
				policy := "política"
				if esc.Get("name") != nil {
					policy = fmt.Sprint(esc.Get("name"))
				}
				note := "Prazo de SLA vencido (" + policy + ")."
				if escalated {
					note += fmt.Sprintf(" Escalonado para %v.", esc.Get("to_name"))
				}
				payload = note
			} else {
				detail := map[string]any{"policy": esc.Get("name")}
				if escalated {
					detail["escalated_to"] = esc.Get("to_name")
				}
				encoded, e := jsonx.Encode(detail)
				if e != nil {
					return e
				}
				payload = encoded
			}
			if e = tx.Exec(ctx, RoutineSQL("runSla", index+3), tenant, r.Get("id"), payload); e != nil {
				return e
			}
			message := fmt.Sprintf("SLA vencido na OS %v", r.Get("number"))
			data := map[string]any{"work_order_id": r.Get("id"), "number": r.Get("number")}
			if entity == "ticket" {
				message = fmt.Sprintf("SLA vencido no atendimento %v: %v", r.Get("number"), r.Get("subject"))
				data = map[string]any{"ticket_id": r.Get("id"), "number": r.Get("number")}
			}
			if e = domain.QueueNotice(ctx, tx, tenant, "sla.breached", message, data); e != nil {
				return e
			}
			if e = domain.Emit(ctx, tx, tenant, "sla.breached", map[string]any{"entity": entity, "id": r.Get("id"), "number": r.Get("number")}); e != nil {
				return e
			}
		}
	}
	return nil
}
