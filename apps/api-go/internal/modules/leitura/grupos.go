package leitura

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
	"nexoisp/api-go/internal/validate"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

type grupo struct {
	Path, Permission string
	SQL              []string
}

func registerGrupos(api huma.API, registry *endpoint.Registry, s Service) {
	for _, spec := range grupos {
		registry.Get(api, spec.Path, spec.Permission, false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
			id := chi.URLParam(r, "id")
			if strings.Contains(spec.Path, "{id}") {
				if err := validate.UUID(id); err != nil {
					return endpoint.Result{}, err
				}
			}
			input, parseErr := parsePaged(spec.Path, r, auth.From(ctx).UserID)
			if parseErr != nil {
				return endpoint.Result{}, parseErr
			}
			scope := auth.From(ctx).Scope
			if spec.Path == "/api/tenants" {
				if auth.From(ctx).Role != "saas_operator" {
					return endpoint.Result{}, apierr.New(403, "sem permissão")
				}
				var err error
				scope, err = tenancy.OperatorScope("listar_provedores")
				if err != nil {
					return endpoint.Result{}, err
				}
			}
			var value any
			err := s.DB.WithScope(ctx, scope, func(tx *db.Tx) error {
				var err error
				if input != nil {
					value, err = s.pagedGroup(ctx, tx, spec, input)
				} else {
					value, err = s.grupo(ctx, tx, spec, id)
				}
				return err
			})
			if result, ok := value.(endpoint.Result); ok {
				if err == nil && spec.Path != "/api/surveys" {
					return s.export(ctx, r, result)
				}
				return result, err
			}
			return endpoint.Result{Value: value}, err
		})
	}
}
func (s Service) grupo(ctx context.Context, tx *db.Tx, spec grupo, id string) (any, error) {
	c := auth.From(ctx)
	query := func(i int, args ...any) ([]jsonx.Object, error) {
		legacy := spec.SQL[i]
		if i != 0 {
			return tx.Objects(ctx, legacy, args...)
		}
		switch spec.Path {
		case "/api/invoices/{id}":
			return balanceRowsInTx(ctx, tx, balanceReaderInvoiceDetail, legacy, args...)
		case "/api/contracts/{id}/finance":
			return balanceRowsInTx(ctx, tx, balanceReaderContractFinanceList, legacy, args...)
		case "/api/finance/reconciliation":
			return balanceRowsInTx(ctx, tx, balanceReaderReconciliationInvoices, legacy, args...)
		default:
			return tx.Objects(ctx, legacy, args...)
		}
	}
	switch spec.Path {
	case "/api/leads/{id}", "/api/tickets/{id}", "/api/work-orders/{id}", "/api/ftth/boxes/{id}", "/api/invoices/{id}":
		rows, err := query(0, id)
		if err != nil {
			return nil, err
		}
		missing := map[string]string{"/api/leads/{id}": "prospecto não encontrado", "/api/tickets/{id}": "atendimento não encontrado", "/api/work-orders/{id}": "ordem de serviço não encontrada", "/api/ftth/boxes/{id}": "caixa não encontrada", "/api/invoices/{id}": "fatura não encontrada"}
		if len(rows) == 0 {
			return nil, apierr.New(404, missing[spec.Path])
		}
		result := rows[0]
		keys := map[string][]string{"/api/leads/{id}": {"events"}, "/api/tickets/{id}": {"thread", "work_orders"}, "/api/work-orders/{id}": {"events", "helpers", "checklist", "materials"}, "/api/ftth/boxes/{id}": {"drops"}, "/api/invoices/{id}": {"items", "payments", "events"}}[spec.Path]
		for i, key := range keys {
			if spec.Path == "/api/invoices/{id}" && key == "events" {
				events := []jsonx.Object{}
				if result.Get("gateway_charge_id") != nil {
					events, err = query(i+1, result.Get("gateway"), result.Get("gateway_charge_id"), id)
				}
				if err != nil {
					return nil, err
				}
				result.Set(key, events)
			} else {
				items, err := query(i+1, id)
				if err != nil {
					return nil, err
				}
				result.Set(key, items)
			}
		}
		return result, nil
	case "/api/contracts/{id}/equipment":
		rows, err := query(0, id)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "contrato não encontrado")
		}
		units, err := query(1, id)
		if err != nil {
			return nil, err
		}
		recover := []jsonx.Object{}
		if rows[0].Get("status") == "ended" {
			for _, u := range units {
				if u.Get("contract_mode") == "comodato" {
					recover = append(recover, u)
				}
			}
		}
		return map[string]any{"units": units, "to_recover": recover}, nil
	case "/api/radius/allowed-sources":
		rows, err := query(0)
		if err != nil {
			return nil, err
		}
		direct, tunnel := []jsonx.Object{}, []jsonx.Object{}
		for _, row := range rows {
			if row.Get("via_tunnel") == true {
				tunnel = append(tunnel, row)
			} else {
				direct = append(direct, row)
			}
		}
		return map[string]any{"direct": direct, "tunnel": tunnel, "note": "Concentradores por túnel não precisam de regra: chegam pelo túnel. Para os diretos, libere UDP 1812 e 1813 só destes endereços."}, nil
	case "/api/contracts/{id}/radius-log":
		resources, err := query(0, id)
		if err != nil {
			return nil, err
		}
		resource := object(resources)
		if resource.Get("driver") != "radius" {
			return map[string]any{"integrated": false, "rows": []jsonx.Object{}}, nil
		}
		rows, err := query(1, resource.Get("pppoe_username"))
		return map[string]any{"integrated": true, "username": resource.Get("pppoe_username"), "rows": rows}, err
	case "/api/notifications":
		settings, err := query(0, c.TenantID)
		if err != nil {
			return nil, err
		}
		recent, err := query(1)
		return map[string]any{"webhook_url": object(settings).Get("notify_webhook_url"), "recent": recent}, err
	case "/api/finance/reconciliation", "/api/map/coverage":
		result := jsonx.Object{}
		keys := []string{"invoices", "events"}
		if spec.Path == "/api/map/coverage" {
			keys = []string{"contracts", "boxes", "pops"}
		}
		for i, key := range keys {
			rows, err := query(i)
			if err != nil {
				return nil, err
			}
			var value any = rows
			if spec.Path == "/api/map/coverage" {
				value = first(rows)
			}
			result.Set(key, value)
		}
		return result, nil
	case "/api/notice-page":
		rows, err := query(0, c.TenantID)
		row := object(rows)
		return map[string]any{"page": row.Get("notice_page"), "path": "/aviso/" + fmt.Sprint(row.Get("slug"))}, err
	case "/api/settings/retention":
		rows, err := query(0, c.TenantID)
		v := object(rows)
		return map[string]any{"auth_log_days": v.Get("retention_auth_log_days"), "sessions_days": v.Get("retention_sessions_days"), "notice_log_days": v.Get("retention_notice_log_days"), "defaults": map[string]any{"auth_log_days": numberEnv("NEXO_RADIUS_LOG_DAYS", 30), "sessions_days": numberEnv("NEXO_SESSION_KEEP_DAYS", 400), "notice_log_days": numberEnv("NEXO_NOTICE_LOG_DAYS", 400)}, "limits": map[string]any{"auth_log_days": []int{7, 365}, "sessions_days": []int{365, 1825}, "notice_log_days": []int{30, 1825}}, "kept": "Faturas, pagamentos, aceites e auditoria não são apagados pela rotina."}, err
	case "/api/notice-templates":
		rows, err := query(0)
		if err != nil {
			return nil, err
		}
		for i, row := range rows {
			rows[i].Set("preview", renderTemplate(row.Get("body").(string)))
		}
		return map[string]any{"variables": []string{"nome", "valor", "vencimento", "plano", "link"}, "rows": rows}, nil
	case "/api/contracts/{id}/finance":
		rows, err := query(0, id)
		if err != nil {
			return nil, err
		}
		// Aggregate all titles, independently from the paginated/latest-24 list.
		totals, err := contractFinanceTotals(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		result := object(totals)
		result.Set("invoices", rows)
		return result, nil
	case "/api/finance/monthly":
		settings, err := tx.Objects(ctx, "select timezone from tenant_settings where tenant_id=$1", c.TenantID)
		if err != nil {
			return nil, err
		}
		tz := object(settings).Get("timezone")
		if tz == nil {
			tz = "America/Sao_Paulo"
		}
		return query(0, tz)
	case "/api/contracts/{id}/states":
		rows, err := query(0, id)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "contrato não encontrado")
		}
		return contractStates(rows[0]), nil
	case "/api/acceptances/{id}/evidence":
		rows, err := query(0, id)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return nil, apierr.New(404, "aceite não encontrado")
		}
		return acceptanceEvidence(rows[0]), nil
	case "/api/tenants":
		return query(0)
	}
	return nil, fmt.Errorf("grupo não implementado: %s", spec.Path)
}
func num(v any) float64 {
	switch x := v.(type) {
	case int32:
		return float64(x)
	case int64:
		return float64(x)
	case float64:
		return x
	case string:
		n, _ := strconv.ParseFloat(x, 64)
		return n
	}
	return 0
}
func numberEnv(name string, fallback float64) float64 {
	value, _ := strconv.ParseFloat(os.Getenv(name), 64)
	if value == 0 || math.IsNaN(value) {
		return fallback
	}
	return value
}

var templateVariable = regexp.MustCompile(`\{([a-z_]+)\}`)
var templateSpaces = regexp.MustCompile(`[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]{2,}`)

func renderTemplate(body string) string {
	sample := map[string]string{"nome": "Maria", "valor": "R$ 79,90", "vencimento": "10/11/2026", "plano": "Fibra 200", "link": "https://exemplo.invalido/"}
	return validate.Trim(templateSpaces.ReplaceAllString(templateVariable.ReplaceAllStringFunc(body, func(v string) string { return sample[v[1:len(v)-1]] }), " "))
}
func contractStates(k jsonx.Object) map[string]any {
	var mode any
	if k.Get("by_type") == "user" {
		mode = "manual"
	} else if k.Get("by_type") != nil && k.Get("by_type") != "" {
		mode = "automatic"
	}
	access, speed := "active", "normal"
	ended := k.Get("status") == "ended"
	resource := k.Get("resource_id") != nil
	switch {
	case ended:
		access = "blocked"
	case !resource:
		access = "no_account"
	case k.Get("desired_policy") == "suspended" && k.Get("desired_stage") == "reduced":
		speed = "reduced"
	case k.Get("desired_policy") == "suspended":
		access = "blocked"
	}
	commercial := "active"
	if ended {
		commercial = "ended"
	} else if k.Get("credit_restricted_at") != nil {
		commercial = "credit_restricted"
	}
	var cause any
	reason := k.Get("desired_reason")
	if ended {
		cause = "contract_ended"
		mode = nil
		reason = nil
	} else if access == "blocked" || speed == "reduced" {
		cause = "other"
		if strings.Contains(strings.ToLower(fmt.Sprint(k.Get("desired_reason"))), "inadimpl") {
			cause = "financial"
		}
	}
	var applied any
	if resource {
		applied = k.Get("observed_version") == k.Get("desired_version") && k.Get("observed_policy") == k.Get("desired_policy")
	}
	return map[string]any{"commercial": map[string]any{"state": commercial, "start_date": k.Get("start_date"), "end_date": k.Get("end_date"), "end_reason": k.Get("end_reason"), "end_note": k.Get("end_note"), "credit_restricted_at": k.Get("credit_restricted_at")}, "access": map[string]any{"state": access, "mode": mode, "cause": cause, "reason": reason, "since": k.Get("desired_at"), "applied": applied}, "speed": map[string]any{"state": speed}}
}
func hash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func acceptanceEvidence(a jsonx.Object) map[string]any {
	textOK := hash(a.Get("body").(string)) == a.Get("body_hash")
	var proof any
	if a.Get("status") == "accepted" {
		canonical := jsonx.Object{{Name: "v", Value: 1}, {Name: "id", Value: a.Get("id")}, {Name: "contract", Value: a.Get("contract_id")}, {Name: "subscriber", Value: a.Get("subscriber_id")}, {Name: "body", Value: a.Get("body_hash")}, {Name: "user", Value: a.Get("accepted_by")}, {Name: "at", Value: a.Get("accepted_at")}, {Name: "ip", Value: a.Get("accepted_ip")}}
		raw, _ := jsonx.Encode(canonical)
		proof = hash(string(raw)) == a.Get("evidence_hash")
	}
	return map[string]any{"id": a.Get("id"), "status": a.Get("status"), "title": a.Get("title"), "body": a.Get("body"), "body_hash": a.Get("body_hash"), "contract_id": a.Get("contract_id"), "subscriber": map[string]any{"id": a.Get("subscriber_id"), "name": a.Get("subscriber_name"), "document": a.Get("subscriber_document")}, "requested_at": a.Get("requested_at"), "accepted_at": a.Get("accepted_at"), "accepted_ip": a.Get("accepted_ip"), "accepted_user_agent": a.Get("accepted_user_agent"), "accepted_email": a.Get("accepted_email"), "evidence_hash": a.Get("evidence_hash"), "verification": map[string]any{"text_matches_hash": textOK, "evidence_matches": proof}, "method": "Aceite eletrônico simples: identificação por acesso autenticado ao portal do assinante (Lei 14.063/2020, art. 4º, I). Não é assinatura avançada nem qualificada."}
}
