package escrita

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"math"
	"net/http"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/audit"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func RegisterGateway(api huma.API, registry *endpoint.Registry, s Service) {
	registry.PublicHandle(api, "POST", "/api/webhooks/gateway/{gateway}", func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		if !finance.Demo(chi.URLParam(r, "gateway")) {
			return endpoint.Result{}, apierr.New(404, "gateway não habilitado")
		}
		connectionID := r.Header.Get("X-Nexo-Connection")
		if err := validate.UUID(connectionID); err != nil {
			return endpoint.Result{}, apierr.New(400, "X-Nexo-Connection UUID obrigatório")
		}
		connection, err := finance.LookupConnection(ctx, s.DB, connectionID)
		if err != nil {
			return endpoint.Result{}, err
		}
		if connection.Get("provider") != chi.URLParam(r, "gateway") || connection.Get("status") != "active" || connection.Get("environment") != "sandbox" {
			return endpoint.Result{}, apierr.New(404, "conexão não habilitada")
		}
		secret, err := finance.ConnectionSecret(connection)
		if err != nil {
			return endpoint.Result{}, apierr.New(401, "credencial indisponível")
		}
		raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 20<<20))
		if err != nil {
			return endpoint.Result{}, apierr.New(400, "JSON inválido")
		}
		ts := r.Header.Get("x-nexo-timestamp")
		n := validate.JSNumber(ts)
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(ts + "." + connectionID + "." + string(raw)))
		signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if secret == "" || ts == "" || math.IsNaN(n) || math.IsInf(n, 0) || math.Abs(float64(time.Now().UnixNano())/1e9-n) > 300 || !hmac.Equal([]byte(signature), []byte(r.Header.Get("x-nexo-signature"))) {
			return endpoint.Result{}, apierr.New(401, "assinatura inválida")
		}
		if _, err := providers.DecodeDemo(raw); err != nil {
			return endpoint.Result{}, apierr.New(400, err.Error())
		}
		ev, ok := jsonx.JSON(raw).(jsonx.Object)
		if !ok {
			return endpoint.Result{}, apierr.New(400, "evento inválido")
		}
		if jsonx.String(ev.Get("id")) == "" || jsonx.String(ev.Get("type")) == "" {
			return endpoint.Result{}, apierr.New(400, "evento inválido")
		}
		out, err := finance.Event(ctx, s.DB, connection, ev)
		return endpoint.Result{Value: out}, err
	})
}
func (s Service) demoPay(ctx context.Context, _ *db.Tx, _ string, b map[string]any) (any, error) {
	if !finance.Demo("demo") {
		return nil, apierr.New(404, "disponível apenas no modo demonstração")
	}
	var pay jsonx.Object
	var charge any
	var connectionID string
	err := s.DB.WithScope(ctx, auth.From(ctx).Scope, func(tx *db.Tx) error {
		inv, e := one(ctx, tx, "POST /api/demo-gateway/pay", 0, b["invoice_id"])
		if e != nil {
			return e
		}
		if inv == nil {
			return apierr.New(400, "fatura sem cobrança no gateway de demonstração")
		}
		var active bool
		if e = tx.QueryRow(ctx, `select exists(select 1 from financial_connections where id=$1 and status='active' and provider='demo' and environment='sandbox')`, inv.Get("financial_connection_id")).Scan(&active); e != nil {
			return e
		}
		if !active {
			return apierr.New(409, "conexão demonstrativa indisponível neste escopo")
		}
		amount := num(inv.Get("amount_cents"))
		if b["mode"] == "divergent" {
			amount = max(1, amount-1000)
		}
		pay = jsonx.Object{{Name: "id", Value: "demo_pay_" + uuid.NewString()}, {Name: "amount_cents", Value: amount}, {Name: "paid_at", Value: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, {Name: "method", Value: "pix"}}
		encoded, e := jsonx.Encode([]any{pay})
		if e != nil {
			return e
		}
		charge = inv.Get("gateway_charge_id")
		connectionID = jsonx.String(inv.Get("financial_connection_id"))
		return tx.Exec(ctx, query("POST /api/demo-gateway/pay", 1), charge, encoded, connectionID)
	})
	if err != nil {
		return nil, err
	}
	if b["mode"] == "lost" {
		return map[string]any{"simulated": true, "webhook": "não enviado (perda simulada); use a conciliação para recuperar"}, nil
	}
	ev := jsonx.Object{{Name: "id", Value: "demo_evt_" + uuid.NewString()}, {Name: "type", Value: "payment.confirmed"}, {Name: "charge_id", Value: charge}, {Name: "payment", Value: pay}}
	connection, err := finance.LookupConnection(ctx, s.DB, connectionID)
	if err != nil {
		return nil, err
	}
	out, err := finance.Event(ctx, s.DB, connection, ev)
	if err != nil {
		return nil, err
	}
	r := map[string]any{"simulated": true, "webhook": out}
	if b["mode"] == "duplicate" {
		r["webhook_repeated"], err = finance.Event(ctx, s.DB, connection, ev)
	}
	return r, err
}
func (s Service) portalTrust(ctx context.Context, _ *db.Tx, _ string, b map[string]any) (any, error) {
	c := auth.From(ctx)
	if c.SubscriberID == "" {
		return nil, apierr.New(403, "sessão sem assinante")
	}
	id := b["contract_id"].(string)
	err := s.DB.WithScope(ctx, c.Scope, func(tx *db.Tx) error {
		_, e := mustRow(ctx, tx, "POST /api/portal/trust-release", 0, "contrato não encontrado", id, c.SubscriberID)
		return e
	})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	err = s.DB.WithScope(ctx, tenancy.Scope{TenantID: c.TenantID}, func(tx *db.Tx) error {
		r, e := finance.Grant(ctx, tx, c.TenantID, c.UserID, id, map[string]any{"source": "portal", "reason": "pedido pelo portal do assinante"})
		if e != nil {
			return e
		}
		if e = audit.InTx(ctx, tx, c, "contract.trust_release", "contract", id, map[string]any{"days": r["days"], "source": "portal", "operation_id": r["operation_id"]}, "ok"); e != nil {
			return e
		}
		out = map[string]any{"expires_at": r["expires_at"], "days": r["days"]}
		return nil
	})
	return out, err
}
