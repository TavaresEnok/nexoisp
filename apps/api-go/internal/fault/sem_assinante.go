//go:build mutacao_sem_assinante

package fault

func Active(name string) bool { return name == "sem_assinante" }
