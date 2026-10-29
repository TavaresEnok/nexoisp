package escrita

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/outbound/cloudjournal"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
)

const (
	cloudStatusPath    = "/api/webhooks/cloud-api/{account}"
	cloudStatusPrefix  = "/api/webhooks/cloud-api/"
	cloudStatusBodyMax = 4096
)

var errCloudStatusEffect = errors.New("cloud status: efeito fora do contrato")

// CloudStatusResolver devolve o tenant de uma fonte já confiável da instância.
// A implementação de produção não existe enquanto o protocolo não está provado.
type CloudStatusResolver interface {
	Proven() bool
	ResolveAccount(ctx context.Context, accountID string) (tenantID string, err error)
}

// cloudStatusHandlerConfig é a dependência de uma instância. Produção deixa
// decoder e resolver vazios e fixa UnprovedAuthenticator.
type cloudStatusHandlerConfig struct {
	DB       *db.DB
	Auth     cloudjournal.Authenticator
	Decoder  cloudjournal.StatusDecoder
	Resolver CloudStatusResolver
}

type cloudStatusAuth struct {
	auth cloudjournal.Authenticator
	dec  cloudjournal.StatusDecoder
}

func (a cloudStatusAuth) Proven() bool {
	return a.auth != nil && a.auth.Proven()
}

func (a cloudStatusAuth) Verify(headers map[string]string, body []byte) error {
	if a.auth == nil {
		return errCloudStatusEffect
	}
	return a.auth.Verify(headers, body)
}

func (a cloudStatusAuth) DecoderProven() bool {
	return a.dec != nil && a.dec.DecoderProven()
}

func (a cloudStatusAuth) DecodeStatus(body []byte) (string, string, error) {
	if a.dec == nil {
		return "", "", errCloudStatusEffect
	}
	return a.dec.DecodeStatus(body)
}

func registerCloudStatusCallback(api huma.API, registry *endpoint.Registry, s Service) {
	registry.PublicHandle(api, http.MethodPost, cloudStatusPath, newCloudStatusHandler(cloudStatusHandlerConfig{
		DB:   s.DB,
		Auth: cloudjournal.UnprovedAuthenticator{},
	}))
}

func newCloudStatusHandler(cfg cloudStatusHandlerConfig) endpoint.Handler {
	return func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		return cloudStatusServe(ctx, r, cfg)
	}
}

func cloudStatusServe(ctx context.Context, r *http.Request, cfg cloudStatusHandlerConfig) (endpoint.Result, error) {
	if r == nil || r.Body == nil {
		return endpoint.Result{}, cloudStatusClosed()
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, cloudStatusBodyMax+1))
	if err != nil {
		return endpoint.Result{}, cloudStatusClosed()
	}
	if len(raw) > cloudStatusBodyMax {
		return endpoint.Result{}, apierr.New(http.StatusRequestEntityTooLarge, "corpo acima de 4096 bytes")
	}
	accountID := cloudStatusAccount(r)
	if validate.UUID(accountID) != nil {
		return endpoint.Result{}, cloudStatusClosed()
	}
	gate := cloudStatusAuth{auth: cfg.Auth, dec: cfg.Decoder}
	if !gate.Proven() {
		_, _ = cloudjournal.AcceptStatus(ctx, nil, "", accountID, nil, raw, gate)
		return endpoint.Result{}, cloudStatusClosed()
	}
	headers := cloudStatusHeaders(r)
	if err = gate.Verify(headers, raw); err != nil {
		_, _ = cloudjournal.AcceptStatus(ctx, nil, "", accountID, headers, raw, gate)
		return endpoint.Result{}, cloudStatusClosed()
	}
	if !gate.DecoderProven() {
		_, _ = cloudjournal.AcceptStatus(ctx, nil, "", accountID, headers, raw, gate)
		return endpoint.Result{}, cloudStatusClosed()
	}
	if cfg.Resolver == nil || !cfg.Resolver.Proven() {
		return endpoint.Result{}, cloudStatusClosed()
	}
	tenantID, err := cfg.Resolver.ResolveAccount(ctx, accountID)
	if err != nil || validate.UUID(tenantID) != nil || tenantID == accountID {
		return endpoint.Result{}, cloudStatusClosed()
	}
	if cfg.DB == nil {
		_, _ = cloudjournal.AcceptStatus(ctx, nil, tenantID, accountID, headers, raw, gate)
		return endpoint.Result{}, cloudStatusClosed()
	}
	var effect cloudjournal.StatusEffect
	err = cfg.DB.WithScope(ctx, tenancy.Scope{TenantID: tenantID}, func(tx *db.Tx) error {
		var callErr error
		effect, callErr = cloudjournal.AcceptStatus(ctx, tx, tenantID, accountID, headers, raw, gate)
		if callErr != nil {
			return callErr
		}
		if effect.MoneyWrites != 0 || effect.Sends != 0 || (!effect.Applied && !effect.Duplicate) {
			return errCloudStatusEffect
		}
		return nil
	})
	if err != nil {
		return endpoint.Result{}, cloudStatusClosed()
	}
	return endpoint.Result{Value: map[string]any{"accepted": true, "duplicate": effect.Duplicate}}, nil
}

func cloudStatusClosed() error {
	return apierr.New(http.StatusUnauthorized, "recusado")
}

func cloudStatusAccount(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	rest, ok := strings.CutPrefix(r.URL.Path, cloudStatusPrefix)
	if !ok || rest == "" || strings.Contains(rest, "/") {
		return ""
	}
	return rest
}

func cloudStatusHeaders(r *http.Request) map[string]string {
	if r == nil {
		return nil
	}
	out := make(map[string]string, len(r.Header))
	for key, values := range r.Header {
		if len(values) == 0 || values[0] == "" {
			continue
		}
		out[key] = values[0]
	}
	return out
}
