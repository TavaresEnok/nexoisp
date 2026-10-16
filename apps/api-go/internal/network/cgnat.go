package network

import (
	"fmt"
	"math"
	"math/big"
	"net/netip"
	"nexoisp/api-go/internal/jsonx"
	"regexp"
	"strconv"
	"strings"
)

var ipv4RE = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)

func IPv4Number(ip string) (uint64, bool) {
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
func IPv4String(ip uint64) string {
	return fmt.Sprintf("%d.%d.%d.%d", (ip>>24)&255, (ip>>16)&255, (ip>>8)&255, ip&255)
}
func CIDR4(cidr any) (uint64, uint64) {
	parts := strings.Split(fmt.Sprint(cidr), "/")
	if len(parts) != 2 {
		panic("CIDR inválido no banco")
	}
	base, valid := IPv4Number(parts[0])
	mask, err := strconv.Atoi(parts[1])
	if !valid || err != nil || mask < 0 || mask > 32 {
		panic("CIDR IPv4 inválido no banco")
	}
	return base, uint64(1) << uint(32-mask)
}
func CGNATCapacity(plan jsonx.Object) map[string]any {
	_, public := CIDR4(plan.Get("public_cidr"))
	_, private := CIDR4(plan.Get("private_cidr"))
	per := math.Floor((65536 - number(plan.Get("port_start"))) / number(plan.Get("ports_per_subscriber")))
	max := float64(public) * per
	return map[string]any{"public_ips": public, "private_ips": private, "blocks_per_public": per, "max_private_ips": max, "fits": float64(private) <= max, "ratio": math.Min(per, math.Ceil(float64(private)/float64(public)))}
}
func CGNATForward(plan jsonx.Object, ip string) map[string]any {
	base, size := CIDR4(plan.Get("private_cidr"))
	pubBase, pubSize := CIDR4(plan.Get("public_cidr"))
	address, valid := IPv4Number(ip)
	if !valid || address < base || address-base >= size {
		return nil
	}
	ports, start := number(plan.Get("ports_per_subscriber")), number(plan.Get("port_start"))
	per := math.Floor((65536 - start) / ports)
	if per <= 0 {
		return nil
	}
	index := address - base
	publicIndex := uint64(math.Floor(float64(index) / per))
	if publicIndex >= pubSize {
		return nil
	}
	first := start + math.Mod(float64(index), per)*ports
	return map[string]any{"private_ip": ip, "public_ip": IPv4String(pubBase + publicIndex), "port_start": first, "port_end": first + ports - 1}
}
func CGNATReverse(plan jsonx.Object, ip string, port float64) map[string]any {
	publicBase, publicSize := CIDR4(plan.Get("public_cidr"))
	privateBase, privateSize := CIDR4(plan.Get("private_cidr"))
	address, valid := IPv4Number(ip)
	if !valid || address < publicBase || address-publicBase >= publicSize || port < number(plan.Get("port_start")) {
		return nil
	}
	per := math.Floor((65536 - number(plan.Get("port_start"))) / number(plan.Get("ports_per_subscriber")))
	block := math.Floor((port - number(plan.Get("port_start"))) / number(plan.Get("ports_per_subscriber")))
	index := float64(address-publicBase)*per + block
	if block >= per || index >= float64(privateSize) {
		return nil
	}
	return CGNATForward(plan, IPv4String(privateBase+uint64(index)))
}
func CGNATScript(plan jsonx.Object) string {
	id := plan.Get("id").(string)
	tag, chain := "nexo-cgnat:"+id[:8], "nexo-cgnat-"+id[:8]
	capacity := CGNATCapacity(plan)
	out := []string{fmt.Sprintf("# NexoISP — CGNAT determinístico \"%v\"", plan.Get("name")), fmt.Sprintf("# privado %v -> público %v · %v portas por assinante a partir da %v · até %v assinante(s) por IP público", plan.Get("private_cidr"), plan.Get("public_cidr"), plan.Get("ports_per_subscriber"), plan.Get("port_start"), capacity["ratio"]), "# GERADO PARA REVISÃO: o NexoISP não aplica este script. Confira em laboratório, ajuste a interface de saída e", "# importe em janela de manutenção. Para remover: /ip firewall nat remove [find comment~\"" + tag + "\"]", "/ip firewall nat", fmt.Sprintf("add chain=srcnat src-address=%v action=jump jump-target=%s comment=\"%s\"", plan.Get("private_cidr"), chain, tag)}
	current, first, last := "", "", ""
	other := func() {
		if current != "" {
			source := first
			if first != last {
				source = first + "-" + last
			}
			out = append(out, fmt.Sprintf("add chain=%s src-address=%s action=src-nat to-addresses=%s comment=\"%s\"", chain, source, current, tag))
		}
	}
	base, size := CIDR4(plan.Get("private_cidr"))
	for i := uint64(0); i < size; i++ {
		block := CGNATForward(plan, IPv4String(base+i))
		if block == nil {
			continue
		}
		if block["public_ip"] != current {
			other()
			current = block["public_ip"].(string)
			first = block["private_ip"].(string)
		}
		last = block["private_ip"].(string)
		for _, proto := range []string{"tcp", "udp"} {
			out = append(out, fmt.Sprintf("add chain=%s src-address=%v protocol=%s action=src-nat to-addresses=%v to-ports=%v-%v comment=\"%s\"", chain, block["private_ip"], proto, block["public_ip"], block["port_start"], block["port_end"], tag))
		}
	}
	other()
	return strings.Join(out, "\n") + "\n"
}
func IPv6Subnet(pool string, length int, index int) (string, error) {
	prefix, err := netip.ParsePrefix(pool)
	if err != nil || !prefix.Addr().Is6() || prefix.Bits() > length || length > 128 {
		return "", fmt.Errorf("bloco IPv6 inválido: %s", pool)
	}
	raw := prefix.Addr().As16()
	base := new(big.Int).SetBytes(raw[:])
	offset := new(big.Int).Lsh(big.NewInt(int64(index)), uint(128-length))
	base.Add(base, offset)
	data := base.FillBytes(make([]byte, 16))
	var address [16]byte
	copy(address[:], data)
	return fmt.Sprintf("%s/%d", netip.AddrFrom16(address).String(), length), nil
}
