//go:build mutacao_dono_do_banco

package fault

func Active(name string) bool { return name == "dono_do_banco" }
