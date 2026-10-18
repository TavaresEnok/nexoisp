-- +goose Up
-- +goose StatementBegin
-- Expansão 4 (pós-MVP): CRM — funil de prospectos e atendimentos (protocolos) com acesso do assinante pelo portal.

create table leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  phone text,
  email text,
  document text,
  address_street text, address_number text, address_district text,
  address_city text, address_state text, address_zip text,
  source text,                                      -- origem declarada: indicação, site, panfleto...
  stage text not null default 'new' check (stage in ('new','contacted','proposal','won','lost')),
  plan_id uuid,                                     -- plano de interesse
  notes text,
  owner_id uuid references users(id),
  lost_reason text,
  subscriber_id uuid,                               -- preenchido na conversão
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, plan_id) references plans (tenant_id, id),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  check (phone is not null or email is not null),
  check (stage <> 'lost' or lost_reason is not null),
  check ((stage = 'won') = (subscriber_id is not null))
);
create index leads_stage on leads (tenant_id, stage, updated_at desc);

create table lead_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  lead_id uuid not null,
  at timestamptz not null default now(),
  actor_id uuid,
  event text not null,                              -- created | stage | note | converted
  detail jsonb not null default '{}',
  foreign key (tenant_id, lead_id) references leads (tenant_id, id)
);
create index lead_events_lead on lead_events (lead_id, id);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number bigint not null,                           -- protocolo
  subscriber_id uuid not null,
  contract_id uuid,
  subject text not null,
  category text not null check (category in ('technical','financial','commercial','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'open' check (status in ('open','waiting','closed')),   -- waiting = aguardando o assinante
  origin text not null check (origin in ('staff','portal')),
  assignee_id uuid references users(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, subscriber_id) references subscribers (tenant_id, id),
  foreign key (tenant_id, contract_id) references contracts (tenant_id, id),
  check ((status = 'closed') = (closed_at is not null))
);
create index tickets_open on tickets (tenant_id, updated_at desc) where status <> 'closed';
create index tickets_subscriber on tickets (tenant_id, subscriber_id, created_at desc);

-- Mensagens são históricas: sem alteração nem exclusão. `internal` nunca chega ao assinante.
create table ticket_messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  ticket_id uuid not null,
  at timestamptz not null default now(),
  author_id uuid,
  author_kind text not null check (author_kind in ('staff','subscriber')),
  body text not null,
  internal boolean not null default false,
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id),
  check (not (internal and author_kind = 'subscriber'))
);
create index ticket_messages_ticket on ticket_messages (ticket_id, id);

alter table work_orders add column ticket_id uuid;
alter table work_orders add constraint work_orders_ticket_fk foreign key (tenant_id, ticket_id) references tickets (tenant_id, id);

alter table leads enable row level security;
alter table lead_events enable row level security;
alter table tickets enable row level security;
alter table ticket_messages enable row level security;
create policy t_lead on leads for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_leadev on lead_events for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_tk on tickets for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_tkm on ticket_messages for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_lead on leads as restrictive for all using (app_subscriber() is null);
create policy portal_leadev on lead_events as restrictive for all using (app_subscriber() is null);
-- Assinante: só os próprios atendimentos e, neles, só as mensagens não internas (mesmo que a consulta esqueça o filtro).
create policy portal_tk on tickets as restrictive for all using (app_subscriber() is null or subscriber_id = app_subscriber());
create policy portal_tkm on ticket_messages as restrictive for all using
  (app_subscriber() is null or (not internal and exists (select 1 from tickets t where t.id = ticket_id)));
grant select, insert, update on leads, tickets to nexo_app;
grant select, insert on lead_events, ticket_messages to nexo_app;
grant usage on all sequences in schema public to nexo_app;
-- +goose StatementEnd
