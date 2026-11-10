package network

import (
	"strings"
	"testing"

	"nexoisp/api-go/internal/jsonx"
)

func cgnatPlan(fields map[string]any) jsonx.Object {
	plan := jsonx.Object{}
	plan.Set("id", "0123456789abcdef")
	plan.Set("name", "teste")
	for k, v := range fields {
		plan.Set(k, v)
	}
	return plan
}

// O layout sequencial é o das regras geradas pelo NexoISP e não pode mudar.
func TestCGNATSequencialInalterado(t *testing.T) {
	plan := cgnatPlan(map[string]any{"public_cidr": "198.51.100.0/30", "private_cidr": "100.64.0.0/24", "ports_per_subscriber": float64(2016), "port_start": float64(1024)})
	f := CGNATForward(plan, "100.64.0.33") // 32 blocos por IP: índice 33 -> IP 1, bloco 1
	if f["public_ip"] != "198.51.100.1" || f["port_start"] != float64(1024+2016) {
		t.Fatalf("sequencial mudou: %v", f)
	}
	r := CGNATReverse(plan, "198.51.100.1", 1024+2016+5)
	if r == nil || r["private_ip"] != "100.64.0.33" {
		t.Fatalf("reverso sequencial: %v", r)
	}
	if n := len(CGNATSharers(plan, "198.51.100.1")); n != 32 {
		t.Fatalf("compartilham o IP: %d", n)
	}
}

// Netmap do mercado: bloco privado do tamanho do público, contíguo; o bloco seguinte usa a faixa de portas seguinte.
func TestCGNATNetmap(t *testing.T) {
	plan := cgnatPlan(map[string]any{"layout": "netmap", "public_cidr": "198.51.100.0/29", "private_cidr": "100.64.0.0/23", "ports_per_subscriber": float64(1008), "port_start": float64(1024)})
	// 100.64.0.13 = índice 13 = bloco privado 1 (8..15), deslocamento 5 -> 198.51.100.5, portas 2032-3039
	f := CGNATForward(plan, "100.64.0.13")
	if f["public_ip"] != "198.51.100.5" || f["port_start"] != float64(2032) || f["port_end"] != float64(3039) {
		t.Fatalf("netmap direto: %v", f)
	}
	for _, private := range []string{"100.64.0.0", "100.64.0.13", "100.64.1.255"} {
		f := CGNATForward(plan, private)
		r := CGNATReverse(plan, f["public_ip"].(string), f["port_start"].(float64)+7)
		if r == nil || r["private_ip"] != private {
			t.Fatalf("ida e volta de %s: %v -> %v", private, f, r)
		}
	}
	sharers := CGNATSharers(plan, "198.51.100.5")
	if len(sharers) != 64 || sharers[0] != 5 || sharers[1] != 13 {
		t.Fatalf("compartilham o IP no netmap: %v", sharers[:3])
	}
	script := CGNATScript(plan)
	if !strings.Contains(script, "src-address=100.64.0.8/29 protocol=tcp action=netmap to-addresses=198.51.100.0/29 to-ports=2032-3039") {
		t.Fatalf("script netmap:\n%s", script[:600])
	}
}

// A última porta do equipamento muda quantos blocos cabem por IP; sem ela, o cálculo desloca todo o mapeamento.
func TestCGNATUltimaPorta(t *testing.T) {
	fields := map[string]any{"public_cidr": "198.51.100.0/30", "private_cidr": "100.64.0.0/24", "ports_per_subscriber": float64(960), "port_start": float64(1024)}
	if per := CGNATCapacity(cgnatPlan(fields))["blocks_per_public"]; per != float64(67) {
		t.Fatalf("até 65535: %v", per)
	}
	fields["port_end"] = float64(64511)
	plan := cgnatPlan(fields)
	if per := CGNATCapacity(plan)["blocks_per_public"]; per != float64(66) {
		t.Fatalf("até 64511: %v", per)
	}
	if f := CGNATForward(plan, "100.64.0.66"); f["public_ip"] != "198.51.100.1" || f["port_start"] != float64(1024) {
		t.Fatalf("primeiro assinante do segundo IP: %v", f)
	}
	if r := CGNATReverse(plan, "198.51.100.0", 64511); r != nil {
		t.Fatalf("porta além do último bloco completo deveria ficar fora: %v", r)
	}
}

// CGNAT externo (Hillstone, A10): nenhum titular por cálculo.
func TestCGNATExternoNaoCalcula(t *testing.T) {
	plan := cgnatPlan(map[string]any{"layout": "external", "public_cidr": "198.51.100.0/30", "private_cidr": "100.64.0.0/24", "ports_per_subscriber": float64(1984), "port_start": float64(1024)})
	if CGNATTraceable(plan) || CGNATForward(plan, "100.64.0.1") != nil || CGNATReverse(plan, "198.51.100.1", 5000) != nil || CGNATSharers(plan, "198.51.100.1") != nil {
		t.Fatal("plano externo não pode indicar assinante")
	}
}
