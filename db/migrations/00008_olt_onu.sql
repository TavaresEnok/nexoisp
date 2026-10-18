-- +goose Up
-- +goose StatementBegin
-- Expansão 1 (pós-MVP): OLT/ONU — descoberta, autorização e leitura de estado. Um fabricante por vez; aqui só o driver simulado.

alter table devices drop constraint devices_driver_check;
alter table devices add constraint devices_driver_check check (driver in ('demo','mikrotik_radius','olt_demo'));

-- ONUs vistas na OLT e ainda não autorizadas (relato do agente; snapshot completo substitui a lista do equipamento).
create table onu_discoveries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  device_id uuid not null,
  serial text not null,
  pon_port text not null,
  vendor text,
  model text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (device_id, serial),
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);

-- ONU vinculada a um contrato, com intenção versionada e observação datada (mesmo modelo da conta PPPoE).
create table onus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  device_id uuid not null,
  serial text not null check (serial ~ '^[A-Za-z0-9]{8,20}$'),
  pon_port text not null check (pon_port ~ '^[0-9]{1,3}(/[0-9]{1,3}){0,3}$'),
  line_profile text not null check (line_profile ~ '^[A-Za-z0-9_.-]{1,60}$'),
  service_vlan integer not null check (service_vlan between 1 and 4094),
  desired_version integer not null default 0,
  desired_state text not null default 'authorized' check (desired_state in ('authorized','removed')),
  desired_reason text,
  desired_at timestamptz not null default now(),
  observed_state text check (observed_state in ('authorized','absent')),
  observed_online boolean,
  observed_rx_dbm numeric(6,2),
  observed_tx_dbm numeric(6,2),
  observed_detail jsonb,
  observed_version integer,
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, contract_id),
  unique (tenant_id, serial),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);

-- A fila de operações passa a servir dois tipos de recurso: conta PPPoE ou ONU (exatamente um).
alter table operations alter column resource_id drop not null;
alter table operations add column onu_id uuid;
alter table operations add constraint operations_onu_fk foreign key (tenant_id, onu_id) references onus (tenant_id, id);
alter table operations add constraint operations_one_target check ((resource_id is not null) <> (onu_id is not null));
alter table operations drop constraint operations_action_check;
alter table operations add constraint operations_action_check check (action in
  ('subscriber.provision','subscriber.suspend','subscriber.resume','onu.authorize','onu.deauthorize'));
create index operations_onu on operations (tenant_id, onu_id, created_at desc) where onu_id is not null;

alter table onu_discoveries enable row level security;
alter table onus enable row level security;
create policy t_onud on onu_discoveries for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_onus on onus for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_onus on onus as restrictive for all using (app_subscriber() is null);
create policy portal_onud on onu_discoveries as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on onu_discoveries, onus to nexo_app;
grant usage on all sequences in schema public to nexo_app;
-- +goose StatementEnd
