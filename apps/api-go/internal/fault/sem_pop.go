//go:build mutacao_sem_pop

package fault

func Active(name string) bool { return name == "sem_pop" }
