package leitura

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"
	"text/template"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

//go:embed radius_commands.json
var radiusCommandData []byte

type commandPart struct {
	Condition string
	Lines     []string
}

var radiusTemplates = func() map[string]map[string][]commandPart {
	var data struct {
		Templates map[string]map[string][]commandPart
	}
	if err := json.Unmarshal(radiusCommandData, &data); err != nil {
		panic(err)
	}
	return data.Templates
}()

func renderRadiusCommands(vendor string, options map[string]any) (string, error) {
	tunnel, _ := options["tunnel"].(map[string]any)
	kind := "wireguard"
	if tunnel["kind"] == "l2tp" {
		kind = "l2tp"
	}
	variant := vendor
	if _, ok := radiusTemplates[kind][variant]; !ok {
		variant = "generic"
	}
	data := map[string]any{"o": options, "tn": tunnel, "l": tunnel["l2tp"], "vendor": vendor}
	lines := []string{}
	for _, part := range radiusTemplates[kind][variant] {
		if part.Condition == "tn" && len(tunnel) == 0 {
			continue
		}
		if part.Condition == "o.secondary" && options["secondary"] == nil {
			continue
		}
		for _, line := range part.Lines {
			t, err := template.New("radius").Option("missingkey=error").Parse(line)
			if err != nil {
				return "", err
			}
			var out bytes.Buffer
			if err = t.Execute(&out, data); err != nil {
				return "", err
			}
			lines = append(lines, out.String())
		}
	}
	return strings.Join(lines, "\n"), nil
}

func (s Service) radiusSetup(ctx context.Context, tx *db.Tx, _ *http.Request, v map[string]any) (endpoint.Result, error) {
	rows, err := complexRows(ctx, tx, "helper:nasOf", 0, v["id"])
	if err != nil {
		return endpoint.Result{}, err
	}
	if len(rows) == 0 {
		return endpoint.Result{}, apierr.New(404, "concentrador do RADIUS integrado não encontrado")
	}
	nas := rows[0]
	tunnel, err := RadiusTunnel(ctx, tx, v["id"])
	if err != nil {
		return endpoint.Result{}, err
	}
	setup, err := RadiusSetupData(fmt.Sprint(nas.Get("vendor")), nas.Get("coa_port"), "<SEGREDO>", tunnel)
	if err != nil {
		return endpoint.Result{}, err
	}
	nas.Set("setup", setup)
	return endpoint.Result{Value: nas}, nil
}
func RadiusTunnel(ctx context.Context, tx *db.Tx, id any) (map[string]any, error) {
	var tunnel map[string]any
	rows, err := complexRows(ctx, tx, "helper:tunnelOf", 0, id)
	if err != nil {
		return nil, err
	}
	if len(rows) > 0 {
		tunnel = map[string]any{"kind": "l2tp", "privateKey": "", "serverPublicKey": "", "endpointHost": vpnHost(), "endpointPort": 1701, "tunnelIp": rows[0].Get("ip"), "serverIp": "10.251.0.1", "l2tp": map[string]any{"username": rows[0].Get("username"), "password": "<SENHA DO TÚNEL>", "psk": "<CHAVE IPSEC DA INSTALAÇÃO>"}}
	} else {
		rows, err = complexRows(ctx, tx, "helper:tunnelOf", 1, id)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			key := rows[0].Get("srv")
			if key == nil {
				key = "<chave do servidor>"
			}
			tunnel = map[string]any{"privateKey": "<CHAVE PRIVADA DO TÚNEL>", "serverPublicKey": key, "endpointHost": vpnHost(), "endpointPort": jsCommandNumber(envNullishNumber("NEXO_VPN_PORT", 51820)), "tunnelIp": rows[0].Get("ip"), "serverIp": "10.250.0.1"}
		}
	}
	return tunnel, nil
}
func RadiusSetupData(vendor string, coaPort any, secret string, tunnel map[string]any) (map[string]any, error) {
	host := radiusHost()
	port := envNullishNumber("NEXO_RADIUS_PORT", 1812)
	connection := "direct"
	var publicTunnel any
	if tunnel != nil {
		host = tunnel["serverIp"].(string)
		port = 1812
		connection = "vpn"
		kind := "wireguard"
		ep := fmt.Sprint(tunnel["endpointHost"]) + ":" + fmt.Sprint(tunnel["endpointPort"])
		if tunnel["kind"] == "l2tp" {
			kind = "l2tp"
			connection = "l2tp"
			ep = fmt.Sprint(tunnel["endpointHost"])
		}
		publicTunnel = map[string]any{"kind": kind, "tunnel_ip": tunnel["tunnelIp"], "endpoint": ep}
	}
	secondaryHost := os.Getenv("NEXO_RADIUS_SECONDARY_HOST")
	if secondaryHost == "" && tunnel != nil {
		secondaryHost = host
	}
	secondaryPort := envNullishNumber("NEXO_RADIUS_SECONDARY_PORT", 0)
	var secondary any
	var commandSecondary any
	if secondaryHost != "" && secondaryPort != 0 && !math.IsNaN(secondaryPort) {
		secondary = map[string]any{"host": secondaryHost, "authPort": wireNumber(secondaryPort), "acctPort": wireNumber(secondaryPort + 1)}
		commandSecondary = map[string]any{"host": secondaryHost, "authPort": jsCommandNumber(secondaryPort), "acctPort": jsCommandNumber(secondaryPort + 1)}
	}
	commands, err := renderRadiusCommands(vendor, map[string]any{"host": host, "authPort": jsCommandNumber(port), "acctPort": jsCommandNumber(port + 1), "coaPort": coaPort, "secret": secret, "tunnel": tunnel, "secondary": commandSecondary})
	if err != nil {
		return nil, err
	}
	configured := os.Getenv("NEXO_RADIUS_PUBLIC_HOST") != ""
	if tunnel != nil {
		configured = configured || os.Getenv("NEXO_VPN_PUBLIC_HOST") != ""
	}
	return map[string]any{"server_host": host, "auth_port": wireNumber(port), "acct_port": wireNumber(port + 1), "coa_port": coaPort, "vendor": vendor, "validated": vendor == "mikrotik", "connection": connection, "tunnel": publicTunnel, "host_configured": configured, "endpoint_host": vpnHost(), "secondary": secondary, "commands": commands}, nil
}

func jsCommandNumber(n float64) any {
	if math.IsNaN(n) {
		return "NaN"
	}
	if math.IsInf(n, 1) {
		return "Infinity"
	}
	if math.IsInf(n, -1) {
		return "-Infinity"
	}
	return jsText(n)
}

func RadiusEndpoint() (string, any) {
	return vpnHost(), jsCommandNumber(envNullishNumber("NEXO_VPN_PORT", 51820))
}
