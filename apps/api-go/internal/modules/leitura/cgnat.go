package leitura

import (
	"context"
	"math"
	"net/http"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/network"
)

var ipv4Number = network.IPv4Number
var ipv4String = network.IPv4String
var cidr4 = network.CIDR4
var cgnatForward = network.CGNATForward

func CGNATCapacity(plan jsonx.Object) map[string]any { return network.CGNATCapacity(plan) }

func (s Service) cgnat(ctx context.Context, tx *db.Tx, r *http.Request, v map[string]any) (endpoint.Result, error) {
	path := "/api/cgnat/plans"
	if strings.HasSuffix(r.URL.Path, "/map") {
		path += "/:id/map"
	} else if strings.HasSuffix(r.URL.Path, "/lookup") {
		path += "/:id/lookup"
	}
	if path == "/api/cgnat/plans" {
		rows, err := complexRows(ctx, tx, path, 0)
		if err != nil {
			return endpoint.Result{}, err
		}
		for i, row := range rows {
			rows[i].Set("capacity", CGNATCapacity(row))
		}
		return endpoint.Result{Value: rows}, nil
	}
	rows, err := complexRows(ctx, tx, "helper:loadPlan", 0, v["id"])
	if err != nil {
		return endpoint.Result{}, err
	}
	if len(rows) == 0 {
		return endpoint.Result{}, apierr.New(404, "plano de CGNAT não encontrado")
	}
	plan := rows[0]
	if path == "/api/cgnat/plans/:id/lookup" {
		block := cgnatForward(plan, v["private_ip"].(string))
		if block == nil {
			return endpoint.Result{}, apierr.New(404, "o endereço não pertence ao bloco de assinantes deste plano")
		}
		return endpoint.Result{Value: block}, nil
	}
	base, total := cidr4(plan.Get("private_cidr"))
	offset := v["offset"].(float64)
	limit := v["limit"].(int)
	blocks := []any{}
	capacity := CGNATCapacity(plan)
	validCount := math.Min(float64(total), capacity["max_private_ips"].(float64))
	for i := offset; i < validCount && len(blocks) < limit; i++ {
		if block := cgnatForward(plan, ipv4String(base+uint64(i))); block != nil {
			blocks = append(blocks, block)
		}
	}
	plan.Set("capacity", capacity)
	return endpoint.Result{Value: map[string]any{"plan": plan, "total": total, "rows": blocks}}, nil
}
