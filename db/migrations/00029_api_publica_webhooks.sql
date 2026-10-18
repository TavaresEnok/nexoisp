-- +goose Up
-- +goose StatementBegin
-- P1: API pública com token por aplicação (escopo e limite) e webhooks de saída assinados.
-- Módulo "api", liberado por provedor. O token só aparece uma vez; no banco fica o hash.
alter table tenants drop constraint tenants_modules_check;
alter table tenants add constraint tenants_modules_check
  check (modules <@ array['olt','ipam','field','ftth','crm','noc','notices','messages','api']);

-- chamadas da API pública aparecem na auditoria com o token como ator
alter table audit_events drop constraint audit_events_actor_type_check;
alter table audit_events add constraint audit_events_actor_type_check check (actor_type in ('user','agent','system','api'));
-- atendimento aberto por integração
alter table tickets drop constraint tickets_origin_check;
alter table tickets add constraint tickets_origin_check check (origin in ('staff','portal','api'));

create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 60),
  token_hash text not null unique,
  prefix text not null,                                   -- só para o operador reconhecer o token na lista
  scopes text[] not null check (cardinality(scopes) between 1 and 20),
  rate_limit_per_min integer not null default 120 check (rate_limit_per_min between 10 and 6000),
  active boolean not null default true,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- janela de 1 minuto por token, no banco (vale com mais de uma réplica)
create table api_rate (
  tenant_id uuid not null references tenants(id),
  token_id uuid not null,
  bucket timestamptz not null,
  n integer not null default 0,
  primary key (token_id, bucket)
);

-- repetição segura de POST: mesma chave devolve a resposta original
create table api_idempotency (
  tenant_id uuid not null references tenants(id),
  token_id uuid not null,
  key text not null check (char_length(key) between 1 and 64),
  status integer not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (token_id, key)
);

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 60),
  url text not null check (char_length(url) <= 500),
  secret_enc text not null,                               -- segredo da assinatura HMAC, cifrado
  events text[] not null check (cardinality(events) between 1 and 20),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table webhook_deliveries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  endpoint_id uuid not null,
  event text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text check (char_length(last_error) <= 300),
  response_status integer,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (tenant_id, endpoint_id) references webhook_endpoints (tenant_id, id) on delete cascade
);
create index webhook_deliveries_due on webhook_deliveries (tenant_id, next_attempt_at) where status = 'pending';
create index webhook_deliveries_recent on webhook_deliveries (tenant_id, id desc);

-- A autenticação do token acontece antes de existir tenant na sessão; esta função devolve só o necessário.
create function api_token_get(p_hash text) returns table
  (token_id uuid, tenant_id uuid, name text, scopes text[], rate_limit_per_min integer, modules text[], last_used_at timestamptz)
  language sql security definer set search_path = public as $$
  select a.id, a.tenant_id, a.name, a.scopes, a.rate_limit_per_min, t.modules, a.last_used_at
  from api_tokens a join tenants t on t.id = a.tenant_id
  where a.token_hash = p_hash and a.active and a.revoked_at is null and (a.expires_at is null or a.expires_at > now()) and t.status = 'active' $$;
revoke execute on function api_token_get(text) from public;
grant execute on function api_token_get(text) to nexo_app;

alter table api_tokens enable row level security;
alter table api_rate enable row level security;
alter table api_idempotency enable row level security;
alter table webhook_endpoints enable row level security;
alter table webhook_deliveries enable row level security;
create policy t_apt on api_tokens for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_apr on api_rate for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_api on api_idempotency for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_whe on webhook_endpoints for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_whd on webhook_deliveries for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_apt on api_tokens as restrictive for all using (app_subscriber() is null);
create policy portal_apr on api_rate as restrictive for all using (app_subscriber() is null);
create policy portal_api on api_idempotency as restrictive for all using (app_subscriber() is null);
create policy portal_whe on webhook_endpoints as restrictive for all using (app_subscriber() is null);
create policy portal_whd on webhook_deliveries as restrictive for all using (app_subscriber() is null);
grant select, insert, update on api_tokens to nexo_app;
grant select, insert, update, delete on api_rate, api_idempotency, webhook_endpoints to nexo_app;
grant select, insert, update, delete on webhook_deliveries to nexo_app;
grant usage on all sequences in schema public to nexo_app;
-- +goose StatementEnd
