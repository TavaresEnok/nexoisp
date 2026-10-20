package radius

import (
	"testing"

	"nexoisp/api-go/internal/jsonx"
)

func replyValue(reply []Attribute, name string) (string, bool) {
	for _, attribute := range reply {
		if attribute.Attribute == name {
			return attribute.Value, true
		}
	}
	return "", false
}

func TestDelegatedIPv6Prefix(t *testing.T) {
	active := jsonx.Object{{Name: "profile", Value: "plano200"}, {Name: "policy", Value: "active"}, {Name: "delegated_ipv6_prefix", Value: "2001:db8:10::/56"}}
	for _, vendor := range []string{"mikrotik", "huawei", "cisco", "generic"} {
		_, reply, _, _ := attributes(vendor, active, 200000, 100000)
		if value, ok := replyValue(reply, "Delegated-IPv6-Prefix"); !ok || value != "2001:db8:10::/56" {
			t.Fatalf("%s: prefixo delegado ausente na resposta: %+v", vendor, reply)
		}
	}
	blocked := jsonx.Object{{Name: "profile", Value: "plano200"}, {Name: "policy", Value: "suspended"},
		{Name: "suspension", Value: jsonx.Object{{Name: "mode", Value: "profile"}, {Name: "profile", Value: "bloqueio"}}},
		{Name: "delegated_ipv6_prefix", Value: "2001:db8:10::/56"}}
	_, reply, _, isBlocked := attributes("mikrotik", blocked, 200000, 100000)
	if !isBlocked {
		t.Fatal("perfil de suspensão deveria bloquear")
	}
	if _, ok := replyValue(reply, "Delegated-IPv6-Prefix"); ok {
		t.Fatalf("assinante em perfil de bloqueio não recebe prefixo IPv6: %+v", reply)
	}
	plain := jsonx.Object{{Name: "profile", Value: "plano200"}, {Name: "policy", Value: "active"}}
	if _, reply, _, _ := attributes("mikrotik", plain, 200000, 100000); len(reply) == 0 {
		t.Fatal("resposta vazia")
	} else if _, ok := replyValue(reply, "Delegated-IPv6-Prefix"); ok {
		t.Fatal("sem delegação no IPAM não há prefixo na resposta")
	}
}
