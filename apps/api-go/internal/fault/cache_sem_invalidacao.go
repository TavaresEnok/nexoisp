//go:build mutacao_cache_sem_invalidacao

package fault

func Active(name string) bool { return name == "cache_sem_invalidacao" }
