-- +goose Up
-- +goose StatementBegin
-- Mapeamentos de CGNAT importados para a consulta de ofício quando o titular não sai de fórmula
-- (estudo do backup center, 12/11/2026):
--   config:       regras exatas lidas do equipamento (netmap MikroTik fora da ordem contígua), sem período;
--   log:          registro de alocação/liberação de bloco de portas (Hillstone fixed-block, A10 LSN, syslog);
--   mapping_file: arquivo de mapeamento do A10 fixed-nat (offset random), vigente a partir da data informada;
--   csv:          planilha neutra (private_ip, public_ip, port_start, port_end, start, end).
-- O bloco privado e o público têm o mesmo tamanho: o titular é o mesmo deslocamento dentro do bloco privado.
create table cgnat_mapping_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('config', 'log', 'mapping_file', 'csv')),
  label text not null check (length(label) between 1 and 120),
  lines integer not null check (lines >= 0),
  accepted integer not null check (accepted >= 0),
  rejected integer not null check (rejected >= 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table cgnat_mappings (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  batch_id uuid not null,
  private_cidr cidr not null check (family(private_cidr) = 4),
  public_cidr cidr not null check (family(public_cidr) = 4),
  port_start integer not null check (port_start between 1 and 65535),
  port_end integer not null check (port_end between port_start and 65535),
  valid_from timestamptz,
  valid_to timestamptz,
  check (masklen(private_cidr) = masklen(public_cidr)),
  check (valid_to is null or valid_from is null or valid_to > valid_from),
  foreign key (tenant_id, batch_id) references cgnat_mapping_batches (tenant_id, id) on delete cascade
);
create index cgnat_mappings_public on cgnat_mappings using gist (public_cidr inet_ops);
create index cgnat_mappings_batch on cgnat_mappings (tenant_id, batch_id);
alter table cgnat_mapping_batches enable row level security;
alter table cgnat_mappings enable row level security;
create policy cgnat_mapping_batches_tenant on cgnat_mapping_batches for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy cgnat_mapping_batches_portal on cgnat_mapping_batches as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
create policy cgnat_mappings_tenant on cgnat_mappings for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy cgnat_mappings_portal on cgnat_mappings as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
grant select, insert, delete on cgnat_mapping_batches, cgnat_mappings to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop table cgnat_mappings;
drop table cgnat_mapping_batches;
-- +goose StatementEnd
