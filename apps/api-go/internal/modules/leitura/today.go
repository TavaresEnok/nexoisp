package leitura

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"slices"
	"sort"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

func (s Service) today(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]any) (endpoint.Result, error) {
	const path = "/api/today"
	c := auth.From(ctx)
	has := func(permission, module string) bool {
		return slices.Contains(c.Permissions, permission) && (module == "" || slices.Contains(c.Modules, module))
	}
	nocLink := "/rede"
	if slices.Contains(c.Modules, "noc") {
		nocLink = "/noc"
	}
	items := []jsonx.Object{}
	add := func(n any, severity, one, many, link string, detail *string) {
		if num(n) <= 0 {
			return
		}
		title := many
		if num(n) == 1 {
			title = one
		}
		row := jsonx.Object{{Name: "n", Value: n}, {Name: "title", Value: title}, {Name: "link", Value: link}, {Name: "severity", Value: severity}}
		if detail != nil {
			row.Set("detail", *detail)
		}
		items = append(items, row)
	}
	str := func(s string) *string { return &s }
	one := func(index int, args ...any) (jsonx.Object, error) {
		rows, err := complexRows(ctx, tx, path, index, args...)
		return object(rows), err
	}
	if has("network:read", "") {
		r, err := one(0)
		if err != nil {
			return endpoint.Result{}, err
		}
		add(r.Get("agents"), "critical", "agente offline", "agentes offline", nocLink, str("Leituras e operações desse site estão paradas."))
		add(r.Get("uncertain"), "critical", "operação com resultado incerto", "operações com resultado incerto", "/operacoes?filter=problem", str("O equipamento fica bloqueado até a verificação."))
		if slices.Contains(c.Modules, "olt") {
			link := "/onus"
			if slices.Contains(c.Modules, "noc") {
				link = "/noc"
			}
			add(r.Get("onus"), "warning", "ONU sem sinal", "ONUs sem sinal", link, nil)
		}
		add(r.Get("failed"), "warning", "operação falhou ou expirou em 24 h", "operações falharam ou expiraram em 24 h", "/operacoes?filter=problem", nil)
	}
	if has("crm:read", "crm") {
		r, err := one(1, c.UserID)
		if err != nil {
			return endpoint.Result{}, err
		}
		var detail *string
		if num(r.Get("mine")) != 0 {
			detail = str(fmt.Sprint(r.Get("mine")) + " com você.")
		}
		add(r.Get("open"), "warning", "atendimento aguardando resposta do provedor", "atendimentos aguardando resposta do provedor", "/atendimentos", detail)
		add(r.Get("leads"), "info", "prospecto novo sem contato", "prospectos novos sem contato", "/prospectos", nil)
	}
	if has("os:read", "field") {
		r, err := one(2, c.UserID)
		if err != nil {
			return endpoint.Result{}, err
		}
		add(r.Get("late"), "warning", "ordem de serviço com agendamento vencido", "ordens de serviço com agendamento vencido", "/ordens-servico", nil)
		add(r.Get("mine"), "info", "ordem de serviço em aberto com você", "ordens de serviço em aberto com você", "/meu-trabalho", nil)
		add(r.Get("unassigned"), "info", "ordem de serviço sem responsável", "ordens de serviço sem responsável", "/ordens-servico", nil)
	}
	if has("finance:read", "") {
		r, err := one(3)
		if err != nil {
			return endpoint.Result{}, err
		}
		add(r.Get("reconciling"), "warning", "fatura em conciliação", "faturas em conciliação", "/conciliacao", str("Pagamento divergente aguardando decisão."))
		add(r.Get("overdue"), "info", "fatura vencida", "faturas vencidas", "/faturas", str("Total de "+currencyBRL(num(r.Get("overdue_cents")))+"."))
	}
	if has("stock:read", "field") {
		r, err := one(4)
		if err != nil {
			return endpoint.Result{}, err
		}
		add(r.Get("low"), "info", "item de estoque abaixo do mínimo", "itens de estoque abaixo do mínimo", "/estoque", nil)
	}
	rank := map[string]int{"critical": 0, "warning": 1, "info": 2}
	sort.SliceStable(items, func(i, j int) bool {
		return rank[jsText(items[i].Get("severity"))] < rank[jsText(items[j].Get("severity"))]
	})
	return endpoint.Result{Value: map[string]any{"name": c.Name, "items": items}}, nil
}

var radiusKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{24,}$`)
var l2tpKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,}$`)

func envNullishNumber(name string, fallback float64) float64 {
	v, present := os.LookupEnv(name)
	if !present {
		return fallback
	}
	return validate.JSNumber(v)
}
func wireNumber(value float64) any {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return value
}
func radiusHost() string {
	if host := os.Getenv("NEXO_RADIUS_PUBLIC_HOST"); host != "" {
		return host
	}
	return "<endereço do NexoISP>"
}
func vpnHost() string {
	if host := os.Getenv("NEXO_VPN_PUBLIC_HOST"); host != "" {
		return host
	}
	return radiusHost()
}
func (s Service) radiusStatus(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]any) (endpoint.Result, error) {
	rows, err := complexRows(ctx, tx, "/api/radius/status", 0)
	if err != nil {
		return endpoint.Result{}, err
	}
	port := envNullishNumber("NEXO_RADIUS_PORT", 1812)
	vendors := []map[string]any{}
	for _, vendor := range []string{"mikrotik", "huawei", "cisco", "generic"} {
		vendors = append(vendors, map[string]any{"id": vendor, "validated": vendor == "mikrotik", "tunnel": vendor == "mikrotik" || vendor == "generic"})
	}
	return endpoint.Result{Value: map[string]any{"enabled": radiusKeyPattern.MatchString(os.Getenv("NEXO_RADIUS_KEY")), "host": radiusHost(), "authPort": wireNumber(port), "acctPort": wireNumber(port + 1), "host_configured": os.Getenv("NEXO_RADIUS_PUBLIC_HOST") != "", "vpn": map[string]any{"enabled": len(rows) > 0, "endpoint": map[string]any{"host": vpnHost(), "port": wireNumber(envNullishNumber("NEXO_VPN_PORT", 51820))}, "l2tp": l2tpKeyPattern.MatchString(os.Getenv("NEXO_L2TP_PSK"))}, "vendors": vendors}}, nil
}
