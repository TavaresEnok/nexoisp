package escrita

import (
	"strings"
	"testing"
)

func TestDICICNPJDigitsAndCheckDigits(t *testing.T) {
	for raw, want := range map[string]string{"11.222.333/0001-81": "11222333000181", "11222333000181": "11222333000181", "04.252.011/0001-10": "04252011000110"} {
		got, ok := diciCNPJ(raw)
		if !ok || got != want {
			t.Fatalf("%s: %s %v", raw, got, ok)
		}
	}
	for _, raw := range []string{"", "11222333000182", "11222333000191", "1122233300018", "00000000000000", "11111111111111", "112223330001810"} {
		if _, ok := diciCNPJ(raw); ok {
			t.Fatalf("CNPJ inválido aceito: %q", raw)
		}
	}
}

func TestDICILayoutHeaderOrderSeparatorsAndDomains(t *testing.T) {
	rows := []diciRow{
		{CNPJ: "11222333000181", IBGE: "2304400", Client: "PJ", Area: "URBANO", Medium: diciMedium["FTTH"], Technology: diciTechnology["FTTH"], Mbps: 300, Accesses: 2},
		{CNPJ: "11222333000181", IBGE: "2304400", Client: "PF", Area: "RURAL", Medium: diciMedium["RADIO"], Technology: diciTechnology["RADIO"], Mbps: 0.5, Accesses: 1},
		{CNPJ: "11222333000181", IBGE: "2303709", Client: "PF", Area: "URBANO", Medium: diciMedium["XDSL"], Technology: diciTechnology["XDSL"], Mbps: 15.75, Accesses: 7},
	}
	raw := string(diciCSV("2026-03", rows))
	if !strings.HasPrefix(raw, "\ufeffCNPJ;ANO;MES;COD_IBGE;TIPO_CLIENTE;TIPO_ATENDIMENTO;TIPO_MEIO;TIPO_PRODUTO;TIPO_TECNOLOGIA;VELOCIDADE;ACESSOS\r\n") {
		t.Fatalf("cabeçalho/BOM: %q", raw)
	}
	if !strings.HasSuffix(raw, "\r\n") || strings.Contains(strings.ReplaceAll(raw, "\r\n", ""), "\n") {
		t.Fatalf("quebras de linha devem ser CRLF: %q", raw)
	}
	lines := strings.Split(strings.TrimSuffix(strings.TrimPrefix(raw, "\ufeff"), "\r\n"), "\r\n")
	want := []string{
		"CNPJ;ANO;MES;COD_IBGE;TIPO_CLIENTE;TIPO_ATENDIMENTO;TIPO_MEIO;TIPO_PRODUTO;TIPO_TECNOLOGIA;VELOCIDADE;ACESSOS",
		"11222333000181;2026;03;2303709;PF;URBANO;cabo_metalico;internet;xDSL;15,75;7",
		"11222333000181;2026;03;2304400;PF;RURAL;radio;internet;Wi-Fi;0,5;1",
		"11222333000181;2026;03;2304400;PJ;URBANO;fibra;internet;FTTH;300;2",
	}
	if len(lines) != len(want) {
		t.Fatalf("linhas: %q", lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("linha %d: %q, esperado %q", i, lines[i], want[i])
		}
		if strings.Count(lines[i], ";") != 10 {
			t.Fatalf("linha %d com colunas erradas", i)
		}
	}
	for _, tech := range []string{"FTTH", "FTTB", "HFC", "XDSL", "ETHERNET", "RADIO", "LTE", "SATELITE"} {
		if diciMedium[tech] == "" || diciTechnology[tech] == "" {
			t.Fatalf("tecnologia %s sem domínio no leiaute", tech)
		}
	}
	if _, ok := diciTechnology["OUTRA"]; ok {
		t.Fatal("tecnologia genérica não pode virar código do leiaute")
	}
}

func TestDICIIssuesBlockMissingCodesTechnologyAndCNPJ(t *testing.T) {
	ok := diciIssues([]diciCompany{{ID: "a", Name: "Alfa", Document: "11222333000181", Contracts: 3}}, nil, nil, 0)
	if len(ok) != 0 {
		t.Fatalf("pendência inexistente: %v", ok)
	}
	issues := diciIssues(
		[]diciCompany{{ID: "", Contracts: 2}, {ID: "b", Name: "Beta", Document: "11222333000182", Contracts: 4}, {ID: "c", Name: "Gama", Contracts: 1}},
		[]diciPlan{{ID: "p1", Name: "Fibra 1G", Contracts: 5}, {ID: "p2", Name: "Rural", Technology: "OUTRA", Contracts: 1}},
		[]diciCity{{City: "Fortaleza", State: "CE", Contracts: 6}, {Contracts: 2}},
		10,
	)
	joined := strings.Join(issues, "\n")
	for _, want := range []string{
		"2 contrato(s) sem empresa faturadora",
		"Empresa Beta: CNPJ ausente ou inválido (4 contrato(s))",
		"Empresa Gama: CNPJ ausente ou inválido (1 contrato(s))",
		"Município sem código IBGE: Fortaleza/CE (6 contrato(s))",
		"2 contrato(s) sem cidade ou UF",
		"Outros 2 contrato(s) em municípios sem código IBGE",
		"Plano Fibra 1G sem tecnologia de acesso (5 contrato(s))",
		"Plano Rural com tecnologia sem código no leiaute",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("pendência ausente %q em:\n%s", want, joined)
		}
	}
}
