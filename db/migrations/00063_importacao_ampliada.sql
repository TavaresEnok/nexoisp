-- +goose Up
-- +goose StatementBegin
alter table import_batches drop constraint import_batches_kind_check;
alter table import_batches add constraint import_batches_kind_check check
  (kind in ('subscribers','contracts','invoices','history','network','documents','users'));
create table import_entities (
  tenant_id uuid not null references tenants(id),
  source text not null,
  kind text not null,
  external_id text not null,
  entity_id uuid not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id,source,kind,external_id)
);
alter table import_entities enable row level security;
create policy t_import_entities on import_entities for all using (tenant_id=app_tenant()) with check (tenant_id=app_tenant());
create policy portal_import_entities on import_entities as restrictive for all using (app_subscriber() is null);
create policy pop_import_entities on import_entities as restrictive for all using (app_pops() is null);
grant select,insert on import_entities to nexo_app;
-- +goose StatementEnd
