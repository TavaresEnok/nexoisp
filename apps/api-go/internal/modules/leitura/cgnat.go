package leitura

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

var ipv4RE = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)

func ipv4Number(ip string) (uint64, bool) {
	if !ipv4RE.MatchString(ip) {
		return 0, false
	}
	var value uint64
	for _, part := range strings.Split(ip, ".") {
		n, err := strconv.Atoi(part)
		if err != nil || n > 255 {
			return 0, false
		}
		value = value*256 + uint64(n)
	}
	return value, true
}
func ipv4String(ip uint64) string {
	return fmt.Sprintf("%d.%d.%d.%d", (ip>>24)&255, (ip>>16)&255, (ip>>8)&255, ip&255)
}
func cidr4(cidr any) (uint64, uint64) {
	parts := strings.Split(fmt.Sprint(cidr), "/")
	if len(parts) != 2 {
		panic("CIDR inválido no banco")
	}
	base, valid := ipv4Number(parts[0])
	mask, err := strconv.Atoi(parts[1])
	if !valid || err != nil || mask < 0 || mask > 32 {
		panic("CIDR IPv4 inválido no banco")
	}
	return base, uint64(1) << uint(32-mask)
}
func cgnatCapacity(plan jsonx.Object) map[string]any {
	_, public := cidr4(plan.Get("public_cidr"))
	_, private := cidr4(plan.Get("private_cidr"))
	per := math.Floor((65536 - num(plan.Get("port_start"))) / num(plan.Get("ports_per_subscriber")))
	max := float64(public) * per
	return map[string]any{"public_ips": public, "private_ips": private, "blocks_per_public": per, "max_private_ips": max, "fits": float64(private) <= max, "ratio": math.Min(per, math.Ceil(float64(private)/float64(public)))}
}
func cgnatForward(plan jsonx.Object, ip string) any {
	base, size := cidr4(plan.Get("private_cidr"))
	pubBase, pubSize := cidr4(plan.Get("public_cidr"))
	number, valid := ipv4Number(ip)
	if !valid || number < base || number-base >= size {
		return nil
	}
	ports, start := num(plan.Get("ports_per_subscriber")), num(plan.Get("port_start"))
	per := math.Floor((65536 - start) / ports)
	if per <= 0 {
		return nil
	}
	index := number - base
	publicIndex := uint64(math.Floor(float64(index) / per))
	if publicIndex >= pubSize {
		return nil
	}
	first := start + math.Mod(float64(index), per)*ports
	return map[string]any{"private_ip": ip, "public_ip": ipv4String(pubBase + publicIndex), "port_start": first, "port_end": first + ports - 1}
}
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
			rows[i].Set("capacity", cgnatCapacity(row))
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
	capacity := cgnatCapacity(plan)
	validCount := math.Min(float64(total), capacity["max_private_ips"].(float64))
	for i := offset; i < validCount && len(blocks) < limit; i++ {
		if block := cgnatForward(plan, ipv4String(base+uint64(i))); block != nil {
			blocks = append(blocks, block)
		}
	}
	plan.Set("capacity", capacity)
	return endpoint.Result{Value: map[string]any{"plan": plan, "total": total, "rows": blocks}}, nil
}
