-- +goose Up
-- +goose StatementBegin
-- Backup da configuração dos equipamentos que o NexoISP gerencia (OLTs e concentradores com agente).
-- Um backup a cada 7 dias, pedido manual pelo painel e só as 4 cópias mais recentes por equipamento.
-- O texto fica comprimido (gzip) e cifrado com a chave de segredos (cryptox, AES-256-GCM); a rotação de chaves recifra.
alter table devices
  add column config_backup boolean not null default true,
  add column config_backup_requested_at timestamptz,
  add column config_backup_error text check (config_backup_error is null or length(config_backup_error) <= 500),
  add column config_backup_error_at timestamptz;

create table config_backups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  device_id uuid not null,
  taken_at timestamptz not null default now(),
  trigger text not null check (trigger in ('scheduled', 'manual')),
  size_bytes integer not null check (size_bytes >= 0),
  lines integer not null check (lines >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),   -- do texto normalizado (sem a linha de data do cabeçalho)
  changed boolean,                                            -- difere da cópia anterior; nulo na primeira
  content_enc text not null,
  unique (tenant_id, id),
  foreign key (tenant_id, device_id) references devices (tenant_id, id) on delete cascade
);
create index config_backups_device on config_backups (tenant_id, device_id, taken_at desc);
alter table config_backups enable row level security;
create policy config_backups_tenant on config_backups for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy config_backups_portal on config_backups as restrictive for all using (app_subscriber() is null) with check (app_subscriber() is null);
grant select, insert, update, delete on config_backups to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop table config_backups;
alter table devices drop column config_backup, drop column config_backup_requested_at, drop column config_backup_error, drop column config_backup_error_at;
-- +goose StatementEnd
