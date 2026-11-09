package acs

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
)

// TemplateParam is one TR-069 parameter of a provisioning template. Value may
// contain the documented variables; it never holds a literal password.
type TemplateParam struct {
	Path  string `json:"path"`
	Value string `json:"value"`
	Type  string `json:"type"`
}

// Variables accepted in template values. Secret ones must be the whole value
// and are always masked outside the encrypted ACS envelope.
var TemplateVariables = []string{"pppoe_usuario", "pppoe_senha", "wifi_ssid", "wifi_senha", "contrato_codigo", "assinante_nome"}

const MaskedValue = "••••••••"

var (
	templatePath   = regexp.MustCompile(`^(InternetGatewayDevice|Device)(\.[A-Za-z0-9_-]+)+$`)
	templateLeaf   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
	templateToken  = regexp.MustCompile(`\{\{([^{}]*)\}\}`)
	sensitiveLeaf  = regexp.MustCompile(`(?i)(password|passphrase|presharedkey|wepkey|secret)`)
	templateTypes  = map[string]bool{"xsd:string": true, "xsd:boolean": true, "xsd:int": true, "xsd:unsignedInt": true, "xsd:dateTime": true}
	secretVariable = map[string]bool{"pppoe_senha": true, "wifi_senha": true}
)

func templateBad(format string, args ...any) error {
	return apierr.New(400, "template ACS: "+fmt.Sprintf(format, args...))
}

func knownVariable(name string) bool {
	for _, v := range TemplateVariables {
		if v == name {
			return true
		}
	}
	return false
}

// SensitivePath reports parameters whose value is a credential.
func SensitivePath(path string) bool {
	leaf := path[strings.LastIndex(path, ".")+1:]
	return sensitiveLeaf.MatchString(leaf)
}

// TemplateVariablesIn lists the variables used by a value, in order.
func TemplateVariablesIn(value string) []string {
	out := []string{}
	for _, m := range templateToken.FindAllStringSubmatch(value, -1) {
		out = append(out, m[1])
	}
	return out
}

// TemplateRoot returns the data model root shared by the parameters.
func TemplateRoot(params []TemplateParam) string {
	if len(params) == 0 {
		return ""
	}
	return strings.SplitN(params[0].Path, ".", 2)[0]
}

// ValidateTemplateParams enforces paths, types, variables and the credential
// policy. It returns the normalized list (boolean literals canonicalized).
func ValidateTemplateParams(params []TemplateParam) ([]TemplateParam, error) {
	if len(params) > 64 {
		return nil, templateBad("no máximo 64 parâmetros")
	}
	seen := map[string]bool{}
	root := ""
	out := make([]TemplateParam, 0, len(params))
	for i, p := range params {
		n := i + 1
		p.Path = strings.TrimSpace(p.Path)
		if len(p.Path) > 256 || !templatePath.MatchString(p.Path) {
			return nil, templateBad("parâmetro %d: caminho TR-069 inválido (use InternetGatewayDevice.… ou Device.…, sem curingas nem ponto final)", n)
		}
		segments := strings.Split(p.Path, ".")
		if !templateLeaf.MatchString(segments[len(segments)-1]) {
			return nil, templateBad("parâmetro %d: o caminho deve terminar no nome de um parâmetro, não em uma instância", n)
		}
		for _, segment := range segments {
			if strings.EqualFold(segment, "ManagementServer") {
				return nil, templateBad("parâmetro %d: parâmetros do ManagementServer são protegidos; use o intervalo de inform periódico", n)
			}
		}
		if root == "" {
			root = segments[0]
		} else if segments[0] != root {
			return nil, templateBad("todos os parâmetros devem usar o mesmo modelo de dados (%s)", root)
		}
		if seen[p.Path] {
			return nil, templateBad("parâmetro %d: caminho repetido", n)
		}
		seen[p.Path] = true
		if !templateTypes[p.Type] {
			return nil, templateBad("parâmetro %d: tipo deve ser xsd:string, xsd:boolean, xsd:int, xsd:unsignedInt ou xsd:dateTime", n)
		}
		if !utf8.ValidString(p.Value) || utf8.RuneCountInString(p.Value) > 256 || strings.IndexFunc(p.Value, unicode.IsControl) >= 0 {
			return nil, templateBad("parâmetro %d: valor de até 256 caracteres, sem caracteres de controle", n)
		}
		vars := TemplateVariablesIn(p.Value)
		for _, name := range vars {
			if !knownVariable(name) {
				return nil, templateBad("parâmetro %d: variável desconhecida {{%s}}", n, name)
			}
		}
		if strings.Contains(templateToken.ReplaceAllString(p.Value, ""), "{{") || strings.Contains(templateToken.ReplaceAllString(p.Value, ""), "}}") {
			return nil, templateBad("parâmetro %d: variável malformada; use {{nome}}", n)
		}
		secret := false
		for _, name := range vars {
			if secretVariable[name] {
				secret = true
			}
		}
		if secret && (len(vars) != 1 || p.Value != "{{"+vars[0]+"}}") {
			return nil, templateBad("parâmetro %d: {{pppoe_senha}} e {{wifi_senha}} devem ocupar o valor inteiro", n)
		}
		if SensitivePath(p.Path) && !secret {
			return nil, templateBad("parâmetro %d: senha fixa não é aceita; use {{pppoe_senha}} ou {{wifi_senha}}", n)
		}
		if len(vars) > 0 && p.Type != "xsd:string" {
			return nil, templateBad("parâmetro %d: variáveis só podem ser usadas em parâmetros xsd:string", n)
		}
		if p.Type != "xsd:string" {
			value, err := typedValue(p.Type, p.Value)
			if err != nil {
				return nil, templateBad("parâmetro %d: %s", n, err.Error())
			}
			if b, ok := value.(bool); ok {
				p.Value = strconv.FormatBool(b)
			}
		}
		out = append(out, p)
	}
	return out, nil
}

func typedValue(kind, raw string) (any, error) {
	switch kind {
	case "xsd:boolean":
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "true", "1":
			return true, nil
		case "false", "0":
			return false, nil
		}
		return nil, fmt.Errorf("valor booleano deve ser true ou false")
	case "xsd:int":
		n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 32)
		if err != nil {
			return nil, fmt.Errorf("valor inteiro inválido")
		}
		return float64(n), nil
	case "xsd:unsignedInt":
		n, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 32)
		if err != nil {
			return nil, fmt.Errorf("valor inteiro sem sinal inválido")
		}
		return float64(n), nil
	case "xsd:dateTime":
		if _, err := time.Parse(time.RFC3339, strings.TrimSpace(raw)); err != nil {
			return nil, fmt.Errorf("data e hora devem seguir RFC 3339")
		}
		return strings.TrimSpace(raw), nil
	}
	return raw, nil
}

// ValidPattern accepts manufacturer/model/firmware patterns with * and ?.
func ValidPattern(pattern string) bool {
	n := utf8.RuneCountInString(pattern)
	return utf8.ValidString(pattern) && n >= 1 && n <= 100 && pattern == strings.TrimSpace(pattern) && strings.IndexFunc(pattern, unicode.IsControl) < 0
}

// MatchPattern compares a value with a wildcard pattern, ignoring case.
func MatchPattern(pattern, value string) bool {
	var b strings.Builder
	b.WriteString("(?is)^")
	for _, r := range pattern {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String()).MatchString(value)
}

// PatternSpecificity counts literal characters: more literal, more specific.
func PatternSpecificity(patterns ...string) int {
	n := 0
	for _, p := range patterns {
		for _, r := range p {
			if r != '*' && r != '?' {
				n++
			}
		}
	}
	return n
}

// DeviceIdentity extracts the fields templates match against.
func DeviceIdentity(device map[string]any) (manufacturer string, models []string, firmware string) {
	summary := Summary(device)
	manufacturer = jsonx.String(summary["manufacturer"])
	if summary["manufacturer"] == nil {
		manufacturer = ""
	}
	for _, v := range []any{summary["product"], At(device, "_deviceId._ProductClass")} {
		if text, ok := v.(string); ok && text != "" {
			models = append(models, text)
		}
	}
	if len(models) == 0 {
		models = []string{""}
	}
	if text, ok := summary["firmware"].(string); ok {
		firmware = text
	}
	return
}

// TemplateMatches reports whether manufacturer, model and firmware patterns
// accept the device. The model pattern may match ModelName or ProductClass.
func TemplateMatches(manufacturerPattern, modelPattern, firmwarePattern string, device map[string]any) bool {
	manufacturer, models, firmware := DeviceIdentity(device)
	if !MatchPattern(manufacturerPattern, manufacturer) || !MatchPattern(firmwarePattern, firmware) {
		return false
	}
	for _, model := range models {
		if MatchPattern(modelPattern, model) {
			return true
		}
	}
	return false
}

// DeviceRoot maps the device data model to its parameter root.
func DeviceRoot(device map[string]any) string {
	if Model(device) == "tr181" {
		return "Device"
	}
	return "InternetGatewayDevice"
}

// ResolvedParam is one parameter after variable substitution.
type ResolvedParam struct {
	Path      string
	Type      string
	Value     any
	Sensitive bool
	Missing   []string
}

// ResolveTemplate substitutes variables. Missing variables are reported, never
// guessed; inform interval parameters are appended for the given root.
func ResolveTemplate(params []TemplateParam, inform *int, root string, vars map[string]string) ([]ResolvedParam, []string, error) {
	out := []ResolvedParam{}
	missing := []string{}
	seenMissing := map[string]bool{}
	for _, p := range params {
		item := ResolvedParam{Path: p.Path, Type: p.Type, Sensitive: SensitivePath(p.Path), Missing: []string{}}
		text := templateToken.ReplaceAllStringFunc(p.Value, func(token string) string {
			name := token[2 : len(token)-2]
			if secretVariable[name] {
				item.Sensitive = true
			}
			value, ok := vars[name]
			if !ok {
				item.Missing = append(item.Missing, name)
				if !seenMissing[name] {
					seenMissing[name] = true
					missing = append(missing, name)
				}
				return token
			}
			return value
		})
		if len(item.Missing) == 0 && utf8.RuneCountInString(text) > 256 {
			return nil, nil, templateBad("o valor resolvido de %s excede 256 caracteres", p.Path)
		}
		value, err := typedValue(p.Type, text)
		if err != nil && len(item.Missing) == 0 {
			return nil, nil, templateBad("%s: %s", p.Path, err.Error())
		}
		if err != nil {
			value = text
		}
		item.Value = value
		out = append(out, item)
	}
	if inform != nil {
		out = append(out,
			ResolvedParam{Path: root + ".ManagementServer.PeriodicInformEnable", Type: "xsd:boolean", Value: true, Missing: []string{}},
			ResolvedParam{Path: root + ".ManagementServer.PeriodicInformInterval", Type: "xsd:unsignedInt", Value: float64(*inform), Missing: []string{}},
		)
	}
	return out, missing, nil
}

// TemplatePayload builds the setParameterValues task stored in the envelope.
func TemplatePayload(resolved []ResolvedParam) map[string]any {
	values := make([]any, 0, len(resolved))
	for _, p := range resolved {
		values = append(values, []any{p.Path, p.Value, p.Type})
	}
	return map[string]any{"name": "setParameterValues", "parameterValues": values}
}

// MaskedTemplate renders resolved parameters for API responses.
func MaskedTemplate(resolved []ResolvedParam) []map[string]any {
	out := make([]map[string]any, 0, len(resolved))
	for _, p := range resolved {
		value := p.Value
		if p.Sensitive && len(p.Missing) == 0 {
			value = MaskedValue
		}
		out = append(out, map[string]any{"path": p.Path, "type": p.Type, "value": value, "sensitive": p.Sensitive, "missing": p.Missing})
	}
	return out
}
