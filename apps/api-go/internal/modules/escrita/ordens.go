package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/validate"
	"os"
)

func (s Service) workOperations(ops map[string]operation) {
	f, o, str, n, b, e := validate.F, validate.Object, validate.String, validate.Number, validate.Boolean, validate.Enum
	uuid := str().UUID()
	when := str().Refine(validDateTime, "Invalid datetime")
	description := str().Trimmed().Min(1).Max(2000)
	ops["POST /api/work-orders"] = operation{s.createWork, obj(o(f("kind", e("install", "repair", "address_change", "removal", "other")), f("subscriber_id", uuid), f("contract_id", uuid.Nullish()), f("description", description), f("assignee_id", uuid.Nullish()), f("scheduled_for", when.Nullish()), f("ticket_id", uuid.Nullish()), f("reason_id", uuid.Nullish()), f("estimated_minutes", n().Int().Min(5).Max(1440).Def(float64(60))), f("address_origin", e("subscriber", "contract", "manual").Def("subscriber")), f("address_text", str().Trimmed().Min(5).Max(300).Nullish())))}
	ops["PATCH /api/work-orders/:id"] = operation{s.updateWork, obj(o(f("assignee_id", uuid.Nullish()), f("scheduled_for", when.Nullish()), f("description", description.Opt()), f("estimated_minutes", n().Int().Min(5).Max(1440).Opt())))}
	ops["PUT /api/finance/settings"] = operation{s.financeSettings, obj(o(f("gateway", e("none", "demo")), f("billing_auto", b()), f("auto_suspend", b()), f("suspend_after_days", n().Int().Min(0).Max(365).Null()), f("auto_resume_on_payment", b()), f("suspension_mode", e("reject", "profile").Opt()), f("trust_release_enabled", b().Opt()), f("trust_release_days", n().Int().Min(1).Max(30).Opt()), f("trust_release_gap_days", n().Int().Min(0).Max(365).Opt()), f("late_fee_percent", n().Min(0).Max(20).Opt()), f("interest_monthly_percent", n().Min(0).Max(20).Opt()), f("prorate_first_month", b().Opt()), f("suspension_profile", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{1,60}$`, "perfil: letras, números, _ . - (até 60)").Nullish())))}
	ops["DELETE /api/ipam/delegations/:id"] = operation{s.releaseIPv6, nil}
}
func createWork(ctx context.Context, tx *db.Tx, b map[string]any) (jsonx.Object, error) {
	const key = "helper:createWorkOrder"
	c := auth.From(ctx)
	sub, err := one(ctx, tx, key, 0, b["subscriber_id"])
	if err != nil {
		return nil, err
	}
	if sub == nil {
		return nil, apierr.New(400, "assinante não encontrado")
	}
	if b["contract_id"] != nil {
		r, err := one(ctx, tx, key, 1, b["contract_id"], b["subscriber_id"])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "o contrato não pertence a este assinante")
		}
	}
	if b["ticket_id"] != nil {
		r, err := one(ctx, tx, key, 2, b["ticket_id"], b["subscriber_id"])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "o atendimento não pertence a este assinante")
		}
	}
	if b["assignee_id"] != nil {
		if _, err = staff(ctx, tx, b["assignee_id"]); err != nil {
			return nil, err
		}
	}
	if err = assertCatalog(ctx, tx, b["reason_id"], "os_reason", "motivo da OS"); err != nil {
		return nil, err
	}
	var address any
	if b["address_origin"] == "manual" {
		if b["address_text"] == nil || b["address_text"] == "" {
			return nil, apierr.New(400, "informe o endereço da OS")
		}
		address = b["address_text"]
	} else if b["address_origin"] == "contract" {
		if b["contract_id"] == nil {
			return nil, apierr.New(400, "escolha o contrato para usar o endereço de instalação dele")
		}
		r, err := one(ctx, tx, key, 3, b["contract_id"])
		if err != nil {
			return nil, err
		}
		if r.Get("install_street") == nil || r.Get("install_street") == "" || r.Get("install_city") == nil || r.Get("install_city") == "" {
			return nil, apierr.New(400, "o contrato não tem endereço de instalação cadastrado")
		}
		address = r.Get("a")
	}
	number, err := domain.NextNumber(ctx, tx, c.TenantID, "work_order")
	if err != nil {
		return nil, err
	}
	status := "open"
	if b["scheduled_for"] != nil {
		status = "scheduled"
	}
	row, err := one(ctx, tx, key, 4, c.TenantID, number, b["kind"], status, b["subscriber_id"], b["contract_id"], b["assignee_id"], b["scheduled_for"], b["description"], nullableUser(c), b["ticket_id"], b["reason_id"], b["estimated_minutes"], b["address_origin"], address)
	if err != nil {
		return nil, err
	}
	if _, err = domain.ApplySLA(ctx, tx, "work_order", row.Get("id")); err != nil {
		return nil, err
	}
	sla, err := one(ctx, tx, key, 5, row.Get("id"))
	if err != nil {
		return nil, err
	}
	for _, v := range sla {
		row.Set(v.Name, v.Value)
	}
	if err = workEvent(ctx, tx, row.Get("id"), "created", map[string]any{"kind": b["kind"]}); err != nil {
		return nil, err
	}
	sn, err := one(ctx, tx, key, 6, b["subscriber_id"])
	if err != nil {
		return nil, err
	}
	text := fmt.Sprintf("OS %v aberta (%v) para %v", number, b["kind"], sn.Get("name"))
	if b["scheduled_for"] != nil {
		text += fmt.Sprintf(", agendada para %v", b["scheduled_for"])
	}
	if err = domain.QueueNotice(ctx, tx, c.TenantID, "work_order.created", text, map[string]any{"work_order_id": row.Get("id"), "number": number}); err != nil {
		return nil, err
	}
	return row, domain.Emit(ctx, tx, c.TenantID, "work_order.created", map[string]any{"work_order_id": row.Get("id"), "number": number, "kind": b["kind"], "subscriber_id": b["subscriber_id"], "contract_id": b["contract_id"]})
}
func (s Service) createWork(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	row, err := createWork(ctx, tx, b)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "work_order.create", "work_order", row.Get("id"), map[string]any{"number": row.Get("number"), "kind": b["kind"]})
}
func (s Service) updateWork(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/work-orders/:id"
	cur, err := mustRow(ctx, tx, key, 0, "ordem de serviço não encontrada", id)
	if err != nil {
		return nil, err
	}
	if finished(cur.Get("status")) {
		return nil, apierr.New(400, "ordem de serviço encerrada não pode ser alterada")
	}
	if has(b, "assignee_id") && b["assignee_id"] != cur.Get("assignee_id") {
		var name any
		if b["assignee_id"] != nil {
			u, err := staff(ctx, tx, b["assignee_id"])
			if err != nil {
				return nil, err
			}
			name = u.Get("name")
		}
		cur.Set("assignee_id", b["assignee_id"])
		if err = workEvent(ctx, tx, id, "assigned", map[string]any{"to": name}); err != nil {
			return nil, err
		}
		if name != nil {
			if err = domain.QueueNotice(ctx, tx, auth.From(ctx).TenantID, "work_order.assigned", fmt.Sprintf("OS %v atribuída a %v", cur.Get("number"), name), map[string]any{"work_order_id": id, "number": cur.Get("number")}); err != nil {
				return nil, err
			}
		}
	}
	if has(b, "scheduled_for") {
		cur.Set("scheduled_for", b["scheduled_for"])
		if cur.Get("status") == "open" || cur.Get("status") == "scheduled" || cur.Get("status") == "awaiting_schedule" {
			if b["scheduled_for"] != nil {
				cur.Set("status", "scheduled")
			} else if cur.Get("status") != "awaiting_schedule" {
				cur.Set("status", "open")
			}
		}
		if err = workEvent(ctx, tx, id, "scheduled", map[string]any{"for": b["scheduled_for"]}); err != nil {
			return nil, err
		}
	}
	if b["description"] != nil {
		cur.Set("description", b["description"])
	}
	minutes := b["estimated_minutes"]
	if minutes == nil {
		minutes = cur.Get("estimated_minutes")
	}
	row, err := one(ctx, tx, key, 1, id, cur.Get("assignee_id"), cur.Get("scheduled_for"), cur.Get("status"), cur.Get("description"), minutes)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "work_order.update", "work_order", id, b)
}
func (s Service) financeSettings(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	if b["gateway"] == "demo" && os.Getenv("NEXO_DEMO_MODE") != "1" {
		return nil, apierr.New(400, "gateway de demonstração não é permitido fora do modo demonstração")
	}
	if b["auto_suspend"] == true && b["suspend_after_days"] == nil {
		return nil, apierr.New(400, "informe após quantos dias de atraso a suspensão ocorre")
	}
	c := auth.From(ctx)
	cur, err := leitura.GetSettings(ctx, tx, c.TenantID)
	if err != nil {
		return nil, err
	}
	mode := b["suspension_mode"]
	if mode == nil {
		mode = cur.Get("suspension_mode")
	}
	profile := cur.Get("suspension_profile")
	if has(b, "suspension_profile") {
		profile = nilEmpty(b["suspension_profile"])
	}
	if mode == "profile" && (profile == nil || profile == "") {
		return nil, apierr.New(400, "informe o nome do perfil de bloqueio que existe no NAS")
	}
	if mode != "profile" {
		profile = nil
	}
	args := []any{c.TenantID, b["gateway"], b["billing_auto"], b["auto_suspend"], b["suspend_after_days"], b["auto_resume_on_payment"], mode, profile, c.UserID}
	for _, key := range []string{"trust_release_enabled", "trust_release_days", "trust_release_gap_days", "late_fee_percent", "interest_monthly_percent", "prorate_first_month"} {
		value := b[key]
		if value == nil {
			value = cur.Get(key)
		}
		args = append(args, value)
	}
	row, err := one(ctx, tx, "PUT /api/finance/settings", 0, args...)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "finance.settings_update", "tenant_settings", c.TenantID, b)
}
func (s Service) releaseIPv6(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/ipam/delegations/:id", 0, "delegação não encontrada", id)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{}
	for _, v := range row {
		detail[v.Name] = v.Value
	}
	return map[string]any{"ok": true}, record(ctx, tx, "ipam.release_v6", "ip6_delegation", id, detail)
}
