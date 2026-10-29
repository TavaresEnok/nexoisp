-- +goose Up
-- +goose StatementBegin
-- Marcador insert-only da compensação de lote. Não altera lotes, pagamentos, movimentos nem auditoria.
-- Portal e POP usam app_subscriber() e app_pops(), como import_entities. Não há GUC de suporte;
-- esse papel continua barrado na aplicação por importRevertEligibilityScope.
create table import_batch_compensations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  batch_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  request_hash text not null check (char_length(request_hash) > 0),
  reason text not null check (char_length(reason) between 10 and 200),
  actor_id uuid not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, batch_id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, batch_id) references import_batches (tenant_id, id),
  foreign key (tenant_id, actor_id) references users (tenant_id, id)
);
alter table import_batch_compensations enable row level security;
create policy t_import_batch_compensations on import_batch_compensations for all
  using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_import_batch_compensations on import_batch_compensations as restrictive for all
  using (app_subscriber() is null);
create policy pop_import_batch_compensations on import_batch_compensations as restrictive for all
  using (app_pops() is null);
revoke all on table import_batch_compensations from public;
grant select, insert on import_batch_compensations to nexo_app;
create trigger immutable_import_batch_compensations
  before update or delete on import_batch_compensations
  for each row execute function financial_append_only();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
do $$ begin raise exception 'Preserve import batch compensations and financial history; do not delete markers to roll back migration 78'; end $$;
-- +goose StatementEnd
