-- E1: identidade, cadastro, planos, contratos, auditoria. Multi-tenant com RLS (ADR-003).

create extension if not exists pgcrypto;

create function app_tenant() returns uuid language sql stable as
  $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;
create function app_is_operator() returns boolean language sql stable as
  $$ select coalesce(current_setting('app.is_operator', true), '') = 'on' $$;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),          -- null = operador do SaaS
  email text not null,
  name text not null,
  password_hash text not null,
  role text not null check (role in ('saas_operator','admin','attendant','finance','noc','subscriber')),
  subscriber_id uuid,                              -- preenchido para role=subscriber (portal, E5)
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((role = 'saas_operator') = (tenant_id is null))
);
create unique index users_email_uq on users (lower(email));

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  support_tenant_id uuid references tenants(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  tenant_id uuid references tenants(id),
  actor_type text not null check (actor_type in ('user','agent','system')),
  actor_id text,
  action text not null,
  entity_type text,
  entity_id text,
  result text not null default 'ok',
  detail jsonb not null default '{}'
);
create index audit_tenant_at on audit_events (tenant_id, at desc);

create table subscribers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  document text,                                   -- CPF/CNPJ só dígitos
  email text,
  phone text,
  address_street text, address_number text, address_district text,
  address_city text, address_state text, address_zip text,
  notes text,
  status text not null default 'active' check (status in ('active','inactive')),
  external_source text, external_id text,          -- origem da importação (E5)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index subscribers_doc_uq on subscribers (tenant_id, document) where document is not null;
create unique index subscribers_ext_uq on subscribers (tenant_id, external_source, external_id) where external_id is not null;

create table plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- Versões são imutáveis: alterar preço/velocidade cria nova versão; contratos mantêm a que contrataram.
create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  plan_id uuid not null,
  version int not null,
  price_cents integer not null check (price_cents >= 0),
  down_kbps integer not null check (down_kbps > 0),
  up_kbps integer not null check (up_kbps > 0),
  profile_name text not null,                      -- perfil de velocidade homologado no NAS
  valid_from date not null default current_date,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (plan_id, version),
  foreign key (tenant_id, plan_id) references plans (tenant_id, id)
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscriber_id uuid not null,
  plan_version_id uuid not null,
  status text not null default 'active' check (status in ('active','ended')),
  due_day integer not null check (due_day between 1 and 28),
  start_date date not null default current_date,
  end_date date,
  notes text,
  external_source text, external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  foreign key (tenant_id, plan_version_id) references plan_versions (tenant_id, id)
);
create unique index contracts_ext_uq on contracts (tenant_id, external_source, external_id) where external_id is not null;
create index contracts_subscriber on contracts (tenant_id, subscriber_id);

create table contract_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  contract_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  event text not null,                             -- created | plan_changed | ended | due_day_changed
  detail jsonb not null default '{}',
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id)
);

-- Funções de sessão/login: únicas portas de acesso às tabelas sem tenant conhecido.
create function auth_find_user(p_email text) returns table
  (id uuid, tenant_id uuid, role text, name text, email text, password_hash text, active boolean, subscriber_id uuid, tenant_status text)
  language sql security definer set search_path = public as $$
  select u.id, u.tenant_id, u.role, u.name, u.email, u.password_hash, u.active, u.subscriber_id, t.status
  from users u left join tenants t on t.id = u.tenant_id where lower(u.email) = lower(p_email) $$;

create function session_create(p_user uuid, p_token_hash text, p_expires timestamptz) returns void
  language sql security definer set search_path = public as $$
  insert into sessions (user_id, token_hash, expires_at) values (p_user, p_token_hash, p_expires) $$;

create function session_get(p_token_hash text) returns table
  (user_id uuid, tenant_id uuid, role text, name text, email text, subscriber_id uuid, support_tenant_id uuid)
  language sql security definer set search_path = public as $$
  select u.id, u.tenant_id, u.role, u.name, u.email, u.subscriber_id, s.support_tenant_id
  from sessions s join users u on u.id = s.user_id
  left join tenants t on t.id = u.tenant_id
  where s.token_hash = p_token_hash and s.expires_at > now() and u.active
    and (t.id is null or t.status = 'active') $$;

create function session_delete(p_token_hash text) returns void
  language sql security definer set search_path = public as $$
  delete from sessions where token_hash = p_token_hash $$;

create function session_set_support(p_token_hash text, p_tenant uuid) returns void
  language sql security definer set search_path = public as $$
  update sessions set support_tenant_id = p_tenant where token_hash = p_token_hash $$;

-- RLS
alter table tenants enable row level security;
alter table users enable row level security;
alter table audit_events enable row level security;
alter table subscribers enable row level security;
alter table plans enable row level security;
alter table plan_versions enable row level security;
alter table contracts enable row level security;
alter table contract_history enable row level security;

create policy tenants_op on tenants for all using (app_is_operator() or id = app_tenant()) with check (app_is_operator());
create policy users_pol on users for all
  using (app_is_operator() or tenant_id = app_tenant())
  with check (app_is_operator() or tenant_id = app_tenant());
create policy audit_sel on audit_events for select using (app_is_operator() or tenant_id = app_tenant());
create policy audit_ins on audit_events for insert
  with check (tenant_id = app_tenant() or (tenant_id is null and app_is_operator()) or app_is_operator());
create policy t_sub on subscribers for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_plan on plans for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_pv on plan_versions for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_con on contracts for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ch on contract_history for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());

-- Privilégios do papel da aplicação (nexo_app: sem BYPASSRLS, sem ser dono)
revoke all on all tables in schema public from public;
grant usage on schema public to nexo_app;
grant select, insert, update, delete on tenants, users, subscribers, plans, contracts to nexo_app;
grant select, insert on plan_versions, contract_history, audit_events to nexo_app;
grant usage on all sequences in schema public to nexo_app;
revoke all on sessions from nexo_app;
revoke execute on all functions in schema public from public;
grant execute on function app_tenant(), app_is_operator(), auth_find_user(text),
  session_create(uuid, text, timestamptz), session_get(text), session_delete(text),
  session_set_support(text, uuid) to nexo_app;
