package network

import (
	"regexp"
	"strconv"
	"strings"
)

// NasPort é a leitura do NAS-Port-Id de uma sessão: interface, VLAN de serviço (externa) e VLAN do cliente (interna, QinQ).
// É uma interpretação do texto enviado pelo concentrador; o valor original sempre acompanha o resultado.
type NasPort struct {
	Raw       string `json:"raw"`
	Interface string `json:"interface,omitempty"`
	VLAN      int    `json:"vlan,omitempty"`
	InnerVLAN int    `json:"inner_vlan,omitempty"`
}

var (
	// Huawei (formato version10 e afins): "slot=2;subslot=0;port=1;vlanid=100;vlanid2=2001;"
	nasKeyVLAN  = regexp.MustCompile(`(?i)(?:^|[;\s])vlanid=(\d{1,4})`)
	nasKeyVLAN2 = regexp.MustCompile(`(?i)(?:^|[;\s])vlanid2=(\d{1,4})`)
	nasKeyPort  = regexp.MustCompile(`(?i)slot=(\d+);\s*subslot=(\d+);\s*port=(\d+)`)
	// Huawei redback-simple e semelhantes: "GigabitEthernet0/1/0.100:100-2001", "Eth-Trunk1.300:300" ou "0/1/0:100-2001".
	nasRedback = regexp.MustCompile(`^(\S+?)(?:\.\d+)?:(\d{1,4})(?:[-.#](\d{1,4}))?(?:\s.*)?$`)
	// Subinterface: "ether1.100", "sfp-sfpplus1.300.20".
	nasDotted = regexp.MustCompile(`^([A-Za-z][\w/-]*?)\.(\d{1,4})(?:\.(\d{1,4}))?$`)
	// MikroTik: o NAS-Port-Id é o nome da interface do servidor PPPoE, geralmente com a VLAN no nome ("vlan100", "VLAN-300-PPPoE").
	nasNamed = regexp.MustCompile(`(?i)vlan[\s_-]?(\d{1,4})\b`)
)

func vlanOf(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > 4094 {
		return 0
	}
	return n
}

// ParseNasPort interpreta os formatos de NAS-Port-Id vistos nos concentradores Huawei e MikroTik do estudo de campo.
func ParseNasPort(raw string) NasPort {
	raw = strings.TrimSpace(raw)
	out := NasPort{Raw: raw}
	if raw == "" {
		return out
	}
	if m := nasKeyVLAN.FindStringSubmatch(raw); m != nil {
		out.VLAN = vlanOf(m[1])
		if m2 := nasKeyVLAN2.FindStringSubmatch(raw); m2 != nil {
			out.InnerVLAN = vlanOf(m2[1])
		}
		if p := nasKeyPort.FindStringSubmatch(raw); p != nil {
			out.Interface = p[1] + "/" + p[2] + "/" + p[3]
		}
		return out
	}
	if m := nasRedback.FindStringSubmatch(raw); m != nil {
		out.Interface, out.VLAN = m[1], vlanOf(m[2])
		if m[3] != "" {
			out.InnerVLAN = vlanOf(m[3])
		}
		return out
	}
	if m := nasDotted.FindStringSubmatch(raw); m != nil {
		out.Interface, out.VLAN = m[1], vlanOf(m[2])
		if m[3] != "" {
			out.InnerVLAN = vlanOf(m[3])
		}
		return out
	}
	out.Interface = raw
	if m := nasNamed.FindStringSubmatch(raw); m != nil {
		out.VLAN = vlanOf(m[1])
	}
	return out
}
