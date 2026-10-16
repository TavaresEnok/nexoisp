package leitura

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

func jsText(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case jsonx.Object, map[string]any:
		return "[object Object]"
	case float64:
		if x == 0 {
			return "0"
		}
		raw, _ := jsonx.Encode(x)
		return string(raw)
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			if item != nil {
				parts[i] = jsText(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return fmt.Sprint(v)
	}
}
func jsSlice(text string, limit int) any {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	units = units[:limit]
	last := units[len(units)-1]
	if last >= 0xd800 && last <= 0xdbff {
		prefix, _ := json.Marshal(string(utf16.Decode(units[:len(units)-1])))
		return json.RawMessage(string(prefix[:len(prefix)-1]) + fmt.Sprintf(`\u%04x"`, last))
	}
	return string(utf16.Decode(units))
}
func field(row jsonx.Object, key string) (any, bool) {
	for _, f := range row {
		if f.Name == key {
			return f.Value, true
		}
	}
	return nil, false
}
func label(labels map[string]string, value any) any {
	if text, ok := labels[jsText(value)]; ok {
		return text
	}
	return value
}
func (s Service) timeline(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	const path = "/api/subscribers/:id/timeline"
	c := auth.From(ctx)
	limit := v["limit"].(int)
	id := v["id"]
	sub, err := complexRows(ctx, tx, path, 0, id)
	if err != nil {
		return endpoint.Result{}, err
	}
	if len(sub) == 0 {
		return endpoint.Result{}, apierr.New(404, "assinante não encontrado")
	}
	events := []jsonx.Object{}
	push := func(index int, convert func(jsonx.Object) jsonx.Object) error {
		rows, err := complexRows(ctx, tx, path, index, id, limit)
		if err != nil {
			return err
		}
		for _, row := range rows {
			events = append(events, convert(row))
		}
		return nil
	}
	err = push(1, func(r jsonx.Object) jsonx.Object {
		detail, _ := r.Get("detail").(jsonx.Object)
		var text any
		if from, present := field(detail, "from"); present {
			to, exists := field(detail, "to")
			right := "undefined"
			if exists {
				right = jsText(to)
			}
			text = jsText(from) + " → " + right
		} else {
			text = detail.Get("plan")
		}
		title := label(map[string]string{"created": "Contrato criado", "plan_changed": "Troca de plano", "ended": "Contrato encerrado", "due_day_changed": "Vencimento alterado", "credit_restricted": "Restrição de crédito", "credit_released": "Restrição de crédito retirada", "loyalty_set": "Fidelidade definida", "penalty_charged": "Multa rescisória cobrada", "penalty_waived": "Multa rescisória dispensada", "amendment": "Aditivo registrado"}, r.Get("event"))
		return jsonx.Object{{Name: "at", Value: r.Get("at")}, {Name: "kind", Value: "contract"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "by", Value: r.Get("by")}, {Name: "title", Value: title}, {Name: "detail", Value: text}}
	})
	if err != nil {
		return endpoint.Result{}, err
	}
	if slices.Contains(c.Permissions, "finance:read") {
		err = push(2, func(r jsonx.Object) jsonx.Object {
			title := "Mensalidade gerada"
			if r.Get("kind") == "agreement" {
				title = "Parcela de acordo gerada"
			} else if r.Get("kind") == "manual" {
				title = "Fatura avulsa gerada"
			}
			date := strings.Split(jsText(r.Get("due_date")), "-")
			slices.Reverse(date)
			return jsonx.Object{{Name: "at", Value: r.Get("created_at")}, {Name: "kind", Value: "invoice"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "ref", Value: r.Get("id")}, {Name: "title", Value: title}, {Name: "detail", Value: "R$ " + strings.ReplaceAll(fmt.Sprintf("%.2f", num(r.Get("amount_cents"))/100), ".", ",") + " · vence " + strings.Join(date, "/")}}
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		err = push(3, func(r jsonx.Object) jsonx.Object {
			title := "Pagamento registrado"
			if r.Get("kind") == "reversal" {
				title = "Baixa estornada"
			}
			source := "gateway"
			if r.Get("source") == "manual" {
				source = "baixa manual"
			}
			return jsonx.Object{{Name: "at", Value: r.Get("paid_at")}, {Name: "kind", Value: "payment"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "ref", Value: r.Get("invoice_id")}, {Name: "title", Value: title}, {Name: "detail", Value: "R$ " + strings.ReplaceAll(fmt.Sprintf("%.2f", num(r.Get("amount_cents"))/100), ".", ",") + " · " + source}}
		})
		if err != nil {
			return endpoint.Result{}, err
		}
	}
	if slices.Contains(c.Permissions, "network:read") {
		err = push(4, func(r jsonx.Object) jsonx.Object {
			parts := []string{}
			if reason := r.Get("reason"); reason != nil && reason != "" {
				parts = append(parts, jsText(reason))
			}
			if status, ok := map[string]string{"SUCCEEDED": "concluída", "FAILED": "falhou", "PENDING": "pendente", "UNCERTAIN": "incerta", "SUPERSEDED": "substituída", "EXPIRED": "expirada"}[jsText(r.Get("status"))]; ok {
				parts = append(parts, status)
			}
			return jsonx.Object{{Name: "at", Value: r.Get("created_at")}, {Name: "kind", Value: "network"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "by", Value: r.Get("by")}, {Name: "ref", Value: r.Get("id")}, {Name: "title", Value: label(map[string]string{"subscriber.provision": "Acesso provisionado/atualizado", "subscriber.suspend": "Acesso suspenso", "subscriber.resume": "Acesso reativado"}, r.Get("action"))}, {Name: "detail", Value: strings.Join(parts, " · ")}}
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		err = push(5, func(r jsonx.Object) jsonx.Object {
			source := "concedida pela equipe"
			if r.Get("source") == "portal" {
				source = "pedida pelo assinante"
			}
			return jsonx.Object{{Name: "at", Value: r.Get("granted_at")}, {Name: "kind", Value: "network"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "by", Value: r.Get("by")}, {Name: "title", Value: "Liberação por confiança"}, {Name: "detail", Value: jsText(r.Get("days")) + " dia(s) · " + source}}
		})
		if err != nil {
			return endpoint.Result{}, err
		}
	}
	if slices.Contains(c.Modules, "field") {
		err = push(6, func(r jsonx.Object) jsonx.Object {
			kind, ok := map[string]string{"install": "instalação", "repair": "reparo", "address_change": "mudança de endereço", "removal": "retirada", "other": "outro"}[jsText(r.Get("kind"))]
			if !ok {
				kind = "undefined"
			}
			return jsonx.Object{{Name: "at", Value: r.Get("created_at")}, {Name: "kind", Value: "work_order"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "ref", Value: r.Get("id")}, {Name: "title", Value: "OS " + jsText(r.Get("number")) + ": " + kind}, {Name: "detail", Value: jsSlice(jsText(r.Get("description")), 140)}}
		})
		if err != nil {
			return endpoint.Result{}, err
		}
	}
	if slices.Contains(c.Modules, "crm") {
		err = push(7, func(r jsonx.Object) jsonx.Object {
			return jsonx.Object{{Name: "at", Value: r.Get("created_at")}, {Name: "kind", Value: "ticket"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "ref", Value: r.Get("id")}, {Name: "title", Value: "Atendimento " + jsText(r.Get("number")) + ": " + jsText(r.Get("subject"))}, {Name: "detail", Value: r.Get("status")}}
		})
		if err != nil {
			return endpoint.Result{}, err
		}
	}
	err = push(8, func(r jsonx.Object) jsonx.Object {
		title := "Anotação"
		if r.Get("alert") == true {
			title = "Anotação com alerta"
		}
		return jsonx.Object{{Name: "at", Value: r.Get("created_at")}, {Name: "kind", Value: "note"}, {Name: "contract_id", Value: r.Get("contract_id")}, {Name: "by", Value: r.Get("by")}, {Name: "ref", Value: r.Get("id")}, {Name: "title", Value: title}, {Name: "detail", Value: jsSlice(jsText(r.Get("body")), 200)}}
	})
	if err != nil {
		return endpoint.Result{}, err
	}
	sort.SliceStable(events, func(i, j int) bool {
		return asTime(events[i].Get("at")).UnixMilli() > asTime(events[j].Get("at")).UnixMilli()
	})
	return endpoint.Result{Value: events[:min(len(events), limit)]}, nil
}
func currencyBRL(cents float64) string {
	digits := strconv.FormatInt(int64(cents), 10)
	negative := strings.HasPrefix(digits, "-")
	digits = strings.TrimPrefix(digits, "-")
	for len(digits) < 3 {
		digits = "0" + digits
	}
	whole, fraction := digits[:len(digits)-2], digits[len(digits)-2:]
	for i := len(whole) - 3; i > 0; i -= 3 {
		whole = whole[:i] + "." + whole[i:]
	}
	value := "R$\u00a0" + whole + "," + fraction
	if negative {
		value = "-" + value
	}
	return value
}
