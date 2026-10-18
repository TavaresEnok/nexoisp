//go:build !mutacao_dono_do_banco && !mutacao_bypassrls && !mutacao_tenant_do_cabecalho && !mutacao_sem_set_config && !mutacao_set_config_de_sessao && !mutacao_sem_pop && !mutacao_sem_assinante && !mutacao_sem_csrf && !mutacao_sem_mfa && !mutacao_sem_modulo && !mutacao_cache_sem_invalidacao && !mutacao_sem_auditoria_negativa && !mutacao_limite_desligado && !mutacao_numeric_numero && !mutacao_data_sem_ms && !mutacao_omitempty && !mutacao_zod_mensagem

// Package fault contains compile-time mutations. Production has no runtime switch.
package fault

func Active(string) bool { return false }
