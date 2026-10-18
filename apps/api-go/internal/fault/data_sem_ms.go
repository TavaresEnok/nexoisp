//go:build mutacao_data_sem_ms

package fault

func Active(name string) bool { return name == "data_sem_ms" }
