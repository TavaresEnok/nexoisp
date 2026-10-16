//go:build mutacao_sem_modulo

package fault

func Active(name string) bool { return name == "sem_modulo" }
