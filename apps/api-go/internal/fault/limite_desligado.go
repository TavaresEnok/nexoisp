//go:build mutacao_limite_desligado

package fault

func Active(name string) bool { return name == "limite_desligado" }
