package tenancy

import (
	"fmt"
	"sync"
)

type Scope struct {
	Cell         string
	TenantID     string
	operator     bool
	SubscriberID string
	PopIDs       []string
}

// O operador global não é concedido por cabeçalho HTTP.
func OperatorScope(reason string) (Scope, error) {
	if reason != "auditoria_negativa" && reason != "listar_provedores" && reason != "gerenciar_provedores" && reason != "alertas_operacionais" {
		return Scope{}, fmt.Errorf("escopo de operador não autorizado: %s", reason)
	}
	return Scope{Cell: "c1", operator: true}, nil
}
func (s Scope) IsOperator() bool { return s.operator }

type Directory struct {
	mu      sync.RWMutex
	entries map[string]string
	ready   bool
}

func (d *Directory) Replace(entries map[string]string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.entries = entries
	d.ready = true
}
func (d *Directory) Disable() { d.mu.Lock(); defer d.mu.Unlock(); d.ready = false }
func (d *Directory) Resolve(tenant string) (string, error) {
	if tenant == "" {
		return "c1", nil
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	if !d.ready {
		return "", fmt.Errorf("diretório de células indisponível")
	}
	cell, ok := d.entries[tenant]
	if !ok {
		return "", fmt.Errorf("provedor sem célula ativa")
	}
	return cell, nil
}
