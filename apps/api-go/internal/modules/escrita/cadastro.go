package escrita

import (
	"context"
	"encoding/json"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
)

var subscriberColumns = []string{"name", "document", "email", "phone", "address_street", "address_number", "address_district", "address_city", "address_state", "address_zip", "notes", "status", "birth_date", "rg", "rg_issuer", "mother_name", "trade_name"}

func subscriberArgs(first any, b map[string]any) []any {
	args := []any{first}
	for _, key := range subscriberColumns {
		args = append(args, b[key])
	}
	return args
}
func (s Service) createSubscriber(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/subscribers", 0, subscriberArgs(auth.From(ctx).TenantID, b)...)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "subscriber.create", "subscriber", row.Get("id"), nil)
}
func (s Service) updateSubscriber(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/subscribers/:id"
	current, err := mustRow(ctx, tx, key, 1, "assinante não encontrado", id)
	if err != nil {
		return nil, err
	}
	if current.Get("anonymized_at") != nil {
		return nil, apierr.New(409, "titular anonimizado: o cadastro não pode mais ser alterado")
	}
	merged := make(map[string]any, len(subscriberColumns))
	for _, col := range subscriberColumns {
		merged[col] = current.Get(col)
	}
	for col, value := range b {
		merged[col] = value
	}
	row, err := one(ctx, tx, key, 0, subscriberArgs(id, merged)...)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(404, "assinante não encontrado")
	}
	return row, record(ctx, tx, "subscriber.update", "subscriber", id, nil)
}
func versionArgs(first, second any, b map[string]any) []any {
	return []any{first, second, b["price_cents"], b["down_kbps"], b["up_kbps"], b["profile_name"]}
}
func (s Service) createPlan(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/plans"
	row, err := one(ctx, tx, key, 0, auth.From(ctx).TenantID, b["name"])
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 1), versionArgs(auth.From(ctx).TenantID, row.Get("id"), b)...); err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "plan.create", "plan", row.Get("id"), b)
}
func (s Service) createVersion(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/plans/:id/versions"
	if _, err := mustRow(ctx, tx, key, 0, "plano não encontrado", id); err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 1, versionArgs(auth.From(ctx).TenantID, id, b)...)
	if err != nil {
		return nil, err
	}
	detail := map[string]any{"version": row.Get("version")}
	for k, v := range b {
		detail[k] = v
	}
	return row, record(ctx, tx, "plan.new_version", "plan", id, detail)
}
func (s Service) updatePlan(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "PATCH /api/plans/:id", 0, "plano não encontrado", id, b["name"], b["active"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "plan.update", "plan", id, b)
}
func (s Service) planDunning(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	w, r, block := b["warn_after_days"], b["reduce_after_days"], b["block_after_days"]
	if w != nil && r != nil && num(w) > num(r) || r != nil && block != nil && num(r) > num(block) || w != nil && block != nil && num(w) > num(block) {
		return nil, apierr.New(400, "os dias devem crescer: aviso ≤ redução ≤ bloqueio")
	}
	if r != nil && (b["reduced_profile"] == nil || b["reduced_profile"] == "") {
		return nil, apierr.New(400, "informe o perfil de velocidade reduzida que existe no concentrador")
	}
	row, err := mustRow(ctx, tx, "PUT /api/plans/:id/dunning", 0, "plano não encontrado", id, w, r, block, nilEmpty(b["reduced_profile"]))
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "plan.dunning", "plan", id, b)
}
func currentVersion(ctx context.Context, tx *db.Tx, id any) (jsonx.Object, error) {
	v, err := one(ctx, tx, "helper:currentVersion", 0, id)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, apierr.New(400, "plano não encontrado")
	}
	if v.Get("active") != true {
		return nil, apierr.New(400, "plano inativo não aceita novos contratos")
	}
	return v, nil
}
func (s Service) createContract(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/contracts"
	c := auth.From(ctx)
	sub, err := one(ctx, tx, key, 0, b["subscriber_id"])
	if err != nil {
		return nil, err
	}
	if sub == nil {
		return nil, apierr.New(400, "assinante não encontrado")
	}
	if sub.Get("status") != "active" {
		return nil, apierr.New(400, "assinante inativo")
	}
	version, err := currentVersion(ctx, tx, b["plan_id"])
	if err != nil {
		return nil, err
	}
	loyalty, err := one(ctx, tx, key, 1, b["plan_id"])
	if err != nil {
		return nil, err
	}
	contract, err := one(ctx, tx, key, 2, c.TenantID, b["subscriber_id"], version.Get("id"), b["due_day"], b["start_date"], nilEmpty(b["notes"]), loyalty.Get("loyalty_months"), loyalty.Get("penalty_model"), loyalty.Get("penalty_cents"))
	if err != nil {
		return nil, err
	}
	detail, err := json.Marshal(map[string]any{"plan": version.Get("name"), "plan_version": version.Get("version"), "due_day": b["due_day"]})
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 3), c.TenantID, contract.Get("id"), c.UserID, detail); err != nil {
		return nil, err
	}
	return contract, record(ctx, tx, "contract.create", "contract", contract.Get("id"), nil)
}
