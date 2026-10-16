package escrita

import (
	"context"
	"encoding/json"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/validate"
	"strings"
)

func (s Service) configOperations(ops map[string]operation) {
	f, o, str, n, e, b := validate.F, validate.Object, validate.String, validate.Number, validate.Enum, validate.Boolean
	uuid := str().UUID()
	name := func(min, max float64) validate.Rule { return str().Trimmed().Min(min).Max(max) }
	ops["PUT /api/subscribers/:id/contacts"] = operation{s.contacts, obj(o(f("contacts", validate.Array(o(f("kind", e("mobile", "whatsapp", "landline", "email", "responsible")), f("value", name(3, 200)), f("label", text(60).Nullish()), f("purpose", e("general", "billing", "technical").Def("general")), f("allow_notices", b().Def(false)))).Max(20))))}
	ops["POST /api/pops"] = operation{s.createPop, obj(o(f("name", name(2, 80)), f("city", text(80).Nullish()), f("state", str().Trimmed().Length(2).Nullish())))}
	ops["PATCH /api/pops/:id"] = operation{s.updatePop, obj(o(f("name", name(2, 80).Opt()), f("city", text(80).Nullish()), f("state", str().Trimmed().Length(2).Nullish()), f("active", b().Opt())))}
	ops["PUT /api/contracts/:id/pop"] = operation{s.contractPop, obj(o(f("pop_id", uuid.Null())))}
	ops["PUT /api/users/:id/pops"] = operation{s.userPops, obj(o(f("pop_ids", validate.Array(uuid).Max(200))))}
	page := o(f("title", name(3, 80)), f("blocked_text", name(10, 600)), f("reduced_text", text(600).Nullish().Then(nilEmpty, true)), f("phone", text(30).Nullish().Then(nilEmpty, true)), f("whatsapp", str().Trimmed().Pattern(`^\d{10,15}$`, "WhatsApp: só números, com DDI e DDD").Nullish().OrEmpty().Then(nilEmpty, true)), f("show_portal_link", b().Def(true)))
	ops["PUT /api/notice-page"] = operation{s.noticePage, obj(o(f("page", page.Null())))}
	simple(ops, "POST /api/catalogs", o(f("kind", e("ticket_type", "classification", "root_cause", "origin", "os_reason", "end_reason", "note_type")), f("name", name(2, 80))), "", "catalog.create", "catalog_item", []string{":tenant", "kind", "name"}, false)
	simple(ops, "PATCH /api/catalogs/:id", o(f("name", name(2, 80).Opt()), f("active", b().Opt())), "item não encontrado", "catalog.update", "catalog_item", []string{":id", "name", "active"}, false)
	simple(ops, "PATCH /api/install-kits/:id", o(f("active", b())), "kit não encontrado", "install_kit.update", "install_kit", []string{":id", "active"}, false)
	addr := []validate.Field{}
	for _, key := range []string{"street", "number", "district", "city", "state", "zip"} {
		max := float64(120)
		if key == "state" {
			max = 2
		}
		addr = append(addr, f(key, text(max).Nullish().Then(nilEmpty, true)))
	}
	simple(ops, "PUT /api/contracts/:id/install-address", o(addr...), "contrato não encontrado", "contract.install_address", "contract", []string{":id", "street", "number", "district", "city", "state", "zip"}, true)
	policy := o(f("name", name(2, 80)), f("applies_to", e("ticket", "work_order")), f("priority", e("low", "normal", "high").Nullish()), f("kind", e("install", "repair", "address_change", "removal", "other").Nullish()), f("type_id", uuid.Nullish()), f("resolution_minutes", n().Int().Min(5).Max(525600)), f("escalate_to", uuid.Nullish()), f("active", b().Def(true)))
	ops["POST /api/sla-policies"] = operation{s.createSLA, obj(policy)}
	ops["PATCH /api/sla-policies/:id"] = operation{s.updateSLA, obj(o(f("name", name(2, 80).Opt()), f("resolution_minutes", n().Int().Min(5).Max(525600).Opt()), f("escalate_to", uuid.Nullish()), f("active", b().Opt())))}
	ops["DELETE /api/sla-policies/:id"] = operation{s.deleteSLA, nil}
	options := validate.Array(name(1, 60)).Min(1).Max(30)
	ops["POST /api/custom-fields"] = operation{s.createCustomField, obj(o(f("entity", e("subscriber", "contract")), f("key", str().Pattern(`^[a-z][a-z0-9_]{1,29}$`, "identificador: minúsculas, números e _ (2 a 30)")), f("label", name(2, 60)), f("type", e("text", "number", "date", "boolean", "select")), f("options", options.Opt()), f("required", b().Def(false)), f("position", n().Int().Min(0).Max(999).Def(float64(0)))))}
	ops["PATCH /api/custom-fields/:id"] = operation{s.updateCustomField, obj(o(f("label", name(2, 60).Opt()), f("options", options.Opt()), f("required", b().Opt()), f("active", b().Opt()), f("position", n().Int().Min(0).Max(999).Opt())))}
	days := func(min, max float64, message string) validate.Rule {
		return n().Int().Min(min, message).Max(max, message).Null()
	}
	ops["PUT /api/settings/retention"] = operation{s.retention, obj(o(f("auth_log_days", days(7, 365, "log de autenticação: de 7 a 365 dias")), f("sessions_days", days(365, 1825, "registro de conexões: de 365 (mínimo do Marco Civil) a 1825 dias")), f("notice_log_days", days(30, 1825, "registro de avisos: de 30 a 1825 dias"))))}
	ops["PUT /api/noc/settings"] = operation{s.nocSettings, obj(o(f("onu_rx_min_dbm", n().Min(-40).Max(0).Null()), f("pon_outage_min", n().Int().Min(2).Max(500)), f("onu_remove_on_contract_end", b().Opt())))}
}

// simple binds a reviewed single statement, its native schema and its audit in one transaction.
func simple(ops map[string]operation, key string, schema validate.Rule, missing, action, entity string, arguments []string, returnBody bool) {
	ops[key] = operation{schema: obj(schema), handle: func(ctx context.Context, tx *db.Tx, id string, body map[string]any) (any, error) {
		c := auth.From(ctx)
		args := []any{}
		for _, a := range arguments {
			switch a {
			case ":id":
				args = append(args, id)
			case ":tenant":
				args = append(args, c.TenantID)
			case ":user":
				args = append(args, c.UserID)
			default:
				args = append(args, body[a])
			}
		}
		row, err := one(ctx, tx, key, 0, args...)
		if err != nil {
			return nil, err
		}
		if row == nil && missing != "" {
			return nil, apierr.New(404, missing)
		}
		var entityID any = id
		if id == "" {
			entityID = row.Get("id")
		}
		if err = record(ctx, tx, action, entity, entityID, body); err != nil {
			return nil, err
		}
		if returnBody {
			return body, nil
		}
		return row, nil
	}}
}
func (s Service) contacts(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/subscribers/:id/contacts"
	if _, err := mustRow(ctx, tx, key, 0, "assinante não encontrado", id); err != nil {
		return nil, err
	}
	if err := tx.Exec(ctx, query(key, 1), id); err != nil {
		return nil, err
	}
	notices := 0
	list := b["contacts"].([]any)
	for _, item := range list {
		k := item.(map[string]any)
		if k["allow_notices"] == true {
			notices++
		}
		if err := tx.Exec(ctx, query(key, 2), auth.From(ctx).TenantID, id, k["kind"], k["value"], k["label"], k["purpose"], k["allow_notices"]); err != nil {
			return nil, err
		}
	}
	if err := record(ctx, tx, "subscriber.contacts", "subscriber", id, map[string]any{"count": len(list), "notices": notices}); err != nil {
		return nil, err
	}
	return rows(ctx, tx, key, 3, id)
}
func upper(v any) any {
	if v == nil {
		return nil
	}
	return strings.ToUpper(v.(string))
}
func (s Service) createPop(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/pops", 0, auth.From(ctx).TenantID, b["name"], b["city"], upper(b["state"]))
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "já existe um POP com este nome")
	}
	return row, record(ctx, tx, "pop.create", "pop", row.Get("id"), map[string]any{"name": b["name"]})
}
func (s Service) updatePop(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "PATCH /api/pops/:id", 0, "POP não encontrado", id, b["name"], b["city"], upper(b["state"]), b["active"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "pop.update", "pop", id, b)
}
func (s Service) contractPop(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/contracts/:id/pop"
	if b["pop_id"] != nil {
		r, err := one(ctx, tx, key, 0, b["pop_id"])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "POP não encontrado ou inativo")
		}
	}
	if _, err := mustRow(ctx, tx, key, 1, "contrato não encontrado", id, b["pop_id"]); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "contract.pop", "contract", id, b)
}
func unique(values []any) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		s := v.(string)
		if !seen[s] {
			out = append(out, s)
			seen[s] = true
		}
	}
	return out
}
func (s Service) userPops(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/users/:id/pops"
	c := auth.From(ctx)
	ids := unique(b["pop_ids"].([]any))
	u, err := mustRow(ctx, tx, key, 0, "usuário não encontrado", id, c.TenantID)
	if err != nil {
		return nil, err
	}
	if u.Get("role") == "admin" && len(ids) > 0 {
		return nil, apierr.New(400, "administrador não pode ser restrito a POPs; mude o papel antes")
	}
	if len(ids) > 0 {
		n, err := one(ctx, tx, key, 1, ids)
		if err != nil {
			return nil, err
		}
		if num(n.Get("n")) != float64(len(ids)) {
			return nil, apierr.New(400, "POP não encontrado neste provedor")
		}
	}
	if err = tx.Exec(ctx, query(key, 2), id); err != nil {
		return nil, err
	}
	for _, pop := range ids {
		if err = tx.Exec(ctx, query(key, 3), c.TenantID, id, pop); err != nil {
			return nil, err
		}
	}
	out := map[string]any{"pop_ids": ids}
	return out, record(ctx, tx, "user.pops", "user", id, out)
}
func (s Service) noticePage(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	var page any
	if b["page"] != nil {
		raw, err := json.Marshal(b["page"])
		if err != nil {
			return nil, err
		}
		page = raw
	}
	if err := tx.Exec(ctx, query("PUT /api/notice-page", 0), c.TenantID, page, c.UserID); err != nil {
		return nil, err
	}
	return b, record(ctx, tx, "notice_page.update", "tenant", c.TenantID, map[string]any{"enabled": b["page"] != nil})
}
func (s Service) createSLA(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/sla-policies"
	if b["applies_to"] == "work_order" && (b["priority"] != nil || b["type_id"] != nil) {
		return nil, apierr.New(400, "dados: política de OS só filtra por natureza da OS")
	}
	if b["applies_to"] == "ticket" && b["kind"] != nil {
		return nil, apierr.New(400, "dados: política de atendimento não filtra por natureza da OS")
	}
	if b["escalate_to"] != nil {
		r, err := one(ctx, tx, key, 0, b["escalate_to"])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "responsável de escalonamento não encontrado neste provedor")
		}
	}
	if b["type_id"] != nil {
		r, err := one(ctx, tx, key, 1, b["type_id"])
		if err != nil {
			return nil, err
		}
		if r == nil || r.Get("kind") != "ticket_type" {
			return nil, apierr.New(400, "tipo de ocorrência inválido")
		}
	}
	row, err := one(ctx, tx, key, 2, auth.From(ctx).TenantID, b["name"], b["applies_to"], b["priority"], b["kind"], b["type_id"], b["resolution_minutes"], b["escalate_to"], b["active"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "sla.create", "sla_policy", row.Get("id"), b)
}
func (s Service) updateSLA(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/sla-policies/:id"
	if b["escalate_to"] != nil {
		r, err := one(ctx, tx, key, 0, b["escalate_to"])
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "responsável de escalonamento não encontrado neste provedor")
		}
	}
	row, err := mustRow(ctx, tx, key, 1, "política não encontrada", id, b["name"], b["resolution_minutes"], has(b, "escalate_to"), b["escalate_to"], b["active"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "sla.update", "sla_policy", id, b)
}
func (s Service) deleteSLA(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	const key = "DELETE /api/sla-policies/:id"
	r, err := one(ctx, tx, key, 0, id)
	if err != nil {
		return nil, err
	}
	if num(r.Get("n")) > 0 {
		return nil, apierr.New(409, "política já aplicada a ocorrências: desative em vez de excluir")
	}
	n, err := tx.Affected(ctx, query(key, 1), id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, "política não encontrada")
	}
	return map[string]any{"ok": true}, record(ctx, tx, "sla.delete", "sla_policy", id, nil)
}
func (s Service) createCustomField(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	if (b["type"] == "select") != has(b, "options") {
		return nil, apierr.New(400, "dados: opções só para campo de seleção (e obrigatórias nele)")
	}
	row, err := one(ctx, tx, "POST /api/custom-fields", 0, auth.From(ctx).TenantID, b["entity"], b["key"], b["label"], b["type"], b["options"], b["required"], b["position"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "custom_field.create", "custom_field", row.Get("id"), map[string]any{"entity": b["entity"], "key": b["key"], "type": b["type"]})
}
func (s Service) updateCustomField(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/custom-fields/:id"
	cur, err := mustRow(ctx, tx, key, 0, "campo não encontrado", id)
	if err != nil {
		return nil, err
	}
	if has(b, "options") && cur.Get("type") != "select" {
		return nil, apierr.New(400, "opções só valem para campo de seleção")
	}
	row, err := one(ctx, tx, key, 1, id, b["label"], b["options"], b["required"], b["active"], b["position"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "custom_field.update", "custom_field", id, b)
}
func (s Service) retention(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "PUT /api/settings/retention"
	c := auth.From(ctx)
	if err := tx.Exec(ctx, query(key, 0), c.TenantID); err != nil {
		return nil, err
	}
	if err := tx.Exec(ctx, query(key, 1), c.TenantID, b["auth_log_days"], b["sessions_days"], b["notice_log_days"]); err != nil {
		return nil, err
	}
	return b, record(ctx, tx, "settings.retention", "tenant_settings", c.TenantID, b)
}
func (s Service) nocSettings(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	if err := tx.Exec(ctx, query("PUT /api/noc/settings", 0), c.TenantID, b["onu_rx_min_dbm"], b["pon_outage_min"], b["onu_remove_on_contract_end"], c.UserID); err != nil {
		return nil, err
	}
	if err := record(ctx, tx, "noc.settings_update", "tenant_settings", c.TenantID, b); err != nil {
		return nil, err
	}
	rows, err := tx.Objects(ctx, "select onu_rx_min_dbm, pon_outage_min, onu_remove_on_contract_end from tenant_settings where tenant_id = $1", c.TenantID)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"onu_rx_min_dbm": nil, "pon_outage_min": 3, "onu_remove_on_contract_end": false}
	if len(rows) > 0 {
		for k := range out {
			if value := rows[0].Get(k); value != nil {
				if k == "onu_rx_min_dbm" {
					out[k] = validate.JSNumber(fmt.Sprint(value))
				} else {
					out[k] = value
				}
			}
		}
	}
	return out, nil
}
