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

func checkValue(checks []Attribute, name string) (string, bool) { return replyValue(checks, name) }

// Modalidades do mercado (docs/estudo-campo): lista de endereços no MikroTik e pool de bloqueio.
func TestSuspensaoPorListaEPool(t *testing.T) {
	susp := func(mode, key, value string) jsonx.Object {
		return jsonx.Object{{Name: "profile", Value: "plano200"}, {Name: "policy", Value: "suspended"}, {Name: "rate_limit", Value: "100M/200M"},
			{Name: "address_pool", Value: "clientes"}, {Name: "framed_ip", Value: "100.64.0.10"},
			{Name: "suspension", Value: jsonx.Object{{Name: "mode", Value: mode}, {Name: key, Value: value}}}}
	}
	checks, reply, _, _ := attributes("mikrotik", susp("address_list", "list", "bloqueados"), 200000, 100000)
	if _, rejected := checkValue(checks, "Auth-Type"); rejected {
		t.Fatal("suspensão por lista não rejeita a autenticação")
	}
	if v, _ := replyValue(reply, "Mikrotik-Address-List"); v != "bloqueados" {
		t.Fatalf("lista ausente: %+v", reply)
	}
	if v, _ := replyValue(reply, "Mikrotik-Group"); v != "plano200" {
		t.Fatalf("perfil do plano mantido: %+v", reply)
	}
	// lista de endereços não existe fora do MikroTik: cai para a rejeição
	if checks, _, _, _ := attributes("huawei", susp("address_list", "list", "bloqueados"), 200000, 100000); len(checks) == 0 {
		t.Fatal("huawei com lista deveria rejeitar")
	} else if v, _ := checkValue(checks, "Auth-Type"); v != "Reject" {
		t.Fatalf("huawei com lista: %+v", checks)
	}
	for _, vendor := range []string{"huawei", "mikrotik", "generic"} {
		checks, reply, _, _ := attributes(vendor, susp("pool", "pool", "bloqueio"), 200000, 100000)
		if _, rejected := checkValue(checks, "Auth-Type"); rejected {
			t.Fatalf("%s: suspensão por pool não rejeita", vendor)
		}
		if v, _ := replyValue(reply, "Framed-Pool"); v != "bloqueio" {
			t.Fatalf("%s: pool de bloqueio ausente: %+v", vendor, reply)
		}
		if _, fixed := replyValue(reply, "Framed-IP-Address"); fixed {
			t.Fatalf("%s: IP fixo impediria o pool de bloqueio: %+v", vendor, reply)
		}
	}
}

// Concentrador Huawei com qos-profile por plano: manda o nome do perfil, não a taxa.
func TestHuaweiQosProfilePorPlano(t *testing.T) {
	p := jsonx.Object{{Name: "profile", Value: "PLANO-300M"}, {Name: "policy", Value: "active"}, {Name: "rate_mode", Value: "qos_profile"}}
	_, reply, _, _ := attributes("huawei", p, 300000, 150000)
	if v, ok := replyValue(reply, "Huawei-Qos-Profile-Name"); !ok || v != "PLANO-300M" {
		t.Fatalf("perfil de QoS ausente: %+v", reply)
	}
	if _, ok := replyValue(reply, "Huawei-Input-Average-Rate"); ok {
		t.Fatalf("taxa não deveria ir junto do perfil: %+v", reply)
	}
	plain := jsonx.Object{{Name: "profile", Value: "PLANO-300M"}, {Name: "policy", Value: "active"}}
	_, reply, _, _ = attributes("huawei", plain, 300000, 150000)
	if v, _ := replyValue(reply, "Huawei-Output-Average-Rate"); v != "300000000" {
		t.Fatalf("modo padrão continua por taxa: %+v", reply)
	}
	if _, ok := replyValue(reply, "Huawei-Qos-Profile-Name"); ok {
		t.Fatalf("modo padrão não manda perfil: %+v", reply)
	}
}
