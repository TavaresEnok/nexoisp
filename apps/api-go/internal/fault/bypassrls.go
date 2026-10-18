//go:build mutacao_bypassrls

package fault

func Active(name string) bool { return name == "bypassrls" }
