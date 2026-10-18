-- +goose Up
-- +goose StatementBegin
-- Atendimento no dia a dia: histórico de sessões (do accounting do RADIUS local), contatos múltiplos por tipo e POP.

-- ---- sessões por conta PPPoE (agente 0.4.0+) ----
create table service_sessions (
  tenant_id uuid not null references tenants(id),
  resource_id uuid not null references service_resources(id),
  session_key text not null check (char_length(session_key) between 1 and 80),   -- acctuniqueid (ou a identidade da sessão no accounting)
  started_at timestamptz not null,
  stopped_at timestamptz,                    -- vazio = sessão aberta no momento do relato
  ip text,
  mac text,
  nas_ip text,
  bytes_in bigint not null default 0 check (bytes_in >= 0),     -- enviado pelo assinante
  bytes_out bigint not null default 0 check (bytes_out >= 0),   -- recebido pelo assinante
  seconds bigint not null default 0 check (seconds >= 0),
  terminate_cause text check (char_length(terminate_cause) <= 60),
  reported_at timestamptz not null default now(),
  primary key (resource_id, session_key)
);
create index service_sessions_period on service_sessions (tenant_id, resource_id, started_at desc);
alter table service_sessions enable row level security;
create policy t_sess on service_sessions for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_sess on service_sessions as restrictive for all using (
  app_subscriber() is null or exists (select 1 from service_resources r join contracts k on k.id = r.contract_id
                                      where r.id = service_sessions.resource_id and k.subscriber_id = app_subscriber()));
grant select, insert, update on service_sessions to nexo_app;

-- ---- contatos do assinante ----
create table subscriber_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscriber_id uuid not null,
  kind text not null check (kind in ('mobile','whatsapp','landline','email','responsible')),
  value text not null check (char_length(value) between 3 and 200),
  label text check (char_length(label) <= 60),
  purpose text not null default 'general' check (purpose in ('general','billing','technical')),   -- para que serve (cobrança, visita técnica)
  allow_notices boolean not null default false,       -- consentimento para avisos de saída (cobrança, manutenção, OS)
  created_at timestamptz not null default now(),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id)
);
create index subscriber_contacts_sub on subscriber_contacts (tenant_id, subscriber_id);
alter table subscriber_contacts enable row level security;
create policy t_contacts on subscriber_contacts for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_contacts on subscriber_contacts as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
grant select, insert, update, delete on subscriber_contacts to nexo_app;

-- ---- POP ----
create table pops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 80),
  city text,
  state text check (char_length(state) = 2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
alter table pops enable row level security;
create policy t_pops on pops for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_pops on pops as restrictive for all using (app_subscriber() is null);
grant select, insert, update on pops to nexo_app;
alter table contracts add column pop_id uuid;
alter table contracts add constraint contracts_pop_fk foreign key (tenant_id, pop_id) references pops (tenant_id, id);
create index contracts_pop on contracts (tenant_id, pop_id) where pop_id is not null;
-- +goose StatementEnd
