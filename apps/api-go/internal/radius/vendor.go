package radius

import (
	"fmt"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"os"
)

type Attribute struct{ Attribute, Op, Value string }

func number(v any) float64 {
	if v == nil {
		return 0
	}
	return validate.JSNumber(fmt.Sprint(v))
}
func object(v any) jsonx.Object { r, _ := v.(jsonx.Object); return r }
func leaseSeconds() float64 {
	n := validate.JSNumber(os.Getenv("NEXO_IPOE_LEASE_SECONDS"))
	if n == 0 || os.Getenv("NEXO_IPOE_LEASE_SECONDS") == "" {
		n = 600
	}
	return min(86400, max(60, n))
}
func attributes(vendor string, p jsonx.Object, down, up any) ([]Attribute, []Attribute, string, bool) {
	suspension := object(p.Get("suspension"))
	blocked := p.Get("policy") == "suspended" && suspension.Get("mode") == "profile" && jsonx.Truthy(suspension.Get("profile"))
	profile := fmt.Sprint(p.Get("profile"))
	if blocked {
		profile = fmt.Sprint(suspension.Get("profile"))
	}
	checks, reply := []Attribute{}, []Attribute{}
	check := func(name, op string, value any) { checks = append(checks, Attribute{name, op, jsonx.String(value)}) }
	set := func(name string, value any) { reply = append(reply, Attribute{name, ":=", jsonx.String(value)}) }
	plus := func(value string) { reply = append(reply, Attribute{"Cisco-AVPair", "+=", value}) }
	if p.Get("policy") == "suspended" && !blocked {
		check("Auth-Type", ":=", "Reject")
	} else if p.Get("access_type") == "ipoe" {
		check("Auth-Type", ":=", "Accept")
	}
	if jsonx.Truthy(p.Get("mac")) && p.Get("access_type") != "ipoe" {
		check("Calling-Station-Id", "==", p.Get("mac"))
	}
	if jsonx.Truthy(p.Get("simultaneous_use")) {
		check("Simultaneous-Use", ":=", p.Get("simultaneous_use"))
	}
	switch vendor {
	case "mikrotik":
		if p.Get("access_type") == "ipoe" || p.Get("access_type") == "hotspot" {
			set("Mikrotik-Address-List", profile)
			if p.Get("access_type") == "ipoe" {
				set("Session-Timeout", leaseSeconds())
			}
		} else {
			set("Mikrotik-Group", profile)
		}
		if !blocked && jsonx.Truthy(p.Get("rate_limit")) {
			set("Mikrotik-Rate-Limit", p.Get("rate_limit"))
		}
	case "huawei":
		if blocked {
			set("Huawei-Qos-Profile-Name", profile)
		} else {
			set("Huawei-Input-Average-Rate", number(up)*1000)
			set("Huawei-Output-Average-Rate", number(down)*1000)
		}
	case "cisco":
		plus("ip:sub-qos-policy-in=" + profile)
		plus("ip:sub-qos-policy-out=" + profile)
	default:
		set("Filter-Id", profile)
	}
	if !blocked && jsonx.Truthy(p.Get("address_pool")) {
		if vendor == "cisco" {
			plus("ip:addr-pool=" + fmt.Sprint(p.Get("address_pool")))
		} else {
			set("Framed-Pool", p.Get("address_pool"))
		}
	}
	if jsonx.Truthy(p.Get("framed_ip")) {
		set("Framed-IP-Address", p.Get("framed_ip"))
	}
	if jsonx.Truthy(p.Get("acct_interim")) {
		set("Acct-Interim-Interval", p.Get("acct_interim"))
	}
	return checks, reply, profile, blocked
}
