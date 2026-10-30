package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"regexp"
	"slices"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

const attachmentColumns = `id, name, kind, mime, size_bytes, sha256, created_at`

func attachmentContent(encoded string) ([]byte, string, error) {
	if len(encoded) > 6990508 {
		return nil, "", apierr.New(400, "arquivo acima de 5 MB")
	}
	content, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(content) != encoded || len(content) == 0 || len(content) > 5*1024*1024 {
		return nil, "", apierr.New(400, "conteúdo base64 inválido ou arquivo vazio ou acima de 5 MB")
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
		return nil, "", apierr.New(400, "tipo de arquivo não aceito")
	}
	return content, mime, nil
}

func registerWorkOrderAttachments(api huma.API, registry *endpoint.Registry, s Service) {
	path := "/api/work-orders/{id}/attachments"
	for _, route := range []struct{ method, path, perm string }{{"GET", path, "os:read"}, {"POST", path, "os:write"}, {"GET", path + "/{attachmentId}/download", "os:read"}, {"DELETE", path + "/{attachmentId}", "os:write"}} {
		route := route
		registry.Handle(api, route.method, route.path, route.perm, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id, aid := chi.URLParam(r, "id"), chi.URLParam(r, "attachmentId")
			if err := validate.UUID(id); err != nil {
				return endpoint.Result{}, err
			}
			if aid != "" {
				if err := validate.UUID(aid); err != nil {
					return endpoint.Result{}, err
				}
			}
			var content []byte
			var mime, name string
			if route.method == "POST" {
				var raw any
				if err := apierr.DecodeJSON(r, &raw); err != nil {
					return endpoint.Result{}, err
				}
				b, err := validate.Object(validate.F("name", validate.String().Trimmed().Min(1).Max(120)), validate.F("content_base64", validate.String().Min(1).Max(6990508))).Parse(raw, true)
				if err != nil {
					return endpoint.Result{}, err
				}
				content, mime, err = attachmentContent(b["content_base64"].(string))
				if err != nil {
					return endpoint.Result{}, err
				}
				name = regexp.MustCompile(`[\\/\x00-\x1f"<>|:*?]`).ReplaceAllString(b["name"].(string), "_")
			}
			var result endpoint.Result
			err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
				// Lock subscriber first to serialize quota and anonymization. NO KEY UPDATE
				// remains compatible with the subscriber FK check during OS completion.
				parents, err := tx.Objects(ctx, `select s.id, s.anonymized_at from subscribers s join work_orders w on w.subscriber_id=s.id and w.tenant_id=s.tenant_id where w.id=$1 for no key update of s`, id)
				if err != nil {
					return err
				}
				if len(parents) == 0 {
					return apierr.New(404, "ordem de serviço não encontrada")
				}
				orders, err := tx.Objects(ctx, `select subscriber_id, contract_id, status from work_orders where id=$1 for update`, id)
				if err != nil {
					return err
				}
				if len(orders) == 0 {
					return apierr.New(404, "ordem de serviço não encontrada")
				}
				parent := orders[0]
				open := parent.Get("status") != "done" && parent.Get("status") != "canceled" && parents[0].Get("anonymized_at") == nil
				if route.method == "POST" || route.method == "DELETE" {
					if !open {
						return apierr.New(409, "ordem encerrada ou assinante anonimizado")
					}
				}
				if route.method == "POST" {
					counts, err := tx.Objects(ctx, `select count(*)::int as total, count(*) filter (where work_order_id=$2)::int as os_total from documents where subscriber_id=$1 and deleted_at is null`, parent.Get("subscriber_id"), id)
					if err != nil {
						return err
					}
					if num(counts[0].Get("total")) >= 50 || num(counts[0].Get("os_total")) >= 20 {
						return apierr.New(409, "limite de documentos atingido")
					}
					sum := sha256.Sum256(content)
					kind := "photo"
					if mime == "application/pdf" {
						kind = "other"
					}
					rows, err := tx.Objects(ctx, `insert into documents (tenant_id, subscriber_id, contract_id, work_order_id, kind, name, mime, size_bytes, sha256, content, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning `+attachmentColumns, auth.From(ctx).TenantID, parent.Get("subscriber_id"), parent.Get("contract_id"), id, kind, name, mime, len(content), hex.EncodeToString(sum[:]), content, auth.From(ctx).UserID)
					if err != nil {
						return err
					}
					result.Value = rows[0]
					return record(ctx, tx, "document.upload", "document", rows[0].Get("id"), map[string]any{"subscriber_id": parent.Get("subscriber_id"), "work_order_id": id, "kind": kind, "mime": mime, "size_bytes": len(content)})
				}
				if aid == "" {
					rows, err := tx.Objects(ctx, `select `+attachmentColumns+` from documents where work_order_id=$1 and deleted_at is null order by created_at desc,id desc`, id)
					if err != nil {
						return err
					}
					can := open && slices.Contains(auth.From(ctx).Permissions, "os:write")
					result.Value = map[string]any{"items": rows, "can_upload": can, "can_delete": can}
					return nil
				}
				rows, err := tx.Objects(ctx, `select `+attachmentColumns+`, content from documents where id=$1 and work_order_id=$2 and deleted_at is null`, aid, id)
				if err != nil {
					return err
				}
				if len(rows) == 0 {
					return apierr.New(404, "anexo não encontrado")
				}
				row := rows[0]
				if route.method == "DELETE" {
					if err = tx.Exec(ctx, `update documents set content=null,deleted_at=now(),deleted_by=$2 where id=$1 and work_order_id=$3 and deleted_at is null`, aid, auth.From(ctx).UserID, id); err != nil {
						return err
					}
					result.Value = map[string]any{"ok": true}
					return record(ctx, tx, "document.delete", "document", aid, map[string]any{"subscriber_id": parent.Get("subscriber_id"), "work_order_id": id})
				}
				result = endpoint.Result{Raw: row.Get("content").([]byte), ContentType: jsonx.String(row.Get("mime")), CacheControl: "private, no-store", CSP: "default-src 'none'; sandbox", Disposition: "attachment; filename*=UTF-8''" + uriComponent(jsonx.String(row.Get("name")))}
				return record(ctx, tx, "document.download", "document", aid, map[string]any{"subscriber_id": parent.Get("subscriber_id"), "work_order_id": id})
			})
			return result, err
		})
	}
}
