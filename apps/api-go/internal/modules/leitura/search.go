package leitura

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

var searchMAC = regexp.MustCompile(`^([0-9A-F]{2}:){5}[0-9A-F]{2}$`)
var searchIP = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)
var searchNumber = regexp.MustCompile(`^\d{1,9}$`)

func (s Service) search(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	c := auth.From(ctx)
	text := v["q"].(string)
	digits := regexp.MustCompile(`[^0-9]`).ReplaceAllString(text, "")
	mac := strings.NewReplacer("-", ":", ".", ":").Replace(strings.ToUpper(text))
	like := "%" + strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(text) + "%"
	financial := "null::int"
	if slices.Contains(c.Permissions, "finance:read") {
		financial = "(select count(*)::int from invoices i where i.contract_id = k.id and i.status = 'open' and i.due_date < current_date)"
	}
	limit := "order by s.name, k.created_at desc limit 25"
	out := []jsonx.Object{}
	positions := map[string]int{}
	add := func(index int, label string, args ...any) error {
		order := limit
		if index == 4 {
			order = "order by s.name limit 25"
		}
		query := dynamicSQL("/api/search", index, map[string]string{"finance_overdue": financial, "lim": order})
		rows, err := tx.Objects(ctx, query, args...)
		if err != nil {
			return err
		}
		for _, row := range rows {
			key := fmt.Sprint(row.Get("contract_id"))
			if row.Get("contract_id") == nil {
				key = "s:" + fmt.Sprint(row.Get("subscriber_id"))
			}
			if i, ok := positions[key]; ok {
				matched := out[i].Get("matched").([]string)
				out[i].Set("matched", append(matched, label))
			} else {
				positions[key] = len(out)
				row.Set("matched", []string{label})
				out = append(out, row)
			}
		}
		return nil
	}
	if err := add(0, "cliente", like, digits); err != nil {
		return endpoint.Result{}, err
	}
	if err := add(1, "login", like); err != nil {
		return endpoint.Result{}, err
	}
	if searchMAC.MatchString(mac) {
		if err := add(2, "MAC", mac); err != nil {
			return endpoint.Result{}, err
		}
	}
	if searchIP.MatchString(text) {
		if err := add(3, "IP", text); err != nil {
			return endpoint.Result{}, err
		}
		if err := add(4, "IP (sessão anterior)", text); err != nil {
			return endpoint.Result{}, err
		}
	}
	if slices.Contains(c.Modules, "olt") {
		if err := add(5, "ONU", like); err != nil {
			return endpoint.Result{}, err
		}
	}
	if searchNumber.MatchString(text) {
		number, _ := strconv.Atoi(text)
		if slices.Contains(c.Modules, "field") {
			if err := add(6, "OS", number); err != nil {
				return endpoint.Result{}, err
			}
		}
		if slices.Contains(c.Modules, "crm") {
			if err := add(7, "atendimento", number); err != nil {
				return endpoint.Result{}, err
			}
		}
	}
	return endpoint.Result{Value: map[string]any{"q": text, "results": out[:min(len(out), 50)]}}, nil
}
func (s Service) mapPoints(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	lng := "longitude between $2 and $4"
	if v["west"].(float64) > v["east"].(float64) {
		lng = "(longitude >= $2 or longitude <= $4)"
	}
	args := []any{v["south"], v["west"], v["north"], v["east"]}
	layers := map[string]bool{}
	for _, name := range strings.Split(v["layers"].(string), ",") {
		layers[strings.TrimSpace(name)] = true
	}
	result := jsonx.Object{}
	for i, name := range []string{"contracts", "boxes", "pops"} {
		if !layers[name] {
			continue
		}
		params := args
		if i == 0 {
			params = append(append([]any{}, args...), v["status"])
		}
		rows, err := tx.Objects(ctx, dynamicSQL("/api/map/points", i, map[string]string{"lng": lng}), params...)
		if err != nil {
			return endpoint.Result{}, err
		}
		if i == 0 {
			result.Set("contracts", rows[:min(len(rows), 3000)])
			result.Set("contracts_truncated", len(rows) > 3000)
		} else {
			result.Set(name, rows)
		}
	}
	return endpoint.Result{Value: result}, nil
}
