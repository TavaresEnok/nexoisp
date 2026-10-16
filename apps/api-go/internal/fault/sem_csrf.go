//go:build mutacao_sem_csrf

package fault

func Active(name string) bool { return name == "sem_csrf" }
