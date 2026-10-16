-- Índices que faltavam, achados na medição com 100 mil contratos e 700 mil faturas (14/10/2026).
create index payments_invoice on payments (invoice_id) include (signed_cents);   -- saldo da fatura sem varrer todos os pagamentos
create index payments_paid_at on payments (tenant_id, paid_at);                  -- caixa do dia e recebido no mês
create index invoices_list on invoices (tenant_id, due_date desc, created_at desc, id);
create index invoices_attention on invoices (tenant_id, status, due_date) where status in ('open', 'reconciling');
create index contracts_start on contracts (tenant_id, start_date);
create index contracts_end on contracts (tenant_id, end_date) where end_date is not null;
create index service_sessions_resource on service_sessions (resource_id, stopped_at desc);
-- busca por trecho do nome sem varrer a tabela
create extension if not exists pg_trgm;
create index subscribers_name_trgm on subscribers using gin (name gin_trgm_ops);
create index contracts_list on contracts (tenant_id, created_at desc, id);
create index subscribers_name on subscribers (tenant_id, name, id);
-- busca única (documento, telefone, e-mail e login por trecho)
create index subscribers_document_trgm on subscribers using gin (document gin_trgm_ops);
create index subscribers_phone_trgm on subscribers using gin (phone gin_trgm_ops);
create index subscribers_email_trgm on subscribers using gin (email gin_trgm_ops);
create index service_resources_user_trgm on service_resources using gin (pppoe_username gin_trgm_ops);
