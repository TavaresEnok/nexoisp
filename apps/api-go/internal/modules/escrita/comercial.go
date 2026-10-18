package escrita

import (
	"context"
	"encoding/json"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/validate"
)

func (s Service) conditionOperations(ops map[string]operation) {
	f := validate.F
	o := validate.Object
	n := validate.Number
	str := validate.String
	e := validate.Enum
	uuid := str().UUID()
	date := str().Pattern(`^\d{4}-\d{2}-\d{2}$`, "data inválida")
	name := func(min, max float64) validate.Rule { return str().Trimmed().Min(min).Max(max) }
	price := n().Int().Min(0).Max(100000000)
	loyalty := []validate.Field{f("months", n().Int().Min(1).Max(60).Null()), f("penalty_model", e("fixed", "monthly").Nullish()), f("penalty_cents", price.Nullish())}
	month := str().Pattern(`^\d{4}-(0[1-9]|1[0-2])(-01)?$`, "competência inválida (AAAA-MM)").Then(func(v any) any {
		s := v.(string)
		if len(s) == 7 {
			return s + "-01"
		}
		return s
	}, false)
	ops["POST /api/addons"] = operation{s.createAddon, obj(o(f("name", name(2, 80)), f("price_cents", price)))}
	ops["PATCH /api/addons/:id"] = operation{s.updateAddon, obj(o(f("price_cents", price.Opt()), f("active", validate.Boolean().Opt())))}
	ops["POST /api/contracts/:id/addons"] = operation{s.contractAddon, obj(o(f("product_id", uuid), f("quantity", n().Int().Min(1).Max(99).Def(float64(1))), f("unit_price_cents", price.Opt()), f("from_competence", month.Opt())))}
	ops["PUT /api/plans/:id/loyalty"] = operation{s.planLoyalty, obj(o(loyalty...))}
	ops["PUT /api/contracts/:id/loyalty"] = operation{s.contractLoyalty, obj(o(append(append([]validate.Field{}, loyalty...), f("from", date.Opt()))...))}
	ops["POST /api/contracts/:id/discounts"] = operation{s.discount, obj(o(f("kind", e("percent", "fixed")), f("value", n().Int().Positive().Max(100000000)), f("reason", name(3, 120)), f("from_competence", date.Opt()), f("months", n().Int().Min(1).Max(120).Nullish())))}
	ops["DELETE /api/discounts/:id"] = operation{s.cancelDiscount, nil}
	ops["PUT /api/contracts/:id/referral"] = operation{s.referral, obj(o(f("referrer_subscriber_id", uuid.Null())))}
	ops["POST /api/contracts/:id/scheduled-changes"] = operation{s.schedule, obj(o(f("kind", e("plan_change", "due_day", "end")), f("effective_date", date), f("plan_id", uuid.Nullish()), f("due_day", n().Int().Min(1).Max(28).Nullish()), f("end_reason_id", uuid.Nullish()), f("penalty", e("charge", "waive").Nullish()), f("penalty_waive_reason", name(5, 200).Nullish()), f("note", text(300).Nullish())))}
	ops["DELETE /api/scheduled-changes/:id"] = operation{s.cancelSchedule, nil}
	ops["POST /api/contracts/:id/amendments"] = operation{s.amendment, obj(o(f("kind", e("address", "holder", "plan", "condition", "other")), f("title", name(3, 120)), f("body", name(1, 4000)), f("effective_date", date.Opt())))}
}
func loyaltyValues(b map[string]any) (any, any, error) {
	if b["months"] == nil {
		return nil, nil, nil
	}
	if b["penalty_model"] == nil || b["penalty_cents"] == nil {
		return nil, nil, apierr.New(400, "dados: informe o modelo e o valor da multa")
	}
	return b["penalty_model"], b["penalty_cents"], nil
}
func (s Service) planLoyalty(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	model, cents, err := loyaltyValues(b)
	if err != nil {
		return nil, err
	}
	row, err := mustRow(ctx, tx, "PUT /api/plans/:id/loyalty", 0, "plano não encontrado", id, b["months"], model, cents)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "plan.loyalty", "plan", id, b)
}
func (s Service) contractLoyalty(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/contracts/:id/loyalty"
	model, cents, err := loyaltyValues(b)
	if err != nil {
		return nil, err
	}
	row, err := mustRow(ctx, tx, key, 0, "contrato ativo não encontrado", id, b["months"], b["from"], model, cents)
	if err != nil {
		return nil, err
	}
	if err = history(ctx, tx, key, 1, id, map[string]any{"months": b["months"], "until": row.Get("loyalty_until"), "model": row.Get("penalty_model"), "cents": row.Get("penalty_cents")}); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "contract.loyalty", "contract", id, b)
}
func history(ctx context.Context, tx *db.Tx, key string, index int, id any, detail map[string]any) error {
	c := auth.From(ctx)
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	return tx.Exec(ctx, query(key, index), c.TenantID, id, c.UserID, raw)
}
func (s Service) discount(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/discounts"
	if b["kind"] == "percent" && num(b["value"]) > 100 {
		return nil, apierr.New(400, "dados: percentual de 1 a 100")
	}
	k, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	if k.Get("status") != "active" {
		return nil, apierr.New(400, "contrato encerrado não recebe desconto")
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 1, c.TenantID, id, b["kind"], b["value"], b["reason"], b["from_competence"], b["months"], c.UserID)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "contract.discount", "contract", id, map[string]any{"discount_id": row.Get("id"), "kind": b["kind"], "value": b["value"], "months": b["months"]})
}
func (s Service) cancelDiscount(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/discounts/:id", 0, "desconto não encontrado", id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "contract.discount_cancel", "contract", row.Get("contract_id"), map[string]any{"discount_id": id})
}
func (s Service) referral(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/contracts/:id/referral"
	if b["referrer_subscriber_id"] != nil {
		row, err := one(ctx, tx, key, 0, b["referrer_subscriber_id"])
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apierr.New(400, "assinante indicador não encontrado")
		}
	}
	row, err := one(ctx, tx, key, 1, id, b["referrer_subscriber_id"])
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(400, "contrato não encontrado ou o indicador é o próprio assinante")
	}
	return row, record(ctx, tx, "contract.referral", "contract", id, b)
}
func (s Service) schedule(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/scheduled-changes"
	for _, rule := range []struct {
		bad     bool
		message string
	}{{b["kind"] == "plan_change" && b["plan_id"] == nil, "escolha o plano"}, {b["kind"] == "due_day" && b["due_day"] == nil, "informe o dia de vencimento"}, {b["penalty"] == "waive" && b["penalty_waive_reason"] == nil, "informe o motivo para dispensar a multa"}} {
		if rule.bad {
			return nil, apierr.New(400, "dados: "+rule.message)
		}
	}
	k, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	if k.Get("status") != "active" {
		return nil, apierr.New(400, "contrato encerrado não aceita mudança agendada")
	}
	c := auth.From(ctx)
	d, err := one(ctx, tx, key, 1, c.TenantID, b["effective_date"])
	if err != nil {
		return nil, err
	}
	if d.Get("future") != true {
		return nil, apierr.New(400, "a data precisa ser futura; para mudar agora use a alteração do contrato")
	}
	if d.Get("near") != true {
		return nil, apierr.New(400, "a data está muito distante (máximo de 2 anos)")
	}
	var plan, due, reason, penalty, waive any
	switch b["kind"] {
	case "plan_change":
		if _, err = currentVersion(ctx, tx, b["plan_id"]); err != nil {
			return nil, err
		}
		plan = b["plan_id"]
	case "due_day":
		due = b["due_day"]
	case "end":
		if err = assertCatalog(ctx, tx, b["end_reason_id"], "end_reason", "motivo de encerramento"); err != nil {
			return nil, err
		}
		reason, penalty, waive = b["end_reason_id"], b["penalty"], b["penalty_waive_reason"]
	}
	exists, err := one(ctx, tx, key, 2, id, b["kind"], b["effective_date"])
	if err != nil {
		return nil, err
	}
	if exists != nil {
		return nil, apierr.New(409, "já existe uma mudança igual agendada para esta data")
	}
	row, err := one(ctx, tx, key, 3, c.TenantID, id, b["kind"], b["effective_date"], plan, due, reason, penalty, waive, b["note"], c.UserID)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "contract.schedule", "contract", id, map[string]any{"change_id": row.Get("id"), "kind": b["kind"], "effective_date": b["effective_date"]})
}
func (s Service) cancelSchedule(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/scheduled-changes/:id", 0, "mudança pendente não encontrada", id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "contract.schedule_cancel", "contract", row.Get("contract_id"), map[string]any{"change_id": id})
}
func (s Service) amendment(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/amendments"
	if _, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id); err != nil {
		return nil, err
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 1, c.TenantID, id, b["kind"], b["title"], b["body"], b["effective_date"], c.UserID)
	if err != nil {
		return nil, err
	}
	if err = history(ctx, tx, key, 2, id, map[string]any{"title": b["title"], "kind": b["kind"]}); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "contract.amendment", "contract", id, map[string]any{"amendment_id": row.Get("id"), "kind": b["kind"]})
}
func (s Service) createAddon(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/addons", 0, auth.From(ctx).TenantID, b["name"], b["price_cents"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "addon.create", "addon", row.Get("id"), b)
}
func (s Service) updateAddon(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "PATCH /api/addons/:id", 0, "produto não encontrado", id, b["price_cents"], b["active"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "addon.update", "addon", id, b)
}
func (s Service) contractAddon(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/contracts/:id/addons"
	k, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id)
	if err != nil {
		return nil, err
	}
	if k.Get("status") != "active" {
		return nil, apierr.New(409, "contrato encerrado não recebe produtos adicionais")
	}
	p, err := one(ctx, tx, key, 1, b["product_id"])
	if err != nil {
		return nil, err
	}
	if p == nil || p.Get("active") != true {
		return nil, apierr.New(400, "produto não encontrado ou inativo")
	}
	price := b["unit_price_cents"]
	if price == nil {
		price = p.Get("price_cents")
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 2, c.TenantID, id, b["product_id"], p.Get("name"), b["quantity"], price, b["from_competence"], c.UserID)
	if err != nil {
		return nil, err
	}
	if err = history(ctx, tx, key, 3, id, map[string]any{"product": p.Get("name"), "quantity": b["quantity"]}); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "contract.addon_add", "contract", id, map[string]any{"addon_id": row.Get("id"), "product": p.Get("name")})
}
