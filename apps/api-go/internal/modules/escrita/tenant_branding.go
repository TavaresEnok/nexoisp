package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

const brandingLimit = 400 * 1024

type brandingLogo struct {
	MIME   string `json:"mime"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size_bytes"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}
type brandingResponse struct {
	DisplayName *string       `json:"display_name"`
	Logo        *brandingLogo `json:"logo"`
	UpdatedAt   any           `json:"updated_at"`
}

func brandingActor(ctx context.Context, write bool) (*auth.Ctx, error) {
	c := auth.From(ctx)
	if c == nil || c.TenantID == "" || c.Scope.TenantID != c.TenantID || c.Scope.IsOperator() || c.Scope.SubscriberID != c.SubscriberID || !slices.Equal(c.Scope.PopIDs, c.PopIDs) || (c.Role == "subscriber" && c.SubscriberID == "") || (c.Role != "subscriber" && c.SubscriberID != "") {
		return nil, apierr.New(403, "escopo de provedor inválido")
	}
	if write && (c.SubscriberID != "" || len(c.PopIDs) != 0 || len(c.Scope.PopIDs) != 0) {
		return nil, apierr.New(403, "escopo de provedor completo necessário")
	}
	return c, nil
}

func brandingImage(encoded string) ([]byte, string, int, int, error) {
	invalid := func() ([]byte, string, int, int, error) {
		return nil, "", 0, 0, apierr.New(400, "imagem inválida ou fora dos limites")
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(256*1024) {
		return invalid()
	}
	b, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(b) == 0 || len(b) > 256*1024 || base64.StdEncoding.EncodeToString(b) != encoded {
		return invalid()
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || (format != "png" && format != "jpeg") || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 512 || cfg.Height > 512 || cfg.Width*cfg.Height > 262144 {
		return invalid()
	}
	img, actual, err := image.Decode(bytes.NewReader(b))
	if err != nil || actual != format || img.Bounds().Dx() != cfg.Width || img.Bounds().Dy() != cfg.Height {
		return invalid()
	}
	var out bytes.Buffer
	if err = png.Encode(&out, img); err != nil || out.Len() > 2*1024*1024 {
		return invalid()
	}
	sum := sha256.Sum256(out.Bytes())
	return out.Bytes(), hex.EncodeToString(sum[:]), cfg.Width, cfg.Height, nil
}

func brandingBody(r *http.Request) (*string, string, []byte, string, int, int, error) {
	bad := func() (*string, string, []byte, string, int, int, error) {
		return nil, "", nil, "", 0, 0, apierr.New(400, "corpo de marca inválido")
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, "", nil, "", 0, 0, apierr.New(415, "Unsupported Media Type")
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, brandingLimit+1))
	if err != nil {
		return nil, "", nil, "", 0, 0, err
	}
	if len(b) > brandingLimit {
		return nil, "", nil, "", 0, 0, apierr.New(413, "Request body is too large")
	}
	var fields map[string]json.RawMessage
	if !utf8.Valid(b) || json.Unmarshal(b, &fields) != nil || fields == nil {
		return bad()
	}
	for k := range fields {
		if k != "display_name" && k != "logo_action" && k != "logo_content_base64" {
			return bad()
		}
	}
	raw, ok := fields["display_name"]
	if !ok {
		return bad()
	}
	var name *string
	if string(raw) != "null" {
		var n string
		if json.Unmarshal(raw, &n) != nil {
			return bad()
		}
		n = strings.TrimSpace(n)
		if !utf8.ValidString(n) || strings.ContainsRune(n, 0) || utf8.RuneCountInString(n) < 2 || utf8.RuneCountInString(n) > 80 {
			return bad()
		}
		name = &n
	}
	var action string
	if json.Unmarshal(fields["logo_action"], &action) != nil || (action != "keep" && action != "remove" && action != "replace") {
		return bad()
	}
	content, exists := fields["logo_content_base64"]
	if action != "replace" {
		if exists {
			return bad()
		}
		return name, action, nil, "", 0, 0, nil
	}
	var encoded string
	if !exists || json.Unmarshal(content, &encoded) != nil {
		return bad()
	}
	pngBytes, hash, w, h, err := brandingImage(encoded)
	return name, action, pngBytes, hash, w, h, err
}

func registerTenantBranding(api huma.API, registry *endpoint.Registry, s Service) {
	read := func(raw bool) endpoint.Handler {
		return func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			actor, err := brandingActor(ctx, false)
			if err != nil {
				return endpoint.Result{}, err
			}
			result := endpoint.Result{CacheControl: "private, no-store"}
			err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
				rows, e := tx.Objects(ctx, `select display_name,logo_png,logo_sha256,logo_width,logo_height,updated_at from tenant_branding where tenant_id=$1`, actor.TenantID)
				if e != nil {
					return e
				}
				response := brandingResponse{}
				if len(rows) > 0 {
					row := rows[0]
					if v := row.Get("display_name"); v != nil {
						n := v.(string)
						response.DisplayName = &n
					}
					response.UpdatedAt = row.Get("updated_at")
					if v := row.Get("logo_png"); v != nil {
						data := v.([]byte)
						response.Logo = &brandingLogo{"image/png", row.Get("logo_sha256").(string), len(data), int(num(row.Get("logo_width"))), int(num(row.Get("logo_height")))}
						if raw {
							result.Raw = data
							result.ContentType = "image/png"
						}
					}
				}
				if raw && result.Raw == nil {
					return apierr.New(404, "logotipo não encontrado")
				}
				if !raw {
					result.Value = response
				}
				return nil
			})
			return result, err
		}
	}
	registry.Get(api, "/api/tenant-branding", "", false, read(false))
	registry.Get(api, "/api/tenant-branding/logo", "", false, read(true))
	registry.Handle(api, "PUT", "/api/settings/portal-branding", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := brandingActor(ctx, true)
		if err != nil {
			return endpoint.Result{}, err
		}
		name, action, data, hash, w, h, err := brandingBody(r)
		if err != nil {
			return endpoint.Result{}, err
		}
		var result brandingResponse
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			if e := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1, 4182))`, actor.TenantID); e != nil {
				return e
			}
			// A no-op replay keeps its revision while preserving a single row.
			rows, e := tx.Objects(ctx, `insert into tenant_branding (tenant_id,display_name,logo_png,logo_sha256,logo_width,logo_height) values ($1,$2,$3,$4,$5,$6)
    on conflict (tenant_id) do update set display_name=excluded.display_name,
    logo_png=case when $7='keep' then tenant_branding.logo_png else excluded.logo_png end,
    logo_sha256=case when $7='keep' then tenant_branding.logo_sha256 else excluded.logo_sha256 end,
    logo_width=case when $7='keep' then tenant_branding.logo_width else excluded.logo_width end,
    logo_height=case when $7='keep' then tenant_branding.logo_height else excluded.logo_height end,
    updated_at=case when tenant_branding.display_name is not distinct from excluded.display_name and ($7='keep' or tenant_branding.logo_png is not distinct from excluded.logo_png) then tenant_branding.updated_at else now() end
    returning display_name,logo_sha256,octet_length(logo_png) as size_bytes,logo_width,logo_height,updated_at`, actor.TenantID, name, data, nullableBrandHash(hash), nullableBrandInt(w), nullableBrandInt(h), action)
			if e != nil {
				return e
			}
			row := rows[0]
			if v := row.Get("display_name"); v != nil {
				n := v.(string)
				result.DisplayName = &n
			}
			result.UpdatedAt = row.Get("updated_at")
			if v := row.Get("logo_sha256"); v != nil {
				result.Logo = &brandingLogo{"image/png", v.(string), int(num(row.Get("size_bytes"))), int(num(row.Get("logo_width"))), int(num(row.Get("logo_height")))}
			}
			return record(ctx, tx, "tenant_branding.update", "tenant_branding", actor.TenantID, map[string]any{"logo_action": action})
		})
		return endpoint.Result{Value: result, CacheControl: "private, no-store"}, err
	})
}
func nullableBrandHash(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func nullableBrandInt(n int) any {
	if n == 0 {
		return nil
	}
	return n
}
