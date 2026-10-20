-- +goose Up
-- +goose StatementBegin
-- Catálogo de referência do provedor: modelos de ONU e templates de
-- provisionamento (telas FTTx - ONU Tipo e FTTx - ONU Template do v0).
-- É documentação técnica: nada aqui é enviado à OLT nem altera ONUs.
create table onu_models (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null check (char_length(code) between 1 and 80),
  vendor text not null check (char_length(vendor) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  ports text not null default '' check (char_length(ports) <= 120),
  wifi text not null default '' check (char_length(wifi) <= 120),
  mode text not null check (mode in ('Bridge', 'Router')),
  profile text not null default '' check (char_length(profile) <= 120),
  compatible_olts text[] not null default '{}' check (cardinality(compatible_olts) <= 30),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
create table onu_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (char_length(name) between 2 and 120),
  vendor text not null check (char_length(vendor) between 1 and 80),
  mode text not null check (mode in ('Bridge', 'Router')),
  compatible_olts text[] not null default '{}' check (cardinality(compatible_olts) <= 30),
  gpon text not null default '' check (char_length(gpon) <= 20000),
  wan text not null default '' check (char_length(wan) <= 20000),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table onu_template_models (
  tenant_id uuid not null references tenants(id),
  template_id uuid not null,
  model_id uuid not null,
  primary key (template_id, model_id),
  foreign key (tenant_id, template_id) references onu_templates (tenant_id, id) on delete cascade,
  foreign key (tenant_id, model_id) references onu_models (tenant_id, id)
);
alter table onu_models enable row level security;
alter table onu_templates enable row level security;
alter table onu_template_models enable row level security;
create policy t_onu_models on onu_models for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_onu_templates on onu_templates for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy t_onu_template_models on onu_template_models for all using (tenant_id = app_tenant()) with check (tenant_id = app_tenant());
create policy portal_onu_models on onu_models as restrictive for all using (app_subscriber() is null);
create policy portal_onu_templates on onu_templates as restrictive for all using (app_subscriber() is null);
create policy portal_onu_template_models on onu_template_models as restrictive for all using (app_subscriber() is null);
grant select, insert, update, delete on onu_models, onu_templates, onu_template_models to nexo_app;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
drop table onu_template_models;
drop table onu_templates;
drop table onu_models;
-- +goose StatementEnd
