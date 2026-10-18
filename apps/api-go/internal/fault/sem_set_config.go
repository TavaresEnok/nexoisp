//go:build mutacao_sem_set_config

package fault

func Active(name string) bool { return name == "sem_set_config" }
