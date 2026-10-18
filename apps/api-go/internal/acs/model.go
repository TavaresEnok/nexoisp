package acs

import (
	"fmt"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func At(value any, path string) any {
	for _, key := range strings.Split(path, ".") {
		obj, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = obj[key]
	}
	return value
}
func val(value any, path string) any { return At(value, path+"._value") }
func numericKeys(value any) []string {
	out := []string{}
	if obj, ok := value.(map[string]any); ok {
		for key := range obj {
			if regexp.MustCompile(`^\d+$`).MatchString(key) {
				out = append(out, key)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, _ := strconv.ParseFloat(out[i], 64)
		b, _ := strconv.ParseFloat(out[j], 64)
		return a < b
	})
	return out
}
func Model(d map[string]any) string {
	if jsonx.Truthy(d["Device"]) && !jsonx.Truthy(d["InternetGatewayDevice"]) {
		return "tr181"
	}
	return "tr098"
}
func PPPUsers(d map[string]any) []string {
	out := []string{}
	igd := At(d, "InternetGatewayDevice.WANDevice")
	for _, w := range numericKeys(igd) {
		for _, c := range numericKeys(At(igd, w+".WANConnectionDevice")) {
			for _, p := range numericKeys(At(igd, w+".WANConnectionDevice."+c+".WANPPPConnection")) {
				u := val(igd, w+".WANConnectionDevice."+c+".WANPPPConnection."+p+".Username")
				if jsonx.Truthy(u) {
					out = append(out, jsonx.String(u))
				}
			}
		}
	}
	ppp := At(d, "Device.PPP.Interface")
	for _, i := range numericKeys(ppp) {
		if u := val(ppp, i+".Username"); jsonx.Truthy(u) {
			out = append(out, jsonx.String(u))
		}
	}
	return out
}
func Summary(d map[string]any) map[string]any {
	model := Model(d)
	info := At(d, "InternetGatewayDevice.DeviceInfo")
	if model == "tr181" {
		info = At(d, "Device.DeviceInfo")
	}
	wifi := []map[string]any{}
	w := At(d, "InternetGatewayDevice.LANDevice.1.WLANConfiguration")
	if model == "tr181" {
		w = At(d, "Device.WiFi.SSID")
	}
	for _, i := range numericKeys(w) {
		wifi = append(wifi, map[string]any{"index": i, "ssid": val(w, i+".SSID"), "enabled": val(w, i+".Enable")})
	}
	wan := map[string]any{"ip": nil, "status": nil}
	if model == "tr098" {
		igd := At(d, "InternetGatewayDevice.WANDevice")
		for _, w := range numericKeys(igd) {
			for _, c := range numericKeys(At(igd, w+".WANConnectionDevice")) {
				for _, kind := range []string{"WANPPPConnection", "WANIPConnection"} {
					for _, p := range numericKeys(At(igd, w+".WANConnectionDevice."+c+"."+kind)) {
						base := w + ".WANConnectionDevice." + c + "." + kind + "." + p
						if !jsonx.Truthy(wan["ip"]) && jsonx.Truthy(val(igd, base+".ExternalIPAddress")) {
							wan["ip"], wan["status"] = val(igd, base+".ExternalIPAddress"), val(igd, base+".ConnectionStatus")
						}
					}
				}
			}
		}
	} else {
		ip := At(d, "Device.IP.Interface")
		for _, i := range numericKeys(ip) {
			for _, a := range numericKeys(At(ip, i+".IPv4Address")) {
				if !jsonx.Truthy(wan["ip"]) && jsonx.Truthy(val(ip, i+".IPv4Address."+a+".IPAddress")) {
					wan["ip"], wan["status"] = val(ip, i+".IPv4Address."+a+".IPAddress"), val(ip, i+".Status")
				}
			}
		}
	}
	manufacturer := At(d, "_deviceId._Manufacturer")
	if manufacturer == nil {
		manufacturer = val(info, "Manufacturer")
	}
	serial := At(d, "_deviceId._SerialNumber")
	if serial == nil {
		serial = val(info, "SerialNumber")
	}
	product := val(info, "ModelName")
	if product == nil {
		product = At(d, "_deviceId._ProductClass")
	}
	out := map[string]any{"id": d["_id"], "model": model, "manufacturer": manufacturer, "serial": serial, "firmware": val(info, "SoftwareVersion"), "hardware": val(info, "HardwareVersion"), "uptime_s": nil, "last_inform": d["_lastInform"], "wan": wan, "wifi": wifi, "ppp_usernames": PPPUsers(d)}
	if product != nil {
		out["product"] = product
	}
	uptime := validate.JSNumber(fmt.Sprint(val(info, "UpTime")))
	if jsonx.Truthy(uptime) {
		out["uptime_s"] = uptime
	}
	return out
}
func WiFiParams(d map[string]any, index string, ssid, password any) ([][3]string, error) {
	out := [][3]string{}
	if Model(d) == "tr098" {
		base := "InternetGatewayDevice.LANDevice.1.WLANConfiguration." + index
		w := At(d, base)
		if w == nil {
			return nil, apierr.New(400, "rede Wi-Fi não encontrada neste roteador")
		}
		if ssid != nil {
			out = append(out, [3]string{base + ".SSID", ssid.(string), "xsd:string"})
		}
		if password != nil {
			path := base + ".PreSharedKey.1.PreSharedKey"
			if At(w, "KeyPassphrase") != nil {
				path = base + ".KeyPassphrase"
			} else if At(w, "PreSharedKey.1.KeyPassphrase") != nil {
				path = base + ".PreSharedKey.1.KeyPassphrase"
			}
			out = append(out, [3]string{path, password.(string), "xsd:string"})
		}
	} else {
		if At(d, "Device.WiFi.SSID."+index) == nil {
			return nil, apierr.New(400, "rede Wi-Fi não encontrada neste roteador")
		}
		if ssid != nil {
			out = append(out, [3]string{"Device.WiFi.SSID." + index + ".SSID", ssid.(string), "xsd:string"})
		}
		if password != nil {
			out = append(out, [3]string{"Device.WiFi.AccessPoint." + index + ".Security.KeyPassphrase", password.(string), "xsd:string"})
		}
	}
	return out, nil
}
