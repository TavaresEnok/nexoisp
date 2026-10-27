package escrita

import (
	"context"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/validate"
)

func registerChargesCallback(api huma.API, registry *endpoint.Registry, s Service) {
	registry.PublicHandle(api, http.MethodPost, "/api/callbacks/efi/charges/{id}", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		if !finance.EFISandboxEnabled() || os.Getenv("NEXO_GO_EFI_CHARGES_CALLBACK_ENABLED") != "1" {
			return endpoint.Result{}, apierr.New(404, "callback desabilitado")
		}
		connection := chi.URLParam(r, "id")
		if validate.UUID(connection) != nil {
			return endpoint.Result{}, apierr.New(400, "conexão inválida")
		}
		content, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || content != "application/x-www-form-urlencoded" {
			return endpoint.Result{}, apierr.New(415, "notificação exige formulário")
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 4097))
		if err != nil || len(raw) > 4096 {
			return endpoint.Result{}, apierr.New(413, "notificação excede o limite")
		}
		form, err := url.ParseQuery(string(raw))
		if err != nil || len(form) != 1 || len(form["notification"]) != 1 {
			return endpoint.Result{}, apierr.New(400, "formulário de notificação inválido")
		}
		if err = finance.AcceptChargesNotice(ctx, s.DB, connection, form.Get("notification")); err != nil {
			return endpoint.Result{}, err
		}
		return endpoint.Result{Value: map[string]bool{"received": true}}, nil
	})
}
