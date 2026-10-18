package jobargs

type Operation struct {
	TenantID    string `json:"tenant_id"`
	OperationID string `json:"operation_id"`
}

func (Operation) Kind() string { return "nexo_operation" }
