package leitura

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"text/template"

	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"

	"github.com/go-chi/chi/v5"
)

//go:embed notice.html.tmpl
var noticeHTML string
var noticeTemplate = template.Must(template.New("notice").Parse(noticeHTML))
var noticeSlug = regexp.MustCompile(`^[a-z0-9-]{2,40}$`)

func esc(value any) string {
	if value == nil {
		return ""
	}
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#39;").Replace(fmt.Sprint(value))
}
func (s Service) notice(ctx context.Context, r *http.Request) (endpoint.Result, error) {
	result := endpoint.Result{ContentType: "text/html; charset=utf-8", CacheControl: "no-store", CSP: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'", Referrer: "same-origin"}
	slug := chi.URLParam(r, "slug")
	var tenant jsonx.Object
	if noticeSlug.MatchString(slug) {
		rows, _, err := s.DB.Lookup(ctx, "select * from notice_page_get($1)", slug)
		tenant = object(rows)
		if err != nil {
			return result, err
		}
	}
	if len(tenant) == 0 {
		result.Status = 404
		result.Raw = []byte("<!doctype html><meta charset=\"utf-8\"><title>Aviso</title><p>Página não encontrada.</p>")
		return result, nil
	}
	page := tenant.Get("page").(jsonx.Object)
	text := page.Get("blocked_text")
	mode := r.URL.Query()["m"]
	if len(mode) == 1 && mode[0] == "reduzida" && page.Get("reduced_text") != nil && page.Get("reduced_text") != "" {
		text = page.Get("reduced_text")
	}
	values := map[string]string{"Title": esc(page.Get("title")), "Tenant": esc(tenant.Get("name")), "Text": esc(text)}
	if page.Get("show_portal_link") == true {
		values["Portal"] = `<a class="b" href="/login">Entrar no portal do assinante</a>`
	}
	if v := page.Get("whatsapp"); v != nil && v != "" {
		values["WhatsApp"] = `<a class="b s" href="https://wa.me/` + esc(v) + `" rel="noopener noreferrer">Falar no WhatsApp</a>`
	}
	if v := page.Get("phone"); v != nil && v != "" {
		values["Phone"] = `<p><small>Atendimento: ` + esc(v) + `</small></p>`
	}
	var body bytes.Buffer
	err := noticeTemplate.Execute(&body, values)
	result.Raw = body.Bytes()
	return result, err
}
