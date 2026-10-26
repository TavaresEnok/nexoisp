package jobargs

// Periodic with no tenant dispatches durable, independently retried tenant jobs.
type Periodic struct {
	Task     string `json:"task"`
	TenantID string `json:"tenant_id,omitempty"`
}

func (Periodic) Kind() string { return "nexo_periodic" }
