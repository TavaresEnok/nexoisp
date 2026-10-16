package leitura

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"slices"
	"time"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

func (s Service) availability(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	const path = "/api/contracts/:id/availability"
	timezone, err := complexRows(ctx, tx, path, 0, auth.From(ctx).TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	tz := object(timezone).Get("tz")
	resources, err := complexRows(ctx, tx, path, 1, v["id"])
	if err != nil {
		return endpoint.Result{}, err
	}
	if len(resources) == 0 {
		return endpoint.Result{Value: map[string]any{"timezone": tz, "days": []jsonx.Object{}, "total": nil, "note": "Contrato sem conta de acesso."}}, nil
	}
	resource := resources[0]
	rows, err := complexRows(ctx, tx, path, 2, resource.Get("id"), tz, v["days"], asTime(resource.Get("created_at")))
	if err != nil {
		return endpoint.Result{}, err
	}
	window, online := float64(0), float64(0)
	days := []map[string]any{}
	percent := func(on, win float64) any {
		if win <= 0 {
			return nil
		}
		return jsRound(math.Min(100, on/win*1000)) / 10
	}
	for _, row := range rows {
		w, on := num(row.Get("window_seconds")), num(row.Get("online_seconds"))
		window += w
		upper := w
		if upper == 0 {
			upper = on
		}
		online += math.Min(on, upper)
		days = append(days, map[string]any{"day": row.Get("day"), "online_seconds": jsRound(on), "offline_seconds": math.Max(0, jsRound(w-on)), "availability_pct": percent(on, w), "sessions": row.Get("sessions")})
	}
	return endpoint.Result{Value: map[string]any{"timezone": tz, "days": days, "total": map[string]any{"online_seconds": jsRound(online), "window_seconds": jsRound(window), "availability_pct": percent(online, window)}, "note": "Calculado com as sessões que o agente relatou; falha de sincronização aparece como indisponibilidade."}}, nil
}
func (s Service) agenda(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	const path = "/api/agenda"
	tz, err := tzFor(ctx, tx, auth.From(ctx).TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	rows, err := complexRows(ctx, tx, path, 0, v["date"], tz, v["days"], v["assignee_id"])
	if err != nil {
		return endpoint.Result{}, err
	}
	waiting, err := complexRows(ctx, tx, path, 1)
	if err != nil {
		return endpoint.Result{}, err
	}
	technicians := []jsonx.Object{}
	positions := map[string]int{}
	for _, row := range rows {
		key := "none"
		if id := row.Get("assignee_id"); id != nil {
			key = fmt.Sprint(id)
		}
		i, exists := positions[key]
		if !exists {
			i = len(technicians)
			positions[key] = i
			name := row.Get("assignee_name")
			if name == nil {
				name = "Sem responsável"
			}
			technicians = append(technicians, jsonx.Object{{Name: "assignee_id", Value: row.Get("assignee_id")}, {Name: "name", Value: name}, {Name: "items", Value: []jsonx.Object{}}})
		}
		items := technicians[i].Get("items").([]jsonx.Object)
		items = append(items, row)
		technicians[i].Set("items", items)
	}
	for i, tech := range technicians {
		previous := int64(0)
		items := tech.Get("items").([]jsonx.Object)
		for j, item := range items {
			start := asTime(item.Get("scheduled_for")).UnixMilli()
			end := start + int64(num(item.Get("estimated_minutes"))*60000)
			items[j].Set("conflict", tech.Get("assignee_id") != nil && start < previous)
			previous = max(previous, end)
		}
		technicians[i].Set("items", items)
	}
	return endpoint.Result{Value: map[string]any{"date": v["date"], "days": v["days"], "timezone": tz, "technicians": technicians, "awaiting_schedule": waiting}}, nil
}
func (s Service) agendaFree(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	const path = "/api/agenda/free"
	tz, err := tzFor(ctx, tx, auth.From(ctx).TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	dates, err := complexRows(ctx, tx, path, 0, v["date"], tz)
	if err != nil {
		return endpoint.Result{}, err
	}
	day := asTime(object(dates).Get("t"))
	start := day.UnixMilli() + int64(v["from_hour"].(int))*3600000
	end := day.UnixMilli() + int64(v["to_hour"].(int))*3600000
	busy, err := complexRows(ctx, tx, path, 1, v["assignee_id"], day.Add(-24*time.Hour), time.UnixMilli(end))
	if err != nil {
		return endpoint.Result{}, err
	}
	free := []map[string]any{}
	cursor := start
	minutes := int64(v["minutes"].(int)) * 60000
	for _, row := range busy {
		s := asTime(row.Get("scheduled_for")).UnixMilli()
		e := s + int64(num(row.Get("estimated_minutes"))*60000)
		if e <= start {
			continue
		}
		if s-cursor >= minutes {
			free = append(free, map[string]any{"from": jsonx.Time{Time: time.UnixMilli(cursor)}, "to": jsonx.Time{Time: time.UnixMilli(s)}})
		}
		cursor = max(cursor, e)
	}
	if end-cursor >= minutes {
		free = append(free, map[string]any{"from": jsonx.Time{Time: time.UnixMilli(cursor)}, "to": jsonx.Time{Time: time.UnixMilli(end)}})
	}
	return endpoint.Result{Value: map[string]any{"timezone": tz, "minutes": v["minutes"], "free": free}}, nil
}
func (s Service) dashboardPanels(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]any) (endpoint.Result, error) {
	const path = "/api/dashboard/panels"
	c := auth.From(ctx)
	zones, err := complexRows(ctx, tx, path, 0, c.TenantID)
	if err != nil {
		return endpoint.Result{}, err
	}
	tz := object(zones).Get("tz")
	off, err := complexRows(ctx, tx, path, 1)
	if err != nil {
		return endpoint.Result{}, err
	}
	labels := []string{"< 2 h", "≥ 2 h", "≥ 4 h", "≥ 6 h", "≥ 12 h", "≥ 24 h", "≥ 2 dias", "≥ 4 dias", "≥ 6 dias", "≥ 15 dias", "≥ 30 dias"}
	offline := []map[string]any{}
	for _, row := range off {
		i := int(num(row.Get("faixa")))
		label := fmt.Sprint(i)
		if i >= 0 && i < len(labels) {
			label = labels[i]
		}
		offline = append(offline, map[string]any{"label": label, "n": row.Get("n")})
	}
	signal := []jsonx.Object{}
	if slices.Contains(c.Modules, "olt") {
		signal, err = complexRows(ctx, tx, path, 2)
		if err != nil {
			return endpoint.Result{}, err
		}
	}
	months, err := complexRows(ctx, tx, path, 3, tz)
	if err != nil {
		return endpoint.Result{}, err
	}
	result := jsonx.Object{{Name: "offline", Value: offline}, {Name: "signal", Value: signal}, {Name: "contracts_by_month", Value: months}}
	if slices.Contains(c.Permissions, "finance:read") {
		cash, err := complexRows(ctx, tx, path, 4, tz)
		if err != nil {
			return endpoint.Result{}, err
		}
		without, err := complexRows(ctx, tx, path, 5, tz)
		if err != nil {
			return endpoint.Result{}, err
		}
		result.Set("cash_today", first(cash))
		result.Set("without_invoice", object(without).Get("n"))
	}
	recent, err := complexRows(ctx, tx, path, 6)
	result.Set("recent_operations", recent)
	return endpoint.Result{Value: result}, err
}
