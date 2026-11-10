package network

import (
	"fmt"
	"strings"
	"testing"
)

func TestNormalizeConfigIgnoraDataDoExport(t *testing.T) {
	a := "# 2026-11-03 03:00:01 by RouterOS 7.17\r\n# software id = ABCD-1234\n/system identity\nset name=BNG  \n"
	b := "# 2026-11-10 03:00:07 by RouterOS 7.17\n# software id = ABCD-1234\n/system identity\nset name=BNG\n\n"
	if ConfigHash(a) != ConfigHash(b) {
		t.Fatalf("mesma configuração com datas diferentes deveria ter o mesmo hash:\n%q\n%q", NormalizeConfig(a), NormalizeConfig(b))
	}
	if ConfigHash(a) == ConfigHash(strings.Replace(b, "BNG", "BNG2", 1)) {
		t.Fatal("configuração alterada deveria mudar o hash")
	}
}

func TestSealConfigIdaEVolta(t *testing.T) {
	t.Setenv("NEXO_SECRET_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	text := strings.Repeat(" service-port 1 vlan 100 gpon 0/1/0 ont 1 gemport 1\n", 5000)
	sealed, err := SealConfig(text)
	if err != nil {
		t.Skip("chave de segredos indisponível neste processo:", err)
	}
	if len(sealed) > len(text)/10 {
		t.Fatalf("texto repetitivo deveria comprimir bem: %d -> %d", len(text), len(sealed))
	}
	if strings.Contains(sealed, "service-port") {
		t.Fatal("conteúdo em claro no armazenamento")
	}
	back, err := OpenConfig(sealed)
	if err != nil || back != text {
		t.Fatalf("ida e volta falhou: %v", err)
	}
}

func render(lines []DiffLine) string {
	var out []string
	for _, l := range lines {
		if l.Op == "@" {
			out = append(out, fmt.Sprintf("@ %d %d", l.Old, l.New))
			continue
		}
		out = append(out, l.Op+l.Text)
	}
	return strings.Join(out, "\n")
}

func TestConfigDiffMostraSoOsTrechosAlterados(t *testing.T) {
	var before []string
	for i := 1; i <= 40; i++ {
		before = append(before, fmt.Sprintf("linha %d", i))
	}
	after := append([]string{}, before...)
	after[4] = "linha 5 alterada"
	after = append(after[:30], append([]string{"nova A", "nova B"}, after[30:]...)...)
	after = after[:len(after)-1] // remove a última
	lines, added, removed, truncated := ConfigDiff(strings.Join(before, "\n"), strings.Join(after, "\n"))
	if truncated || added != 3 || removed != 2 {
		t.Fatalf("contagem: +%d -%d truncado=%v\n%s", added, removed, truncated, render(lines))
	}
	want := strings.Join([]string{
		"@ 2 2", " linha 2", " linha 3", " linha 4", "-linha 5", "+linha 5 alterada", " linha 6", " linha 7", " linha 8",
		"@ 28 28", " linha 28", " linha 29", " linha 30", "+nova A", "+nova B", " linha 31", " linha 32", " linha 33",
		"@ 37 39", " linha 37", " linha 38", " linha 39", "-linha 40",
	}, "\n")
	if got := render(lines); got != want {
		t.Fatalf("diff:\n%s\n--- esperado:\n%s", got, want)
	}
	if lines[4].Old != 5 || lines[5].New != 5 {
		t.Fatalf("numeração das linhas: %+v %+v", lines[4], lines[5])
	}
}

func TestConfigDiffIgualEVazio(t *testing.T) {
	if lines, a, r, tr := ConfigDiff("x\ny\n", "x\ny"); len(lines) != 0 || a != 0 || r != 0 || tr {
		t.Fatalf("iguais: %v", lines)
	}
	if _, a, r, _ := ConfigDiff("", "a\nb"); a != 2 || r != 1 {
		t.Fatalf("de vazio: +%d -%d", a, r)
	}
}

func TestConfigDiffDesisteComDiferencaDemais(t *testing.T) {
	var a, b []string
	for i := 0; i < 3000; i++ {
		a = append(a, fmt.Sprintf("a%d", i))
		b = append(b, fmt.Sprintf("b%d", i))
	}
	if _, _, _, truncated := ConfigDiff(strings.Join(a, "\n"), strings.Join(b, "\n")); !truncated {
		t.Fatal("deveria desistir acima do limite de diferenças")
	}
}
