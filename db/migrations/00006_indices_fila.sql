-- +goose Up
-- +goose StatementBegin
-- Índices para a fila de operações com milhares de tarefas pendentes (medição da E6).
create index operations_busy_device on operations (device_id) where status in ('RESERVED','EXECUTING','VERIFYING','UNCERTAIN');
create index operations_lease on operations (lease_until) where status in ('RESERVED','EXECUTING','VERIFYING');
create index operations_pending_valid on operations (valid_until) where status = 'PENDING';
create index operations_pending_agent on operations (agent_id, created_at, desired_version) where status = 'PENDING';
create index operations_uncertain_agent on operations (agent_id) where status = 'UNCERTAIN';
create index invoices_open_due on invoices (tenant_id, due_date) where status = 'open';
-- +goose StatementEnd
