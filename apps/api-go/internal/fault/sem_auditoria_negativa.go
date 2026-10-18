//go:build mutacao_sem_auditoria_negativa

package fault

func Active(name string) bool { return name == "sem_auditoria_negativa" }
