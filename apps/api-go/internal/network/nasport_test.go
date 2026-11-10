package network

import "testing"

func TestParseNasPort(t *testing.T) {
	cases := []struct {
		raw         string
		iface       string
		vlan, inner int
	}{
		{"slot=2;subslot=0;port=1;vlanid=100;vlanid2=2001;", "2/0/1", 100, 2001},
		{"slot=0;subslot=1;port=3;vlanid=300;", "0/1/3", 300, 0},
		{"GigabitEthernet0/1/0.100:100-2001", "GigabitEthernet0/1/0", 100, 2001},
		{"Eth-Trunk1.300:300", "Eth-Trunk1", 300, 0},
		{"0/1/0:120-45 0/0/0/0/0/0", "0/1/0", 120, 45},
		{"ether1.100", "ether1", 100, 0},
		{"sfp-sfpplus1.300.20", "sfp-sfpplus1", 300, 20},
		{"vlan100", "vlan100", 100, 0},
		{"VLAN-350-PPPoE", "VLAN-350-PPPoE", 350, 0},
		{"pppoe-clientes", "pppoe-clientes", 0, 0},
		{"15728640", "15728640", 0, 0},
		{"ether1.5000", "ether1", 0, 0},
		{"", "", 0, 0},
	}
	for _, c := range cases {
		got := ParseNasPort(c.raw)
		if got.Interface != c.iface || got.VLAN != c.vlan || got.InnerVLAN != c.inner || got.Raw != c.raw {
			t.Errorf("%q: %+v", c.raw, got)
		}
	}
}
