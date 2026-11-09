package escrita

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

// Viabilidade pública: o interessado informa coordenadas e recebe apenas
// "atendemos/não atendemos". Caixas, distâncias e ocupação nunca saem do Go.
const (
	viabilityDefaultRadius = 250
	viabilityMinRadius     = 50
	viabilityMaxRadius     = 2000
	viabilityLeadSource    = "viabilidade"
)

// Limites por endereço de origem, aplicados antes de qualquer validação ou
// resolução do identificador público: o custo é igual para qualquer provedor.
var viabilityLimits = map[string]struct{ limit, window int }{
	"page":     {60, 600},
	"check":    {20, 600},
	"interest": {5, 3600},
}

var viabilitySlug = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)
var viabilityPhoneShape = regexp.MustCompile(`^[0-9+() .-]{8,25}$`)
var viabilityPanelPhone = regexp.MustCompile(`^[0-9+() -]{8,20}$`)

func viabilityUnavailable() error {
	return apierr.New(404, "consulta de viabilidade indisponível")
}
func viabilityBad() error { return apierr.New(400, "dados da consulta inválidos") }

func viabilityIP(r *http.Request) string {
	return httpx.ClientIP(r)
}

func (s Service) viabilityRate(ctx context.Context, r *http.Request, kind string) error {
	l := viabilityLimits[kind]
	var wait int
	err := s.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select public_rate_take($1,$2,$3)`, "viab:"+kind+":ip:"+viabilityIP(r), l.limit, l.window).Scan(&wait)
	})
	if err != nil {
		return err
	}
	if wait > 0 {
		httpx.Header(ctx, "retry-after", fmt.Sprint(wait))
		return &apierr.Error{Status: 429, Message: "muitas consultas deste endereço; aguarde alguns minutos", Code: "rate_limited"}
	}
	return nil
}

type viabilityProvider struct {
	tenant, cell, name, logo string
	radius                   int
	message, phone, whatsapp any
	leadCapture              bool
}

// Inexistente, suspenso, sem FTTH ou desativado: a mesma resposta 404.
func (s Service) viabilityResolve(ctx context.Context, slug string) (viabilityProvider, error) {
	if !viabilitySlug.MatchString(slug) {
		return viabilityProvider{}, viabilityUnavailable()
	}
	rows, cell, err := s.DB.Lookup(ctx, `select * from viability_public_get($1)`, slug)
	if err != nil {
		return viabilityProvider{}, err
	}
	if len(rows) != 1 {
		return viabilityProvider{}, viabilityUnavailable()
	}
	row := rows[0]
	p := viabilityProvider{tenant: jsonx.String(row.Get("tenant_id")), cell: cell, name: jsonx.String(row.Get("name")), radius: int(num(row.Get("radius_m"))), message: row.Get("message"), phone: row.Get("phone"), whatsapp: row.Get("whatsapp"), leadCapture: row.Get("lead_capture") == true}
	if v, ok := row.Get("logo_sha256").(string); ok {
		p.logo = v
	}
	return p, nil
}

func (p viabilityProvider) scope(ctx context.Context) (context.Context, tenancy.Scope) {
	return db.WithCell(ctx, p.cell), tenancy.Scope{TenantID: p.tenant}
}

// Haversine em metros sobre caixas de atendimento (CTO) com coordenadas e ao
// menos uma porta sem drop. Só o booleano sai da consulta.
const viabilityCoverageSQL = `select exists (
  select 1 from ftth_boxes b
  where b.kind = 'cto' and b.latitude is not null and b.longitude is not null
    and b.latitude between $1::float8 - $3::float8 / 111000.0 and $1::float8 + $3::float8 / 111000.0
    and b.ports > (select count(*) from ftth_drops d where d.tenant_id = b.tenant_id and d.box_id = b.id)
    and 2 * 6371008.8 * asin(least(1.0, sqrt(
          power(sin(radians(b.latitude::float8 - $1::float8) / 2), 2)
          + cos(radians($1::float8)) * cos(radians(b.latitude::float8)) * power(sin(radians(b.longitude::float8 - $2::float8) / 2), 2)))) <= $3::float8)`

func viabilityCovered(ctx context.Context, tx *db.Tx, lat, lng float64, radius int) (bool, error) {
	var covered bool
	err := tx.QueryRow(ctx, viabilityCoverageSQL, lat, lng, radius).Scan(&covered)
	return covered, err
}

func viabilityFields(r *http.Request) (map[string]json.RawMessage, error) {
	var b map[string]json.RawMessage
	if err := apierr.DecodeJSON(r, &b); err != nil {
		return nil, err
	}
	if b == nil {
		return nil, viabilityBad()
	}
	return b, nil
}

func viabilityCoordinate(raw json.RawMessage, min, max float64) (float64, bool) {
	var f float64
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < min || f > max {
		return 0, false
	}
	return f, true
}

func viabilityText(raw json.RawMessage, minRunes, maxRunes int) (string, bool) {
	var v string
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil || !utf8.ValidString(v) {
		return "", false
	}
	v = strings.TrimSpace(v)
	for _, c := range v {
		if unicode.IsControl(c) {
			return "", false
		}
	}
	n := utf8.RuneCountInString(v)
	return v, n >= minRunes && n <= maxRunes
}

type viabilityPoint struct {
	lat, lng float64
	address  string
}

func viabilityLocation(b map[string]json.RawMessage, allowed ...string) (viabilityPoint, error) {
	for k := range b {
		if k != "latitude" && k != "longitude" && k != "address" && !slices.Contains(allowed, k) {
			return viabilityPoint{}, viabilityBad()
		}
	}
	var p viabilityPoint
	var ok bool
	if p.lat, ok = viabilityCoordinate(b["latitude"], -90, 90); !ok {
		return p, apierr.New(400, "latitude inválida")
	}
	if p.lng, ok = viabilityCoordinate(b["longitude"], -180, 180); !ok {
		return p, apierr.New(400, "longitude inválida")
	}
	if raw, exists := b["address"]; exists && string(raw) != "null" {
		if p.address, ok = viabilityText(raw, 0, 200); !ok {
			return p, apierr.New(400, "endereço com até 200 caracteres")
		}
	}
	return p, nil
}

func viabilityPublic(p viabilityProvider) map[string]any {
	var logo any
	if p.logo != "" {
		logo = map[string]any{"sha256": p.logo}
	}
	return map[string]any{"name": p.name, "logo": logo, "message": p.message, "phone": p.phone, "whatsapp": p.whatsapp, "lead_capture": p.leadCapture}
}

func (s Service) viabilityPage(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	if err := s.viabilityRate(ctx, r, "page"); err != nil {
		return endpoint.Result{}, err
	}
	p, err := s.viabilityResolve(ctx, chi.URLParam(r, "slug"))
	if err != nil {
		return endpoint.Result{}, err
	}
	return endpoint.Result{Value: viabilityPublic(p), CacheControl: "no-store"}, nil
}

func (s Service) viabilityLogo(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	if err := s.viabilityRate(ctx, r, "page"); err != nil {
		return endpoint.Result{}, err
	}
	p, err := s.viabilityResolve(ctx, chi.URLParam(r, "slug"))
	if err != nil {
		return endpoint.Result{}, err
	}
	if p.logo == "" {
		return endpoint.Result{}, viabilityUnavailable()
	}
	var data []byte
	scoped, scope := p.scope(ctx)
	err = s.DB.WithScope(scoped, scope, func(tx *db.Tx) error {
		return tx.QueryRow(scoped, `select logo_png from tenant_branding where tenant_id=$1 and logo_png is not null`, p.tenant).Scan(&data)
	})
	if err != nil || len(data) == 0 {
		return endpoint.Result{}, viabilityUnavailable()
	}
	return endpoint.Result{Raw: data, ContentType: "image/png", CacheControl: "public, max-age=300", CSP: "default-src 'none'; sandbox"}, nil
}

func (s Service) viabilityCheck(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	if err := s.viabilityRate(ctx, r, "check"); err != nil {
		return endpoint.Result{}, err
	}
	b, err := viabilityFields(r)
	if err != nil {
		return endpoint.Result{}, err
	}
	point, err := viabilityLocation(b)
	if err != nil {
		return endpoint.Result{}, err
	}
	p, err := s.viabilityResolve(ctx, chi.URLParam(r, "slug"))
	if err != nil {
		return endpoint.Result{}, err
	}
	var covered bool
	scoped, scope := p.scope(ctx)
	err = s.DB.WithScope(scoped, scope, func(tx *db.Tx) error {
		var e error
		covered, e = viabilityCovered(scoped, tx, point.lat, point.lng, p.radius)
		return e
	})
	if err != nil {
		return endpoint.Result{}, err
	}
	return endpoint.Result{Value: map[string]any{"covered": covered, "lead_capture": covered && p.leadCapture, "phone": p.phone, "whatsapp": p.whatsapp}, CacheControl: "no-store"}, nil
}

func viabilityLeadPhone(raw json.RawMessage) (string, bool) {
	var v string
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return "", false
	}
	v = strings.TrimSpace(v)
	if !viabilityPhoneShape.MatchString(v) {
		return "", false
	}
	digits := strings.Map(func(c rune) rune {
		if c >= '0' && c <= '9' {
			return c
		}
		return -1
	}, v)
	return digits, len(digits) >= 10 && len(digits) <= 13
}

func (s Service) viabilityInterest(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	if err := s.viabilityRate(ctx, r, "interest"); err != nil {
		return endpoint.Result{}, err
	}
	b, err := viabilityFields(r)
	if err != nil {
		return endpoint.Result{}, err
	}
	point, err := viabilityLocation(b, "name", "phone", "consent")
	if err != nil {
		return endpoint.Result{}, err
	}
	name, ok := viabilityText(b["name"], 2, 120)
	if !ok {
		return endpoint.Result{}, apierr.New(400, "informe o nome com 2 a 120 caracteres")
	}
	phone, ok := viabilityLeadPhone(b["phone"])
	if !ok {
		return endpoint.Result{}, apierr.New(400, "informe um telefone com DDD")
	}
	if string(b["consent"]) != "true" {
		return endpoint.Result{}, apierr.New(400, "é preciso autorizar o contato do provedor")
	}
	p, err := s.viabilityResolve(ctx, chi.URLParam(r, "slug"))
	if err != nil {
		return endpoint.Result{}, err
	}
	if !p.leadCapture {
		return endpoint.Result{}, apierr.New(409, "o provedor não recebe contatos por esta página")
	}
	scoped, scope := p.scope(ctx)
	err = s.DB.WithScope(scoped, scope, func(tx *db.Tx) error {
		covered, e := viabilityCovered(scoped, tx, point.lat, point.lng, p.radius)
		if e != nil {
			return e
		}
		if !covered {
			return apierr.New(409, "o local informado não está na área atendida")
		}
		// Reenvio do mesmo telefone no mesmo dia não duplica o prospecto nem revela que ele existe.
		var duplicate bool
		if e = tx.QueryRow(scoped, `select exists(select 1 from leads where source=$1 and phone=$2 and created_at > now() - interval '1 day')`, viabilityLeadSource, phone).Scan(&duplicate); e != nil || duplicate {
			return e
		}
		notes := fmt.Sprintf("Consulta pública de viabilidade com resultado positivo. Coordenadas informadas: %.6f, %.6f. O interessado autorizou o contato.", point.lat, point.lng)
		var id string
		if e = tx.QueryRow(scoped, `insert into leads (tenant_id, name, phone, address_street, source, notes) values ($1,$2,$3,$4,$5,$6) returning id`, p.tenant, name, phone, textNil(point.address), viabilityLeadSource, notes).Scan(&id); e != nil {
			return e
		}
		detail, e := json.Marshal(map[string]any{"source": viabilityLeadSource})
		if e != nil {
			return e
		}
		if e = tx.Exec(scoped, `insert into lead_events (tenant_id, lead_id, actor_id, event, detail) values ($1,$2,null,'created',$3)`, p.tenant, id, detail); e != nil {
			return e
		}
		return tx.Exec(scoped, `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail) values ($1,'system','viabilidade-publica','lead.create','lead',$2,'ok',$3)`, p.tenant, id, detail)
	})
	if err != nil {
		return endpoint.Result{}, err
	}
	return endpoint.Result{Value: map[string]any{"ok": true}, CacheControl: "no-store"}, nil
}

// ---- configuração no painel ----

func viabilityActor(ctx context.Context) (*auth.Ctx, error) {
	c := auth.From(ctx)
	if c == nil || c.TenantID == "" || c.Scope.TenantID != c.TenantID || c.Scope.IsOperator() || c.Role == "subscriber" || c.SubscriberID != "" || c.Scope.SubscriberID != "" || len(c.PopIDs) != 0 || len(c.Scope.PopIDs) != 0 {
		return nil, apierr.New(403, "escopo de provedor completo necessário")
	}
	return c, nil
}

type viabilitySettingsBody struct {
	enabled, createLead      bool
	radius                   int
	message, phone, whatsapp any
}

func viabilitySettingsParse(r *http.Request) (viabilitySettingsBody, error) {
	bad := func(msg string) (viabilitySettingsBody, error) { return viabilitySettingsBody{}, apierr.New(400, msg) }
	var b map[string]json.RawMessage
	if err := apierr.DecodeJSON(r, &b); err != nil {
		return viabilitySettingsBody{}, err
	}
	keys := []string{"enabled", "radius_m", "message", "phone", "whatsapp", "create_lead"}
	if len(b) != len(keys) {
		return bad("configuração de viabilidade incompleta")
	}
	for k := range b {
		if !slices.Contains(keys, k) {
			return bad("configuração de viabilidade inválida")
		}
	}
	var out viabilitySettingsBody
	if json.Unmarshal(b["enabled"], &out.enabled) != nil || string(b["enabled"]) == "null" || json.Unmarshal(b["create_lead"], &out.createLead) != nil || string(b["create_lead"]) == "null" {
		return bad("informe sim ou não para ativação e prospecto")
	}
	var radius float64
	if string(b["radius_m"]) == "null" || json.Unmarshal(b["radius_m"], &radius) != nil || radius != math.Trunc(radius) || radius < viabilityMinRadius || radius > viabilityMaxRadius {
		return bad(fmt.Sprintf("raio de %d a %d metros", viabilityMinRadius, viabilityMaxRadius))
	}
	out.radius = int(radius)
	optional := func(key string, min, max int) (string, bool, error) {
		raw := b[key]
		if string(raw) == "null" {
			return "", false, nil
		}
		v, ok := viabilityText(raw, 0, max)
		if !ok {
			return "", false, apierr.New(400, "texto inválido em "+key)
		}
		if v == "" {
			return "", false, nil
		}
		if utf8.RuneCountInString(v) < min {
			return "", false, apierr.New(400, "texto curto demais em "+key)
		}
		return v, true, nil
	}
	if v, ok, err := optional("message", 2, 500); err != nil {
		return bad("mensagem de 2 a 500 caracteres")
	} else if ok {
		out.message = v
	}
	if v, ok, err := optional("phone", 8, 20); err != nil || (ok && !viabilityPanelPhone.MatchString(v)) {
		return bad("telefone de contato inválido")
	} else if ok {
		out.phone = v
	}
	if v, ok, err := optional("whatsapp", 10, 25); err != nil {
		return bad("WhatsApp inválido: informe DDI, DDD e número")
	} else if ok {
		digits := strings.Map(func(c rune) rune {
			if c >= '0' && c <= '9' {
				return c
			}
			if strings.ContainsRune("+() .-", c) {
				return -1
			}
			return 'x'
		}, v)
		if strings.Contains(digits, "x") || len(digits) < 10 || len(digits) > 15 {
			return bad("WhatsApp inválido: informe DDI, DDD e número")
		}
		out.whatsapp = digits
	}
	return out, nil
}

func viabilitySettingsGet(ctx context.Context, tx *db.Tx) (map[string]any, error) {
	tenant, err := tx.Objects(ctx, `select slug, modules from tenants where id = app_tenant()`)
	if err != nil {
		return nil, err
	}
	if len(tenant) == 0 {
		return nil, apierr.New(404, "provedor não encontrado")
	}
	slug := jsonx.String(tenant[0].Get("slug"))
	modules := publicStrings(tenant[0].Get("modules"))
	out := map[string]any{"enabled": false, "radius_m": viabilityDefaultRadius, "message": nil, "phone": nil, "whatsapp": nil, "create_lead": false, "updated_at": nil, "slug": slug, "public_path": "/viabilidade/" + slug, "modules": map[string]bool{"ftth": slices.Contains(modules, "ftth"), "crm": slices.Contains(modules, "crm")}}
	rows, err := tx.Objects(ctx, `select enabled, radius_m, message, phone, whatsapp, create_lead, updated_at from viability_settings where tenant_id = app_tenant()`)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		for _, k := range []string{"enabled", "radius_m", "message", "phone", "whatsapp", "create_lead", "updated_at"} {
			out[k] = rows[0].Get(k)
		}
	}
	return out, nil
}

func registerViability(api huma.API, registry *endpoint.Registry, s Service) {
	registry.Get(api, "/api/settings/viability", "settings:manage", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := viabilityActor(ctx)
		if err != nil {
			return endpoint.Result{}, err
		}
		var out map[string]any
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			var e error
			out, e = viabilitySettingsGet(ctx, tx)
			return e
		})
		return endpoint.Result{Value: out, CacheControl: "private, no-store"}, err
	})
	registry.Handle(api, http.MethodPut, "/api/settings/viability", "settings:manage", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := viabilityActor(ctx)
		if err != nil {
			return endpoint.Result{}, err
		}
		body, err := viabilitySettingsParse(r)
		if err != nil {
			return endpoint.Result{}, err
		}
		var out map[string]any
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			if e := tx.Exec(ctx, `insert into viability_settings (tenant_id, enabled, radius_m, message, phone, whatsapp, create_lead, updated_by) values (app_tenant(),$1,$2,$3,$4,$5,$6,$7)
  on conflict (tenant_id) do update set enabled=excluded.enabled, radius_m=excluded.radius_m, message=excluded.message, phone=excluded.phone, whatsapp=excluded.whatsapp, create_lead=excluded.create_lead, updated_by=excluded.updated_by, updated_at=now()`, body.enabled, body.radius, body.message, body.phone, body.whatsapp, body.createLead, actor.UserID); e != nil {
				return e
			}
			var e error
			if out, e = viabilitySettingsGet(ctx, tx); e != nil {
				return e
			}
			return record(ctx, tx, "viability.settings", "viability_settings", actor.TenantID, map[string]any{"enabled": body.enabled, "radius_m": body.radius, "create_lead": body.createLead})
		})
		return endpoint.Result{Value: out, CacheControl: "private, no-store"}, err
	})
	registry.PublicGet(api, "/public/viabilidade/{slug}", s.viabilityPage)
	registry.PublicGet(api, "/public/viabilidade/{slug}/logo", s.viabilityLogo)
	registry.PublicHandle(api, http.MethodPost, "/public/viabilidade/{slug}/consulta", s.viabilityCheck)
	registry.PublicHandle(api, http.MethodPost, "/public/viabilidade/{slug}/interesse", s.viabilityInterest)
}
