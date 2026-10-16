-- +goose Up
-- +goose StatementBegin
-- E2: equipamentos, agentes, estado desejado/observado e tarefas de rede no PostgreSQL (ADR-002, 007, 014).

create table agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active','revoked')),
  version text,
  last_seen_at timestamptz,
  sync_session_id text,                    -- sessão do processo do agente que concluiu a sincronização completa
  last_sync_at timestamptz,
  info jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  driver text not null check (driver in ('demo','mikrotik_radius')),
  host text,
  api_port integer,
  credential_ref text,                     -- referência a credencial guardada no agente; a nuvem não armazena a senha do equipamento
  agent_id uuid,
  maintenance boolean not null default false,   -- modo manutenção: ERP não escreve no equipamento
  last_check_at timestamptz,
  last_check jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);

-- Recurso de serviço: conta PPPoE do contrato, com intenção versionada e observação datada.
create table service_resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  device_id uuid not null,
  pppoe_username text not null,
  secret_enc text,                         -- segredo PPPoE cifrado (AES-256-GCM); null = credencial indisponível
  desired_version integer not null default 0,
  desired_policy text not null default 'active' check (desired_policy in ('active','suspended')),
  desired_profile text not null,
  desired_reason text,
  desired_at timestamptz not null default now(),
  observed_policy text check (observed_policy in ('active','suspended','absent')),
  observed_profile text,
  observed_session jsonb,
  observed_version integer,                -- versão da intenção confirmada pela última operação concluída
  observed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, contract_id),
  unique (tenant_id, pppoe_username),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  foreign key (tenant_id, device_id) references devices (tenant_id, id)
);

create table operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  resource_id uuid not null,
  device_id uuid not null,
  agent_id uuid not null,
  action text not null check (action in ('subscriber.provision','subscriber.suspend','subscriber.resume')),
  schema_version integer not null default 1,
  desired_version integer not null,
  parameters jsonb not null,
  idempotency_key text not null,
  valid_until timestamptz not null,
  authorization_ref jsonb not null,
  envelope text not null,                  -- JSON exato que foi assinado
  signature text not null,                 -- Ed25519 (base64) sobre os bytes de envelope
  status text not null default 'PENDING' check (status in
    ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN','SUCCEEDED','SUPERSEDED','CANCELED','EXPIRED','FAILED')),
  next_attempt_at timestamptz,
  attempts integer not null default 0,
  current_attempt_id uuid,
  lease_until timestamptz,
  result jsonb,
  note text,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, resource_id) references service_resources (tenant_id, id),
  foreign key (tenant_id, device_id) references devices (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents (tenant_id, id)
);
create index operations_queue on operations (agent_id, created_at) where status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN');
create index operations_resource on operations (tenant_id, resource_id, created_at desc);

create table operation_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  operation_id uuid not null,
  agent_id uuid not null,
  recover boolean not null default false,
  status text not null default 'RESERVED',
  steps jsonb not null default '[]',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (tenant_id, operation_id) references operations (tenant_id, id)
);
create index attempts_op on operation_attempts (operation_id, started_at);

create function agent_auth(p_token_hash text) returns table (id uuid, tenant_id uuid, name text, status text)
  language sql security definer set search_path = public as $$
  select a.id, a.tenant_id, a.name, a.status from agents a join tenants t on t.id = a.tenant_id
  where a.token_hash = p_token_hash and t.status = 'active' $$;

alter table agents enable row level security;
alter table devices enable row level security;
alter table service_resources enable row level security;
alter table operations enable row level security;
alter table operation_attempts enable row level security;
create policy t_agents on agents for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_devices on devices for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_res on service_resources for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ops on operations for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_att on operation_attempts for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

grant select, insert, update, delete on agents, devices, service_resources to nexo_app;
grant select, insert, update on operations, operation_attempts to nexo_app;
revoke execute on function agent_auth(text) from public;
grant execute on function agent_auth(text) to nexo_app;
-- +goose StatementEnd
