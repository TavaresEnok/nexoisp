//go:build mutacao_sem_mfa

package fault

func Active(name string) bool { return name == "sem_mfa" }
