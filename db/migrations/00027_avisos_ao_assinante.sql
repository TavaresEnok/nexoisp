-- +goose Up
-- +goose StatementBegin
-- Avisos ao assinante: SOMENTE DE SAÍDA (cobrança, manutenção, OS). O NexoISP não é um sistema de chat: não há caixa de entrada nem conversa.
-- Canal = um endereço HTTPS do provedor de envio (SMS/WhatsApp) escolhido pelo provedor; o NexoISP faz a chamada e registra o resultado.
alter table tenants drop constraint tenants_modules_check;
alter table tenants add constraint tenants_modules_check
  check (modules <@ array['olt','ipam','field','ftth','crm','noc','notices','messages']);

create table notice_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 60),
  url text not null check (char_length(url) <= 500),
  phone_field text not null default 'to' check (phone_field ~ '^[A-Za-z0-9_.-]{1,40}$'),       -- nome do campo do telefone no corpo JSON
  message_field text not null default 'message' check (message_field ~ '^[A-Za-z0-9_.-]{1,40}$'),
  extra_body jsonb not null default '{}',                                                      -- campos fixos do corpo (ex.: remetente)
  headers_enc text,                                                                            -- cabeçalhos (ex.: Authorization) cifrados
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table notice_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 60),
  body text not null check (char_length(body) between 3 and 480),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table notice_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 80),
  template_id uuid not null,
  channel_id uuid not null,
  days_relative integer not null check (days_relative between -30 and 365),    -- vs. vencimento: -3 = 3 dias antes; 0 = no dia; 5 = 5 dias depois
  plan_id uuid,
  pop_id uuid,
  tag_id uuid,
  hour_from integer not null default 8 check (hour_from between 0 and 23),
  hour_to integer not null default 20 check (hour_to between 1 and 24),
  weekdays integer[] not null default '{0,1,2,3,4,5,6}',
  min_interval_days integer not null default 1 check (min_interval_days between 0 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (hour_from < hour_to),
  foreign key (tenant_id, template_id) references notice_templates (tenant_id, id),
  foreign key (tenant_id, channel_id) references notice_channels (tenant_id, id)
);
create table notice_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id),
  rule_id uuid,
  invoice_id uuid,
  contract_id uuid,
  subscriber_id uuid,
  contact_value text,                       -- telefone usado (para suporte; não é segredo)
  status text not null check (status in ('sent','failed','skipped_no_consent','test')),
  attempts integer not null default 1,
  error text check (char_length(error) <= 300),
  created_at timestamptz not null default now(),
  unique (rule_id, invoice_id)
);
create index notice_log_recent on notice_log (tenant_id, created_at desc);

alter table notice_channels enable row level security;
alter table notice_templates enable row level security;
alter table notice_rules enable row level security;
alter table notice_log enable row level security;
create policy t_nch on notice_channels for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_ntp on notice_templates for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_nru on notice_rules for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_nlg on notice_log for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_nch on notice_channels as restrictive for all using (app_subscriber() is null);
create policy portal_ntp on notice_templates as restrictive for all using (app_subscriber() is null);
create policy portal_nru on notice_rules as restrictive for all using (app_subscriber() is null);
create policy portal_nlg on notice_log as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on notice_channels, notice_templates, notice_rules to nexo_app;
grant select, insert, update on notice_log to nexo_app;
grant usage on all sequences in schema public to nexo_app;
-- +goose StatementEnd
