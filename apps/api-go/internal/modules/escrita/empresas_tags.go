package escrita

import (
	"context"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
)

func (s Service) createCompany(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/companies"
	if b["is_default"] == true {
		if err := tx.Exec(ctx, query(key, 0)); err != nil {
			return nil, err
		}
	}
	count, err := one(ctx, tx, key, 1)
	if err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 2, auth.From(ctx).TenantID, b["name"], b["document"], b["is_default"] == true || num(count.Get("n")) == 0)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "company.create", "company", row.Get("id"), map[string]any{"name": row.Get("name")})
}
func (s Service) updateCompany(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/companies/:id"
	current, err := mustRow(ctx, tx, key, 0, "empresa não encontrada", id)
	if err != nil {
		return nil, err
	}
	if b["active"] == false && current.Get("is_default") == true {
		return nil, apierr.New(409, "a empresa padrão não pode ser desativada: escolha outra como padrão antes")
	}
	if b["is_default"] == true {
		if err = tx.Exec(ctx, query(key, 1), id); err != nil {
			return nil, err
		}
	}
	row, err := one(ctx, tx, key, 2, id, b["name"], has(b, "document"), b["document"], b["is_default"], b["active"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "company.update", "company", id, b)
}
func (s Service) contractCompany(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/contracts/:id/company"
	if b["company_id"] != nil {
		row, err := one(ctx, tx, key, 0, b["company_id"])
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apierr.New(400, "empresa não encontrada ou inativa")
		}
	}
	if _, err := mustRow(ctx, tx, key, 1, "contrato não encontrado", id, b["company_id"]); err != nil {
		return nil, err
	}
	return b, record(ctx, tx, "contract.company", "contract", id, b)
}
func (s Service) createTag(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	row, err := one(ctx, tx, "POST /api/tags", 0, auth.From(ctx).TenantID, b["name"])
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "já existe uma etiqueta com este nome")
	}
	return row, record(ctx, tx, "tag.create", "tag", row.Get("id"), map[string]any{"name": b["name"]})
}
func (s Service) deleteTag(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/tags/:id", 0, "etiqueta não encontrada", id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "tag.delete", "tag", id, map[string]any{"name": row.Get("name")})
}
func (s Service) contractTags(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PUT /api/contracts/:id/tags"
	if _, err := mustRow(ctx, tx, key, 0, "contrato não encontrado", id); err != nil {
		return nil, err
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, v := range b["tag_ids"].([]any) {
		tag := v.(string)
		if !seen[tag] {
			tags = append(tags, tag)
			seen[tag] = true
		}
	}
	if len(tags) > 0 {
		n, err := one(ctx, tx, key, 1, tags)
		if err != nil {
			return nil, err
		}
		if num(n.Get("n")) != float64(len(tags)) {
			return nil, apierr.New(400, "alguma etiqueta não existe")
		}
	}
	if err := tx.Exec(ctx, query(key, 2), id); err != nil {
		return nil, err
	}
	for _, tag := range tags {
		if err := tx.Exec(ctx, query(key, 3), auth.From(ctx).TenantID, id, tag); err != nil {
			return nil, err
		}
	}
	if err := record(ctx, tx, "contract.tags", "contract", id, map[string]any{"tag_ids": tags}); err != nil {
		return nil, err
	}
	return rows(ctx, tx, key, 4, id)
}
