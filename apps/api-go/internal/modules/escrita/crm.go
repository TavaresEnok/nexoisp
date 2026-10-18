package escrita

import (
	"context"
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/domain"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"slices"
)

var leadColumns = []string{"name", "phone", "email", "document", "address_street", "address_number", "address_district", "address_city", "address_state", "address_zip", "source", "plan_id", "notes", "owner_id"}

func (s Service) crmOperations(ops map[string]operation) {
	f, o, str, e := validate.F, validate.Object, validate.String, validate.Enum
	uuid := str().UUID()
	txt := func(max float64) validate.Rule { return str().Trimmed().Min(1).Max(max) }
	fields := []validate.Field{}
	subscriber := subscriberSchema()
	for _, key := range leadColumns {
		var rule validate.Rule
		switch key {
		case "source":
			rule = text(80).Nullish().Then(nilEmpty, true)
		case "plan_id", "owner_id":
			rule = uuid.Nullish().Then(func(v any) any { return v }, true)
		default:
			for _, field := range subscriber.Fields {
				if field.Name == key {
					rule = field.Rule
					break
				}
			}
		}
		fields = append(fields, f(key, rule))
	}
	ops["POST /api/leads"] = operation{s.createLead, obj(o(fields...))}
	ops["PATCH /api/leads/:id"] = operation{s.updateLead, obj(o(fields...))}
	ops["POST /api/leads/:id/stage"] = operation{s.leadStage, obj(o(f("stage", e("new", "contacted", "proposal", "lost")), f("lost_reason", txt(300).Nullish())))}
	ops["POST /api/leads/:id/notes"] = operation{s.leadNote, obj(o(f("note", txt(2000))))}
	ops["POST /api/leads/:id/convert"] = operation{s.convertLead, obj(o(f("subscriber_id", uuid.Nullish())))}
	category := e("technical", "financial", "commercial", "other")
	priority := e("low", "normal", "high")
	ops["POST /api/tickets"] = operation{s.createTicket, obj(o(f("subscriber_id", uuid), f("contract_id", uuid.Nullish()), f("subject", txt(200)), f("category", category), f("priority", priority.Def("normal")), f("body", txt(4000)), f("type_id", uuid.Nullish()), f("classification_id", uuid.Nullish()), f("origin_id", uuid.Nullish())))}
	ops["PATCH /api/tickets/:id"] = operation{s.updateTicket, obj(o(f("assignee_id", uuid.Nullish()), f("priority", priority.Opt()), f("category", category.Opt()), f("type_id", uuid.Nullish()), f("classification_id", uuid.Nullish()), f("root_cause_id", uuid.Nullish())))}
	ops["POST /api/tickets/:id/messages"] = operation{s.ticketMessage, obj(o(f("body", txt(4000)), f("internal", validate.Boolean().Def(false))))}
	ops["POST /api/tickets/:id/status"] = operation{s.ticketStatus, obj(o(f("status", e("open", "waiting", "closed"))))}
	ops["POST /api/portal/tickets"] = operation{s.portalTicket, obj(o(f("subject", txt(200)), f("category", category), f("body", txt(4000))))}
	ops["POST /api/portal/tickets/:id/messages"] = operation{s.portalTicketMessage, obj(o(f("body", txt(4000))))}
}
func leadArgs(args []any, b map[string]any) []any {
	for _, key := range leadColumns {
		args = append(args, b[key])
	}
	return args
}
func leadEvent(ctx context.Context, tx *db.Tx, id any, event string, detail map[string]any) error {
	return fieldEvent(ctx, tx, "helper:leadEvent", id, event, detail)
}
func leadContact(ctx context.Context, tx *db.Tx, b map[string]any) error {
	if (b["phone"] == nil || b["phone"] == "") && (b["email"] == nil || b["email"] == "") {
		return apierr.New(400, "informe telefone ou e-mail para contato")
	}
	if b["owner_id"] != nil {
		_, err := staff(ctx, tx, b["owner_id"])
		return err
	}
	return nil
}
func (s Service) createLead(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	if err := leadContact(ctx, tx, b); err != nil {
		return nil, err
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, "POST /api/leads", 0, leadArgs([]any{c.TenantID, c.UserID}, b)...)
	if err != nil {
		return nil, err
	}
	if err = leadEvent(ctx, tx, row.Get("id"), "created", map[string]any{"source": b["source"]}); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "lead.create", "lead", row.Get("id"), nil)
}
func (s Service) updateLead(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	if err := leadContact(ctx, tx, b); err != nil {
		return nil, err
	}
	row, err := mustRow(ctx, tx, "PATCH /api/leads/:id", 0, "prospecto não encontrado", leadArgs([]any{id}, b)...)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "lead.update", "lead", id, nil)
}
func (s Service) leadStage(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/leads/:id/stage"
	if b["stage"] == "lost" && (b["lost_reason"] == nil || b["lost_reason"] == "") {
		return nil, apierr.New(400, "informe o motivo da perda")
	}
	cur, err := mustRow(ctx, tx, key, 0, "prospecto não encontrado", id)
	if err != nil {
		return nil, err
	}
	if cur.Get("stage") == "won" {
		return nil, apierr.New(400, "prospecto já convertido em assinante")
	}
	var reason any
	if b["stage"] == "lost" {
		reason = b["lost_reason"]
	}
	row, err := one(ctx, tx, key, 1, id, b["stage"], reason)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"from": cur.Get("stage"), "to": b["stage"]}
	if b["lost_reason"] != nil {
		detail["reason"] = b["lost_reason"]
	}
	if err = leadEvent(ctx, tx, id, "stage", detail); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "lead.stage", "lead", id, map[string]any{"to": b["stage"]})
}
func (s Service) leadNote(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	n, err := tx.Affected(ctx, query("POST /api/leads/:id/notes", 0), id)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, apierr.New(404, "prospecto não encontrado")
	}
	return map[string]any{"ok": true}, leadEvent(ctx, tx, id, "note", map[string]any{"note": b["note"]})
}
func (s Service) convertLead(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/leads/:id/convert"
	c := auth.From(ctx)
	if !slices.Contains(c.Permissions, "subscribers:write") {
		return nil, apierr.New(403, "sem permissão para cadastrar assinantes")
	}
	lead, err := mustRow(ctx, tx, key, 0, "prospecto não encontrado", id)
	if err != nil {
		return nil, err
	}
	if lead.Get("stage") == "won" {
		return nil, apierr.New(400, "prospecto já convertido em assinante")
	}
	subscriber := b["subscriber_id"]
	if subscriber != nil {
		row, err := one(ctx, tx, key, 1, subscriber)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apierr.New(400, "assinante não encontrado")
		}
	} else {
		data := map[string]any{"status": "active"}
		for _, v := range lead {
			data[v.Name] = v.Value
		}
		data["status"] = "active"
		clean, err := subscriberSchema().Parse(data, true)
		if err != nil {
			return nil, err
		}
		if clean["document"] != nil {
			row, err := one(ctx, tx, key, 2, clean["document"])
			if err != nil {
				return nil, err
			}
			if row != nil {
				return nil, apierr.New(409, "já existe um assinante com este CPF/CNPJ: vincule o prospecto a ele")
			}
		}
		cols := []string{"name", "document", "email", "phone", "address_street", "address_number", "address_district", "address_city", "address_state", "address_zip", "notes"}
		args := []any{c.TenantID}
		for _, col := range cols {
			args = append(args, clean[col])
		}
		row, err := one(ctx, tx, key, 3, args...)
		if err != nil {
			return nil, err
		}
		subscriber = row.Get("id")
		if err = record(ctx, tx, "subscriber.create", "subscriber", subscriber, map[string]any{"from_lead": id}); err != nil {
			return nil, err
		}
	}
	if err = tx.Exec(ctx, query(key, 4), id, subscriber); err != nil {
		return nil, err
	}
	if err = leadEvent(ctx, tx, id, "converted", map[string]any{"subscriber_id": subscriber, "linked_existing": b["subscriber_id"] != nil}); err != nil {
		return nil, err
	}
	detail := map[string]any{"subscriber_id": subscriber}
	return detail, record(ctx, tx, "lead.convert", "lead", id, detail)
}
func openTicket(ctx context.Context, tx *db.Tx, b map[string]any) (jsonx.Object, error) {
	const key = "helper:openTicket"
	c := auth.From(ctx)
	number, err := domain.NextNumber(ctx, tx, c.TenantID, "ticket")
	if err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 0, c.TenantID, number, b["subscriber_id"], b["contract_id"], b["subject"], b["category"], b["priority"], b["origin"], nullableUser(c), b["type_id"], b["classification_id"], b["origin_id"])
	if err != nil {
		return nil, err
	}
	if _, err = domain.ApplySLA(ctx, tx, "ticket", row.Get("id")); err != nil {
		return nil, err
	}
	sla, err := one(ctx, tx, key, 1, row.Get("id"))
	if err != nil {
		return nil, err
	}
	for _, v := range sla {
		row.Set(v.Name, v.Value)
	}
	kind := "staff"
	if b["origin"] == "portal" {
		kind = "subscriber"
	}
	if err = tx.Exec(ctx, query(key, 2), c.TenantID, row.Get("id"), nullableUser(c), kind, b["body"]); err != nil {
		return nil, err
	}
	return row, domain.Emit(ctx, tx, c.TenantID, "ticket.created", map[string]any{"ticket_id": row.Get("id"), "number": row.Get("number"), "subscriber_id": b["subscriber_id"], "category": b["category"], "priority": b["priority"], "origin": b["origin"]})
}
func (s Service) createTicket(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/tickets"
	for _, v := range []struct{ field, kind, label string }{{"type_id", "ticket_type", "tipo"}, {"classification_id", "classification", "classificação"}, {"origin_id", "origin", "origem"}} {
		if err := assertCatalog(ctx, tx, b[v.field], v.kind, v.label); err != nil {
			return nil, err
		}
	}
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
	b["origin"] = "staff"
	row, err := openTicket(ctx, tx, b)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ticket.create", "ticket", row.Get("id"), map[string]any{"number": row.Get("number"), "category": b["category"]})
}
func (s Service) updateTicket(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/tickets/:id"
	if b["assignee_id"] != nil {
		if _, err := staff(ctx, tx, b["assignee_id"]); err != nil {
			return nil, err
		}
	}
	for _, v := range []struct{ field, kind, label string }{{"type_id", "ticket_type", "tipo"}, {"classification_id", "classification", "classificação"}, {"root_cause_id", "root_cause", "causa-raiz"}} {
		if err := assertCatalog(ctx, tx, b[v.field], v.kind, v.label); err != nil {
			return nil, err
		}
	}
	row, err := mustRow(ctx, tx, key, 0, "atendimento não encontrado", id, has(b, "assignee_id"), b["assignee_id"], b["priority"], b["category"], has(b, "type_id"), b["type_id"], has(b, "classification_id"), b["classification_id"], has(b, "root_cause_id"), b["root_cause_id"])
	if err != nil {
		return nil, err
	}
	if has(b, "priority") || has(b, "type_id") {
		if _, err = domain.ApplySLA(ctx, tx, "ticket", id); err != nil {
			return nil, err
		}
		sla, err := one(ctx, tx, key, 1, id)
		if err != nil {
			return nil, err
		}
		for _, v := range sla {
			row.Set(v.Name, v.Value)
		}
	}
	return row, record(ctx, tx, "ticket.update", "ticket", id, b)
}
func (s Service) ticketMessage(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/tickets/:id/messages"
	t, err := mustRow(ctx, tx, key, 0, "atendimento não encontrado", id)
	if err != nil {
		return nil, err
	}
	if t.Get("status") == "closed" {
		return nil, apierr.New(400, "atendimento encerrado: reabra para responder")
	}
	c := auth.From(ctx)
	if err = tx.Exec(ctx, query(key, 1), c.TenantID, id, c.UserID, b["body"], b["internal"]); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 2), id, b["internal"]); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
func (s Service) ticketStatus(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "POST /api/tickets/:id/status", 0, "atendimento não encontrado", id, b["status"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "ticket."+b["status"].(string), "ticket", id, nil)
}
func (s Service) portalTicket(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/portal/tickets"
	c := auth.From(ctx)
	if c.SubscriberID == "" {
		return nil, apierr.New(403, "sessão sem assinante")
	}
	count, err := one(ctx, tx, key, 0, c.SubscriberID)
	if err != nil {
		return nil, err
	}
	if num(count.Get("n")) >= 5 {
		return nil, apierr.New(429, "você já tem atendimentos em aberto: acompanhe ou responda um deles")
	}
	b["subscriber_id"], b["contract_id"], b["priority"], b["origin"] = c.SubscriberID, nil, "normal", "portal"
	row, err := openTicket(ctx, tx, b)
	if err != nil {
		return nil, err
	}
	if err = domain.QueueNotice(ctx, tx, c.TenantID, "ticket.opened", fmt.Sprintf("novo chamado pelo portal — protocolo %v: %v (%s)", row.Get("number"), b["subject"], c.Name), map[string]any{"ticket_id": row.Get("id"), "number": row.Get("number")}); err != nil {
		return nil, err
	}
	return map[string]any{"id": row.Get("id"), "number": row.Get("number")}, record(ctx, tx, "ticket.create", "ticket", row.Get("id"), map[string]any{"number": row.Get("number"), "origin": "portal"})
}
func (s Service) portalTicketMessage(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/portal/tickets/:id/messages"
	c := auth.From(ctx)
	if c.SubscriberID == "" {
		return nil, apierr.New(403, "sessão sem assinante")
	}
	t, err := mustRow(ctx, tx, key, 0, "atendimento não encontrado", id, c.SubscriberID)
	if err != nil {
		return nil, err
	}
	if t.Get("status") == "closed" {
		return nil, apierr.New(400, "atendimento encerrado: abra um novo")
	}
	if err = tx.Exec(ctx, query(key, 1), c.TenantID, id, c.UserID, b["body"]); err != nil {
		return nil, err
	}
	t, err = one(ctx, tx, key, 2, id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, domain.QueueNotice(ctx, tx, c.TenantID, "ticket.subscriber_reply", fmt.Sprintf("o assinante respondeu o protocolo %v: %v (%s)", t.Get("number"), t.Get("subject"), c.Name), map[string]any{"ticket_id": id, "number": t.Get("number")})
}
