package acs

import (
	"fmt"
	"strings"
	"testing"
)

func TestTemplatePatternMatching(t *testing.T) {
	device := map[string]any{"_id": "x", "_deviceId": map[string]any{"_Manufacturer": "Huawei Technologies", "_ProductClass": "HG8245"}, "InternetGatewayDevice": map[string]any{"DeviceInfo": map[string]any{"ModelName": map[string]any{"_value": "HG8245H5"}, "SoftwareVersion": map[string]any{"_value": "V3R017C10S115"}}}}
	for _, c := range []struct {
		m, model, fw string
		want         bool
	}{
		{"*", "*", "*", true},
		{"huawei*", "HG8245", "*", true}, // ProductClass, sem diferenciar maiúsculas
		{"Huawei*", "HG8245H?", "V3R017*", true},
		{"ZTE*", "*", "*", false},
		{"*", "F670*", "*", false},
		{"*", "*", "V5*", false},
		{"Huawei.Technologies", "*", "*", false}, // ponto é literal, não expressão regular
	} {
		if got := TemplateMatches(c.m, c.model, c.fw, device); got != c.want {
			t.Fatalf("%v: got %v", c, got)
		}
	}
	if PatternSpecificity("Huawei*", "HG8245", "*") <= PatternSpecificity("*", "*", "*") {
		t.Fatal("padrão literal deve ser mais específico")
	}
	if DeviceRoot(device) != "InternetGatewayDevice" || DeviceRoot(map[string]any{"Device": map[string]any{"x": 1}}) != "Device" {
		t.Fatal("raiz do modelo de dados")
	}
}

func TestTemplateValidation(t *testing.T) {
	ok := []TemplateParam{
		{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", Value: "{{wifi_ssid}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase", Value: "{{wifi_senha}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable", Value: "1", Type: "xsd:boolean"},
		{Path: "InternetGatewayDevice.DeviceInfo.ProvisioningCode", Value: "NX-{{contrato_codigo}}", Type: "xsd:string"},
	}
	clean, err := ValidateTemplateParams(ok)
	if err != nil {
		t.Fatal(err)
	}
	if clean[2].Value != "true" {
		t.Fatal("booleano não normalizado", clean[2].Value)
	}
	bad := map[string]TemplateParam{
		"variável desconhecida": {Path: "Device.X.Name", Value: "{{senha_admin}}", Type: "xsd:string"},
		"malformada":            {Path: "Device.X.Name", Value: "{{wifi_ssid", Type: "xsd:string"},
		"curinga":               {Path: "Device.WiFi.SSID.*.SSID", Value: "x", Type: "xsd:string"},
		"instância":             {Path: "Device.WiFi.SSID.1", Value: "x", Type: "xsd:string"},
		"management":            {Path: "Device.ManagementServer.URL", Value: "http://x", Type: "xsd:string"},
		"senha fixa":            {Path: "Device.WiFi.AccessPoint.1.Security.KeyPassphrase", Value: "segredo123", Type: "xsd:string"},
		"senha concatenada":     {Path: "Device.WiFi.AccessPoint.1.Security.KeyPassphrase", Value: "x{{wifi_senha}}", Type: "xsd:string"},
		"variável em booleano":  {Path: "Device.X.Enable", Value: "{{wifi_ssid}}", Type: "xsd:boolean"},
		"booleano inválido":     {Path: "Device.X.Enable", Value: "talvez", Type: "xsd:boolean"},
		"inteiro inválido":      {Path: "Device.X.Count", Value: "-1", Type: "xsd:unsignedInt"},
		"tipo":                  {Path: "Device.X.Name", Value: "x", Type: "xsd:base64"},
		"controle":              {Path: "Device.X.Name", Value: "a\nb", Type: "xsd:string"},
	}
	for name, p := range bad {
		if _, err := ValidateTemplateParams([]TemplateParam{p}); err == nil {
			t.Fatal("aceitou", name)
		}
	}
	if _, err := ValidateTemplateParams([]TemplateParam{ok[0], {Path: "Device.WiFi.SSID.1.SSID", Value: "x", Type: "xsd:string"}}); err == nil {
		t.Fatal("aceitou modelos de dados misturados")
	}
	if _, err := ValidateTemplateParams([]TemplateParam{ok[0], ok[0]}); err == nil {
		t.Fatal("aceitou caminho repetido")
	}
}

func TestTemplateResolutionMasksSecrets(t *testing.T) {
	params, err := ValidateTemplateParams([]TemplateParam{
		{Path: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username", Value: "{{pppoe_usuario}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password", Value: "{{pppoe_senha}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", Value: "{{wifi_ssid}}", Type: "xsd:string"},
		{Path: "InternetGatewayDevice.X_Limit", Value: "42", Type: "xsd:unsignedInt"},
	})
	if err != nil {
		t.Fatal(err)
	}
	inform := 600
	resolved, missing, err := ResolveTemplate(params, &inform, "InternetGatewayDevice", map[string]string{"pppoe_usuario": "cliente1", "pppoe_senha": "segredo-pppoe"})
	if err != nil {
		t.Fatal(err)
	}
	if len(missing) != 1 || missing[0] != "wifi_ssid" {
		t.Fatal("ausentes", missing)
	}
	masked := MaskedTemplate(resolved)
	text := ""
	for _, item := range masked {
		text += fmt.Sprint(item["path"], "=", item["value"], ";")
	}
	if strings.Contains(text, "segredo-pppoe") || !strings.Contains(text, MaskedValue) || !strings.Contains(text, "cliente1") {
		t.Fatal(text)
	}
	if len(resolved) != 6 || resolved[5].Path != "InternetGatewayDevice.ManagementServer.PeriodicInformInterval" || resolved[5].Value != float64(600) || resolved[3].Value != float64(42) {
		t.Fatal("inform/tipos", resolved)
	}
	payload := TemplatePayload(resolved)
	values := payload["parameterValues"].([]any)
	if values[1].([]any)[1] != "segredo-pppoe" || payload["name"] != "setParameterValues" {
		t.Fatal("envelope deve conter o valor real para o ACS", values[1])
	}
}
