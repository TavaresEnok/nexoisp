package leitura

import (
	"strings"
	"testing"
)

// Modo direto: o IP cadastrado do concentrador vira src-address; sem ele, nada é inventado.
func TestRadiusDiretoComSrcAddress(t *testing.T) {
	setup, err := RadiusSetupData("mikrotik", 3799, "<SEGREDO>", nil, "203.0.113.7/32")
	if err != nil {
		t.Fatal(err)
	}
	commands := setup["commands"].(string)
	if !strings.Contains(commands, "timeout=3s src-address=203.0.113.7 comment=nexoisp") {
		t.Fatalf("src-address ausente no modo direto:\n%s", commands)
	}
	setup, err = RadiusSetupData("mikrotik", 3799, "<SEGREDO>", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(setup["commands"].(string), "src-address") {
		t.Fatalf("sem IP cadastrado não deveria haver src-address:\n%s", setup["commands"])
	}
}
