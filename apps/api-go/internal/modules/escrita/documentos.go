package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/validate"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (s Service) documentOperations(ops map[string]operation) {
	f, o, str, n, e := validate.F, validate.Object, validate.String, validate.Number, validate.Enum
	uuid := str().UUID()
	ops["POST /api/subscribers/:id/documents"] = operation{s.uploadDocument, obj(o(f("kind", e("identity", "address_proof", "contract", "photo", "other")), f("name", str().Trimmed().Min(1).Max(120)), f("contract_id", uuid.Nullish()), f("content_base64", str().Min(8).Max(7340032))))}
	ops["DELETE /api/documents/:id"] = operation{s.deleteDocument, nil}
	month := str().Pattern(`^\d{4}-(0[1-9]|1[0-2])(-01)?$`, "competência inválida (AAAA-MM)").Then(func(v any) any {
		s := v.(string)
		if len(s) == 7 {
			return s + "-01"
		}
		return s
	}, false)
	ops["DELETE /api/contracts/:id/addons/:addonId"] = operation{s.endAddon, obj(o(f("ended_competence", month.Opt())))}
	ops["POST /api/install-kits"] = operation{s.createKit, obj(o(f("name", str().Trimmed().Min(2).Max(60)), f("items", validate.Array(o(f("item_id", uuid), f("qty", n().Int().Min(1).Max(10000)))).Min(1).Max(30))))}
	ops["POST /api/commission-rules"] = operation{s.commissionRule, obj(o(f("subject", e("work_order", "sale")), f("os_kind", e("install", "repair", "address_change", "removal", "other").Nullish()), f("assignee_cents", n().Int().Min(0).Max(100000000)), f("helper_cents", n().Int().Min(0).Max(100000000).Def(float64(0)))))}
	ops["POST /api/subscribers/:id/anonymize"] = operation{s.anonymize, obj(o(f("reason", str().Trimmed().Min(5, "informe o motivo (pedido do titular, protocolo…)").Max(300)), f("confirm_name", str().Trimmed().Min(1))))}
}
func (s Service) uploadDocument(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/subscribers/:id/documents"
	encoded := b["content_base64"].(string)
	if !regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`).MatchString(encoded) {
		return nil, apierr.New(400, "conteúdo não está em base64")
	}
	encoded = strings.TrimRight(encoded, "=")
	if len(encoded)%4 == 1 {
		encoded = encoded[:len(encoded)-1]
	}
	content, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, apierr.New(400, "conteúdo não está em base64")
	}
	if len(content) == 0 || len(content) > 5*1024*1024 {
		return nil, apierr.New(400, "arquivo vazio ou acima de 5 MB")
	}
	mime := ""
	switch {
	case bytes.HasPrefix(content, []byte("%PDF-")):
		mime = "application/pdf"
	case bytes.HasPrefix(content, []byte{0xff, 0xd8, 0xff}):
		mime = "image/jpeg"
	case bytes.HasPrefix(content, []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}):
		mime = "image/png"
	case len(content) >= 12 && string(content[:4]) == "RIFF" && string(content[8:12]) == "WEBP":
		mime = "image/webp"
	}
	if mime == "" {
		return nil, apierr.New(400, "tipo de arquivo não aceito: envie PDF, JPEG, PNG ou WebP")
	}
	name := regexp.MustCompile(`[\\/\x00-\x1f"<>|:*?]`).ReplaceAllString(b["name"].(string), "_")
	if _, err = mustRow(ctx, tx, key, 0, "assinante não encontrado", id); err != nil {
		return nil, err
	}
	if b["contract_id"] != nil {
		r, err := one(ctx, tx, key, 1, b["contract_id"], id)
		if err != nil {
			return nil, err
		}
		if r == nil {
			return nil, apierr.New(400, "o contrato não pertence a este assinante")
		}
	}
	count, err := one(ctx, tx, key, 2, id)
	if err != nil {
		return nil, err
	}
	if num(count.Get("n")) >= 50 {
		return nil, apierr.New(409, "limite de 50 documentos por assinante atingido")
	}
	sum := sha256.Sum256(content)
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 3, c.TenantID, id, b["contract_id"], b["kind"], name, mime, len(content), hex.EncodeToString(sum[:]), content, c.UserID)
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "document.upload", "document", row.Get("id"), map[string]any{"subscriber_id": id, "kind": b["kind"], "mime": mime, "size_bytes": len(content)})
}
func (s Service) deleteDocument(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	row, err := mustRow(ctx, tx, "DELETE /api/documents/:id", 0, "documento não encontrado", id, auth.From(ctx).UserID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "document.delete", "document", id, map[string]any{"subscriber_id": row.Get("subscriber_id")})
}
func (s Service) endAddon(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "DELETE /api/contracts/:id/addons/:addonId"
	addon := chi.URLParam(httpx.Request(ctx), "addonId")
	row, err := one(ctx, tx, key, 0, addon, id, b["ended_competence"])
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apierr.New(409, "adicional não encontrado, já encerrado ou com término antes do início")
	}
	if err = history(ctx, tx, key, 1, id, map[string]any{"product": row.Get("description")}); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, record(ctx, tx, "contract.addon_end", "contract", id, map[string]any{"addon_id": addon})
}
func (s Service) createKit(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/install-kits"
	items := b["items"].([]any)
	seen := map[string]bool{}
	for _, v := range items {
		it := v.(map[string]any)
		id := it["item_id"].(string)
		if seen[id] {
			return nil, apierr.New(400, "item repetido no kit")
		}
		seen[id] = true
	}
	for _, v := range items {
		it := v.(map[string]any)
		stock, err := one(ctx, tx, key, 0, it["item_id"])
		if err != nil {
			return nil, err
		}
		if stock == nil {
			return nil, apierr.New(400, "item de estoque não encontrado")
		}
		if stock.Get("serialized") == true {
			return nil, apierr.New(400, fmt.Sprintf("“%v” é controlado por número de série e não entra em kit", stock.Get("name")))
		}
		if stock.Get("active") != true {
			return nil, apierr.New(400, fmt.Sprintf("“%v” está inativo", stock.Get("name")))
		}
	}
	c := auth.From(ctx)
	row, err := one(ctx, tx, key, 1, c.TenantID, b["name"])
	if err != nil {
		return nil, err
	}
	for _, v := range items {
		it := v.(map[string]any)
		if err = tx.Exec(ctx, query(key, 2), c.TenantID, row.Get("id"), it["item_id"], it["qty"]); err != nil {
			return nil, err
		}
	}
	return row, record(ctx, tx, "install_kit.create", "install_kit", row.Get("id"), map[string]any{"name": b["name"], "items": len(items)})
}
func (s Service) commissionRule(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/commission-rules"
	if b["subject"] == "sale" && (b["os_kind"] != nil || num(b["helper_cents"]) != 0) {
		return nil, apierr.New(400, "dados: regra de venda não tem natureza de OS nem auxiliar")
	}
	if err := tx.Exec(ctx, query(key, 0), b["subject"], b["os_kind"]); err != nil {
		return nil, err
	}
	row, err := one(ctx, tx, key, 1, auth.From(ctx).TenantID, b["subject"], b["os_kind"], b["assignee_cents"], b["helper_cents"])
	if err != nil {
		return nil, err
	}
	return row, record(ctx, tx, "commission_rule.set", "commission_rule", row.Get("id"), b)
}
func (s Service) anonymize(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/subscribers/:id/anonymize"
	row, err := mustRow(ctx, tx, key, 0, "assinante não encontrado", id)
	if err != nil {
		return nil, err
	}
	if strings.ToLower(validate.Trim(row.Get("name").(string))) != strings.ToLower(b["confirm_name"].(string)) {
		return nil, apierr.New(400, "o nome digitado não confere com o do assinante")
	}
	result, err := one(ctx, tx, key, 1, id, b["reason"], auth.From(ctx).UserID)
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "P0001" {
			return nil, apierr.New(409, pg.Message)
		}
		return nil, err
	}
	return map[string]any{"anonymized": true, "counts": result.Get("r")}, nil
}
